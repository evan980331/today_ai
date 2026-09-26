// P3-4 Test Runner service: predefined, safe test execution only.
//
// Layers:
//   tool (test_runner)
//     -> testRunnerService.run()
//     -> WorkspaceService (owner/session scoped, derived rootPath)
//     -> commandService.execute()
//     -> commandPolicy
//     -> process
//
// Rules:
// - No free-form command: the executable+args are DERIVED from workspace
//   markers (package.json scripts.test, pytest markers, tests/ dir).
//   Caller input is limited to { workspaceId, sessionId, timeoutMs }.
//   No rootPath/cwd/env/command/argv input is accepted.
// - No spawn/exec/execFile/shell here: all execution goes through the
//   injected commandService (defaults to require('./commandService')).
// - No second process-killing path: timeout/AbortSignal pass straight
//   through to commandService. ABORTED is rethrown, never swallowed.
// - Result is agent-friendly and leak-free: no env, no absolute paths.
const fs = require('fs/promises');
const path = require('path');
const { WorkspaceService } = require('./workspaceService');

const DEFAULT_TIMEOUT_MS = 120000;

const NO_TEST = 'NO_TEST_COMMAND';

function runnerError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function checkAborted(signal) {
    if (signal && signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

async function exists(p) {
    try {
        await fs.stat(p);
        return true;
    } catch {
        return false;
    }
}

async function readJson(file) {
    try {
        const text = await fs.readFile(file, 'utf8');
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// Decide the single predefined command for a workspace root.
// Returns { executable, args, kind } or null when nothing safe matches.
// v1: Node scripts.test only (no arbitrary script selection); Python
// pytest markers first, then tests/ unittest fallback.
async function detectCommand(rootReal) {
    const pkg = await readJson(path.join(rootReal, 'package.json'));
    if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) {
        const scripts = pkg.scripts;
        if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
            const t = scripts.test;
            if (typeof t === 'string' && t.trim()) {
                return { executable: 'npm', args: ['test'], kind: 'node:npm-test' };
            }
        }
    }
    const pytestMarkers = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'];
    for (const m of pytestMarkers) {
        const p = path.join(rootReal, m);
        if (await exists(p)) {
            if (m === 'pyproject.toml' || m === 'setup.cfg') {
                try {
                    const text = await fs.readFile(p, 'utf8');
                    if (!/pytest/i.test(text)) continue;
                } catch {
                    continue;
                }
            }
            return { executable: 'python', args: ['-m', 'pytest'], kind: 'python:pytest' };
        }
    }
    // tests/ or test/ layout: pytest-style files prefer pytest, else unittest.
    for (const dir of ['tests', 'test']) {
        const d = path.join(rootReal, dir);
        let entries = null;
        try {
            entries = await fs.readdir(d);
        } catch {
            continue;
        }
        if (!entries || entries.length === 0) continue;
        const hasPytestStyle = entries.some((n) => /^test_.*\.py$/.test(n) || /^.*_test\.py$/.test(n));
        if (hasPytestStyle) {
            return { executable: 'python', args: ['-m', 'pytest'], kind: 'python:pytest' };
        }
        if (dir === 'tests') {
            return { executable: 'python', args: ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], kind: 'python:unittest' };
        }
    }
    // Root-level pytest files (test_*.py) without a tests/ dir.
    try {
        const rootEntries = await fs.readdir(rootReal);
        if (rootEntries.some((n) => /^test_.*\.py$/.test(n) || /^.*_test\.py$/.test(n))) {
            return { executable: 'python', args: ['-m', 'pytest'], kind: 'python:pytest' };
        }
    } catch {
        // unreadable root -> treated as unsupported below
    }
    return null;
}

async function run({ workspaceId = null, sessionId = null, owner = null, timeoutMs = null, signal = null, workspaceService = null, commandService = null } = {}) {
    checkAborted(signal);
    if (!owner || typeof owner !== 'string' || !owner.trim()) {
        throw runnerError(400, 'TOOL_INVALID_INPUT', 'authenticated owner is required');
    }
    if (timeoutMs !== undefined && timeoutMs !== null) {
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
            throw runnerError(400, 'TOOL_INVALID_INPUT', 'timeoutMs must be a number');
        }
    }
    const svc = workspaceService || WorkspaceService.default();
    let ws = null;
    if (workspaceId !== undefined && workspaceId !== null) {
        if (typeof workspaceId !== 'string' || !workspaceId) {
            throw runnerError(400, 'TOOL_INVALID_INPUT', 'workspaceId must be a non-empty string');
        }
        ws = await svc.getById(workspaceId, owner);
    } else if (sessionId !== undefined && sessionId !== null) {
        if (typeof sessionId !== 'string' || !sessionId) {
            throw runnerError(400, 'TOOL_INVALID_INPUT', 'sessionId must be a non-empty string');
        }
        ws = await svc.getCurrent(sessionId, owner);
    } else {
        throw runnerError(400, 'TOOL_INVALID_INPUT', 'workspaceId or sessionId is required');
    }
    checkAborted(signal);
    let rootReal;
    try {
        rootReal = await fs.realpath(ws.rootPath);
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        throw runnerError(400, 'TOOL_INVALID_INPUT', 'workspace directory is missing');
    }
    const spec = await detectCommand(rootReal);
    checkAborted(signal);
    if (!spec) {
        return {
            ok: false,
            code: NO_TEST,
            workspaceId: ws.workspaceId,
            command: null,
            exitCode: null,
            stdout: '',
            stderr: '',
            timedOut: false,
            durationMs: 0,
            truncated: false
        };
    }
    const cmd = commandService || require('./commandService');
    // Pass timeout straight through; commandService clamps to its MAX and
    // owns all process-tree killing. Default 120s here (clamped to 120s max).
    const effectiveTimeout = timeoutMs === undefined || timeoutMs === null ? DEFAULT_TIMEOUT_MS : timeoutMs;
    let out;
    try {
        out = await cmd.execute({
            workspaceId: ws.workspaceId,
            owner,
            executable: spec.executable,
            args: spec.args,
            cwd: null,
            timeoutMs: effectiveTimeout,
            signal: signal || null
        });
    } catch (e) {
        if (e && e.code === 'ABORTED') throw e;
        if (e && e.code === 'TIMEOUT') {
            return {
                ok: false,
                code: 'TIMEOUT',
                workspaceId: ws.workspaceId,
                command: { executable: spec.executable, args: spec.args.slice() },
                exitCode: null,
                stdout: '',
                stderr: '',
                timedOut: true,
                durationMs: 0,
                truncated: false
            };
        }
        throw e;
    }
    checkAborted(signal);
    return {
        ok: out.ok === true,
        code: out.ok === true ? 'TEST_PASS' : 'TEST_FAILED',
        workspaceId: ws.workspaceId,
        command: { executable: spec.executable, args: spec.args.slice() },
        exitCode: out.exitCode,
        stdout: typeof out.stdout === 'string' ? out.stdout : '',
        stderr: typeof out.stderr === 'string' ? out.stderr : '',
        timedOut: out.timedOut === true,
        durationMs: typeof out.durationMs === 'number' ? out.durationMs : 0,
        truncated: out.stdoutTruncated === true || out.stderrTruncated === true
    };
}

module.exports = { run, detectCommand, DEFAULT_TIMEOUT_MS, NO_TEST_COMMAND: NO_TEST };
