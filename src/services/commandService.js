// P3-3 command execution service: run allowlisted executables inside a
// workspace directory with strict policy, timeout, output caps and a
// scrubbed environment.
//
// Layers (all enforced before any process exists, in order):
//   1. WorkspaceService.getById/getCurrent (owner + session scoped) —
//      never trusts caller-supplied owner or rootPath.
//   2. commandPolicy executable allowlist + argv validation (no shell
//      metacharacters, no env syntax, no traversal, no UNC).
//   3. cwd resolved inside the workspace root (relative-containment +
//      realpath, same rules as the filesystem sandbox).
//   4. Path-like argv entries resolved inside the same root.
//   5. Child env = process env MINUS secret-shaped keys; never returned.
//   6. Timeout kills the whole process tree (taskkill /T /F on Windows,
//      SIGKILL fallback); AbortSignal terminates identically (ABORTED).
//
// Result: { ok, exitCode, signal, timedOut, stdout, stderr,
//           stdoutTruncated, stderrTruncated, durationMs }.
// stdout/stderr capped at 64KB each; non-zero exit is ok:false, not a throw
// (callers decide); timeouts/aborts throw TIMEOUT/ABORTED like the rest of
// the agent stack.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const { WorkspaceService } = require('./workspaceService');
const policy = require('./commandPolicy');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function cmdError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function checkAborted(signal) {
    if (signal && signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

// Keys that must never reach a child process. Explicit names first, then
// shape patterns. The child keeps everything else (PATH, SystemRoot...).
const SECRET_ENV_EXACT = new Set([
    'DATABASE_URL', 'AUTH_PASSWORD', 'WORKER_SHARED_SECRET',
    'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_CLIENT_SECRET', 'GOOGLE_CALENDAR_REFRESH_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN',
    'OPENCODE_SERVER_PASSWORD', 'GOOGLE_OAUTH_CREDENTIALS', 'GMAIL_OAUTH_PATH'
]);
const SECRET_ENV_RE = /(_TOKEN$|_SECRET$|_PASSWORD$|PRIVATE_KEY|API_KEY|AUTH_TOKEN)/i;

function scrubbedEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v !== 'string') continue;
        if (SECRET_ENV_EXACT.has(k)) continue;
        if (SECRET_ENV_RE.test(k)) continue;
        env[k] = v;
    }
    return env;
}

function resolveTimeout(timeoutMs) {
    if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'timeoutMs must be a number');
    }
    // Zero/negative can never mean infinite: clamp into the allowed window.
    if (timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

// Best-effort whole-tree termination. Mirrors the agentWorker approach:
// taskkill /PID /T /F on Windows, SIGKILL fallback. Never throws.
function killTree(proc) {
    return new Promise((resolve) => {
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
        const pid = proc.pid;
        const finish = () => {
            try {
                proc.kill('SIGKILL');
            } catch { /* already gone */ }
            resolve(true);
        };
        if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
            let killer = null;
            try {
                killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } catch {
                return void finish();
            }
            killer.once('error', finish);
            killer.once('close', finish);
            setTimeout(finish, 3000).unref?.();
            return;
        }
        finish();
    });
}

async function resolveCwd(rootReal, cwd) {
    const text = cwd === undefined || cwd === null || cwd === '' ? '.' : cwd;
    if (typeof text !== 'string' || text.includes('\0')) {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'cwd must be a workspace-relative path');
    }
    if (/%(2e|2f|5c|00)/i.test(text)) {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'cwd traversal is not allowed');
    }
    const candidate = path.resolve(rootReal, text);
    const rel = path.relative(rootReal, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'cwd escapes the workspace');
    }
    let real;
    try {
        real = await fs.realpath(candidate);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            throw cmdError(400, 'TOOL_INVALID_INPUT', 'cwd does not exist in the workspace');
        }
        throw e && e.code === 'ABORTED' ? e : cmdError(400, 'TOOL_INVALID_INPUT', 'cwd cannot be resolved');
    }
    const rel2 = path.relative(rootReal, real);
    if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'cwd escapes the workspace');
    }
    return real;
}

async function execute({ workspaceId = null, sessionId = null, owner = null, executable, args = [], cwd = null, timeoutMs = null, env = undefined, signal = null, workspaceService = null } = {}) {
    checkAborted(signal);
    if (!owner || typeof owner !== 'string') {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'authenticated owner is required');
    }
    if (env !== undefined) {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'custom environment injection is not allowed');
    }
    // 1. Workspace resolution (owner-scoped; rootPath derived, never caller input).
    const svc = workspaceService || WorkspaceService.default();
    let ws = null;
    if (workspaceId !== undefined && workspaceId !== null) {
        if (typeof workspaceId !== 'string' || !workspaceId) {
            throw cmdError(400, 'TOOL_INVALID_INPUT', 'workspaceId must be a non-empty string');
        }
        ws = await svc.getById(workspaceId, owner);
    } else if (sessionId !== undefined && sessionId !== null) {
        if (typeof sessionId !== 'string' || !sessionId) {
            throw cmdError(400, 'TOOL_INVALID_INPUT', 'sessionId must be a non-empty string');
        }
        ws = await svc.getCurrent(sessionId, owner);
    } else {
        throw cmdError(400, 'TOOL_INVALID_INPUT', 'workspaceId or sessionId is required');
    }
    let rootReal;
    try {
        rootReal = await fs.realpath(ws.rootPath);
    } catch (e) {
        if (e && e.code === 'ENOENT') throw cmdError(400, 'TOOL_INVALID_INPUT', 'workspace directory is missing');
        throw e;
    }
    // 2-3. Policy + cwd.
    const spec = policy.validateExecutable(executable);
    const argv = policy.validateArgs(args);
    checkAborted(signal);
    const cwdReal = await resolveCwd(rootReal, cwd === undefined ? null : cwd);
    // 4. Path-like args contained in the SAME execution root.
    const { paths } = policy.classifyArgs(argv);
    for (const p of paths) {
        policy.resolveArgPath(cwdReal, p.value, p.index);
    }
    checkAborted(signal);
    const limit = resolveTimeout(timeoutMs);
    const startedAt = Date.now();

    // 5. Spawn: direct for real exes; controlled cmd launcher for .cmd shims.
    let file;
    let spawnArgs;
    if (spec.viaCmd) {
        file = process.env.ComSpec || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', `"${spec.canonical}"`, ...argv.map(policy.quoteForCmd)];
    } else {
        file = spec.canonical;
        spawnArgs = argv;
    }
    return await new Promise((resolve, reject) => {
        let proc = null;
        let timedOut = false;
        let aborted = false;
        const timeoutErr = () => Object.assign(new Error(`command timed out after ${limit}ms`), { code: 'TIMEOUT' });
        const abortErr = () => Object.assign(new Error('aborted'), { code: 'ABORTED' });
        try {
            proc = spawn(file, spawnArgs, {
                cwd: cwdReal,
                env: scrubbedEnv(),
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (e) {
            reject(cmdError(400, 'TOOL_INVALID_INPUT', 'command could not be started'));
            return;
        }
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let settled = false;
        const finish = (val, isErr) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) {
                try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ }
            }
            if (isErr) reject(val);
            else resolve(val);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(proc).then(() => {
                finish(timeoutErr(), true);
            });
        }, limit);
        if (timer.unref) timer.unref();
        const onAbort = () => {
            aborted = true;
            killTree(proc).then(() => {
                finish(abortErr(), true);
            });
        };
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                aborted = true;
                finish(abortErr(), true);
                try { proc.kill('SIGKILL'); } catch { /* noop */ }
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        const push = (store, chunk) => {
            if (store.buf.length >= MAX_OUTPUT_BYTES) {
                store.cut = true;
                return;
            }
            const room = MAX_OUTPUT_BYTES - store.buf.length;
            if (chunk.length > room) {
                store.buf = Buffer.concat([store.buf, chunk.subarray(0, room)]);
                store.cut = true;
            } else {
                store.buf = Buffer.concat([store.buf, chunk]);
            }
        };
        const out = { buf: Buffer.alloc(0), cut: false };
        const err = { buf: Buffer.alloc(0), cut: false };
        if (proc.stdout) proc.stdout.on('data', (c) => push(out, c));
        if (proc.stderr) proc.stderr.on('data', (c) => push(err, c));
        proc.once('error', () => {
            finish(cmdError(400, 'TOOL_INVALID_INPUT', 'command could not be started'), true);
        });
        proc.once('close', (code, sig) => {
            // Timeout/abort always win over a racing close event: the
            // process was killed by us, so a normal-looking exit must
            // never mask TIMEOUT/ABORTED.
            if (timedOut) {
                finish(timeoutErr(), true);
                return;
            }
            if (aborted) {
                finish(abortErr(), true);
                return;
            }
            finish({
                ok: code === 0,
                exitCode: code,
                signal: sig || null,
                timedOut: false,
                stdout: out.buf.toString('utf8'),
                stderr: err.buf.toString('utf8'),
                stdoutTruncated: out.cut,
                stderrTruncated: err.cut,
                durationMs: Date.now() - startedAt
            }, false);
        });
    });
}

module.exports = {
    execute,
    scrubbedEnv,
    resolveTimeout,
    killTree,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    MAX_OUTPUT_BYTES
};
