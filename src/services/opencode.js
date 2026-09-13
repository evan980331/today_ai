require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || '';
const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS) || 60000;

function getOpencodeCmd() {
    return 'opencode';
}

function isServerUrlConfigured() {
    const url = process.env.OPENCODE_SERVER_URL || '';
    return !!url && /^https?:\/\//.test(url);
}

// ---- P0-1: OpenCode Runtime abstraction ----
// Modes:
//   mock          - MOCK_OPENCODE=true (dev/test only, never production)
//   local-cli     - spawn `opencode` binary on this host (dev/local)
//   remote-server - attach to an external OpenCode Server (production target)
//   unavailable   - production with no usable runtime (explicit failure, no fake success)
function getRuntimeMode() {
    const isProd = process.env.NODE_ENV === 'production';
    if (process.env.MOCK_OPENCODE === 'true') {
        return isProd ? 'unavailable' : 'mock';
    }
    if (isServerUrlConfigured()) {
        return 'remote-server';
    }
    return isProd ? 'unavailable' : 'local-cli';
}

function getRuntimeDetail() {
    const mode = getRuntimeMode();
    const detail = { mode, mockForbidden: false, reason: null };
    if (mode === 'mock') {
        detail.reason = 'MOCK_OPENCODE=true (dev/test only)';
    } else if (mode === 'local-cli') {
        detail.reason = 'local `opencode` binary via spawn';
    } else if (mode === 'remote-server') {
        detail.reason = `external OpenCode Server at ${process.env.OPENCODE_SERVER_URL}`;
    } else {
        if (process.env.MOCK_OPENCODE === 'true') {
            detail.mockForbidden = true;
            detail.reason = 'MOCK_OPENCODE=true is forbidden in production';
        } else {
            detail.reason = 'no OPENCODE_SERVER_URL configured and no local binary in production';
        }
    }
    return detail;
}

function runtimeUnavailableError(reason) {
    const err = new Error(reason || 'OpenCode runtime unavailable');
    err.code = 'RUNTIME_UNAVAILABLE';
    return err;
}

// Throws RUNTIME_UNAVAILABLE when current mode cannot execute.
// Call before any spawn/attach attempt so production fails explicitly.
function assertRuntimeAvailable() {
    const detail = getRuntimeDetail();
    if (detail.mode === 'unavailable') {
        throw runtimeUnavailableError(
            detail.mockForbidden
                ? 'OpenCode runtime unavailable: MOCK_OPENCODE=true is forbidden in production'
                : 'OpenCode runtime unavailable: configure OPENCODE_SERVER_URL to an external OpenCode Server'
        );
    }
    return detail;
}

async function isServerReachable() {
    if (!isServerUrlConfigured()) return false;
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(OPENCODE_SERVER_URL, { signal: controller.signal }).catch(() => null);
        clearTimeout(t);
        return res !== null;
    } catch {
        return false;
    }
}

function parseMcpTools(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const tools = new Set();
    const lines = raw.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'tool_use' && obj.part && obj.part.tool) {
                tools.add(obj.part.tool);
            } else if (obj.part && obj.part.tool) {
                tools.add(obj.part.tool);
            }
        } catch {}
    }
    const re = /\b(github_\w+|gmail_\w+|google[_-]calendar\w*|calendar_\w+|webfetch)\b/gi;
    let m;
    while ((m = re.exec(raw)) !== null) {
        tools.add(m[1].toLowerCase());
    }
    return Array.from(tools);
}

async function run(prompt, opts = {}) {
    const isProd = process.env.NODE_ENV === 'production';
    if (process.env.MOCK_OPENCODE === 'true') {
        if (isProd) {
            const err = new Error('MOCK_OPENCODE=true is forbidden in production');
            err.code = 'MOCK_FORBIDDEN';
            throw err;
        }
        console.log(`[OpenCode Mock] ${prompt.slice(0,60)}`);
        await new Promise(r => setTimeout(r, 300));
        const lower = prompt.toLowerCase();
        const mockTools = [];
        if (lower.includes('github') || lower.includes('repo')) mockTools.push('github_get_file_contents');
        if (lower.includes('calendar') || lower.includes('行程')) mockTools.push('google-calendar_list_events');
        if (lower.includes('gmail') || lower.includes('信件') || lower.includes('mail')) mockTools.push('gmail_search');
        return { result: `Hello (mock for: ${prompt.slice(0,100)})`, mcpTools: mockTools, raw: '' };
    }
    // Production must fail explicitly instead of pretending to work.
    assertRuntimeAvailable();
    const timeoutMs = opts.timeoutMs || MCP_TIMEOUT_MS;
    const serverConfigured = isServerUrlConfigured();
    const reachable = serverConfigured && await isServerReachable();
    if (isProd && serverConfigured && !reachable) {
        throw runtimeUnavailableError(
            `OpenCode Server unreachable at ${process.env.OPENCODE_SERVER_URL}`
        );
    }
    const useAttach = opts.useAttach !== false && reachable;

    const args = ['run'];
    if (useAttach) {
        args.push('--attach', OPENCODE_SERVER_URL);
    }
    args.push('--auto', prompt);

    const isWin = process.platform === 'win32';
    const execCwd = opts.cwd || PROJECT_ROOT;
    const logArgs = args.map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' ');
    console.log(`[OpenCode] opencode ${logArgs} (cwd=${execCwd}, win=${isWin}, attach=${useAttach})`);

    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;
        let debounce = null;

        const child = spawnOpencode(args, execCwd);

        const cleanup = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (debounce) { clearTimeout(debounce); debounce = null; }
        };

        const tryResolve = () => {
            if (settled) return;
            const outTrim = stdout.trim();
            const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
            const cleanOut = stripAnsi(outTrim).replace(/^>.*$/gm, '').trim();
            if (cleanOut) {
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    try { child.kill(); } catch {}
                    const raw = stdout + '\n' + stderr;
                    resolve({ result: cleanOut, mcpTools: parseMcpTools(raw), raw });
                }, 800);
            }
        };

        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
            const outTrim = stdout.trim();
            const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
            const cleanOut = stripAnsi(outTrim).replace(/^>.*$/gm, '').trim();
            const raw = stdout + '\n' + stderr;
            if (cleanOut) {
                resolve({ result: cleanOut, mcpTools: parseMcpTools(raw), raw });
                return;
            }
            const err = new Error(`OpenCode timeout after ${timeoutMs}ms`);
            err.code = 'TIMEOUT';
            err.stdout = stdout;
            err.stderr = stderr;
            err.mcpTools = parseMcpTools(raw);
            reject(err);
        }, timeoutMs);

        child.stdout.on('data', d => {
            stdout += d.toString();
            tryResolve();
        });
        child.stderr.on('data', d => {
            stderr += d.toString();
        });

        child.on('error', err => {
            if (settled) return;
            settled = true;
            cleanup();
            err.stdout = stdout;
            err.stderr = stderr;
            err.mcpTools = parseMcpTools(stdout + '\n' + stderr);
            reject(err);
        });

        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            cleanup();
            const outTrim = stdout.trim();
            const errTrim = stderr.trim();
            const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
            const cleanOut = stripAnsi(outTrim).replace(/^>.*$/gm, '').trim();
            const cleanErr = stripAnsi(errTrim).replace(/^>.*$/gm, '').trim();
            const raw = stdout + '\n' + stderr;
            const mcpTools = parseMcpTools(raw);
            if (cleanOut) {
                resolve({ result: cleanOut, mcpTools, raw });
                return;
            }
            if (code !== 0) {
                const err = new Error(cleanErr || `opencode exit code ${code}${signal ? ` signal ${signal}` : ''}`);
                err.code = 'EXIT';
                err.stdout = stdout;
                err.stderr = stderr;
                err.mcpTools = mcpTools;
                err.exitCode = code;
                reject(err);
                return;
            }
            resolve({ result: cleanErr || '', mcpTools, raw });
        });
    });
}

// ---- P0-4/P0-5: structured streaming via `opencode run --format json` ----
// Emits one parsed JSON event object per stdout line ({type, timestamp,
// sessionID, part}) via onEvent. This is the CLI's real structured event
// stream (verified against opencode 1.18.30: step_start/text/tool_use/
// step_finish), NOT TUI stdout chunking. Resolves with the full result so
// callers can persist history exactly once. Rejects on timeout/exit/abort.
function buildArgs(prompt, { formatJson = false, useAttach = false, serverUrl = '' } = {}) {
    const args = ['run'];
    if (useAttach && serverUrl) {
        args.push('--attach', serverUrl);
    }
    if (formatJson) {
        args.push('--format', 'json');
    }
    args.push('--auto', prompt);
    return args;
}

// P0-3: executions run in opts.cwd (a workspace path) instead of
// PROJECT_ROOT. Callers resolve the directory via workspace service;
// the agent never runs in the Today AI repository root.
function spawnOpencode(args, cwd) {
    const dir = cwd || PROJECT_ROOT;
    const isWin = process.platform === 'win32';
    if (isWin) {
        return spawn('powershell.exe', ['-NoProfile', '-Command', `opencode ${args.map(a => a.includes(' ') ? `"${a.replace(/"/g, '""')}"` : a).join(' ')}`], {
            cwd: dir,
            env: process.env,
            windowsHide: true
        });
    }
    return spawn('opencode', args, {
        cwd: dir,
        env: process.env
    });
}

async function runStream(prompt, opts = {}) {
    const { onEvent, signal, timeoutMs: timeoutOpt } = opts;
    const isProd = process.env.NODE_ENV === 'production';
    if (process.env.MOCK_OPENCODE === 'true') {
        if (isProd) {
            const err = new Error('MOCK_OPENCODE=true is forbidden in production');
            err.code = 'MOCK_FORBIDDEN';
            throw err;
        }
        // Dev/test mock: emit one synthetic text event, then resolve.
        // Never used in production (guarded above + validateEnv exit).
        const parts = [`Hello (mock for: ${prompt.slice(0, 100)})`];
        if (typeof onEvent === 'function') {
            onEvent({ type: 'step_start', timestamp: Date.now(), sessionID: 'mock', part: { type: 'step-start' } });
            onEvent({ type: 'text', timestamp: Date.now(), sessionID: 'mock', part: { type: 'text', text: parts[0] } });
            onEvent({ type: 'step_finish', timestamp: Date.now(), sessionID: 'mock', part: { type: 'step-finish', reason: 'stop' } });
        }
        return { result: parts[0], mcpTools: [], raw: '', textParts: parts };
    }
    assertRuntimeAvailable();
    const timeoutMs = timeoutOpt || MCP_TIMEOUT_MS;
    const serverUrl = process.env.OPENCODE_SERVER_URL || '';
    const serverConfigured = isServerUrlConfigured();
    const reachable = serverConfigured && await isServerReachable();
    if (isProd && serverConfigured && !reachable) {
        throw runtimeUnavailableError(`OpenCode Server unreachable at ${serverUrl}`);
    }
    const useAttach = opts.useAttach !== false && reachable;
    const args = buildArgs(prompt, { formatJson: true, useAttach, serverUrl });

    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let lineBuf = '';
        let settled = false;
        let timer = null;
        const textParts = [];
        const toolNames = new Set();

        const child = spawnOpencode(args, opts.cwd || null);

        const cleanup = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        const finishResolve = () => {
            if (settled) return;
            settled = true;
            cleanup();
            try { child.kill(); } catch {}
            const raw = stdout + '\n' + stderr;
            const result = textParts.join('');
            resolve({ result, mcpTools: Array.from(toolNames), raw, textParts });
        };
        const finishReject = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            try { child.kill('SIGTERM'); } catch {}
            err.stdout = stdout;
            err.stderr = stderr;
            err.mcpTools = Array.from(toolNames);
            reject(err);
        };
        const onAbort = () => {
            const err = new Error('OpenCode stream aborted by client');
            err.code = 'ABORTED';
            finishReject(err);
        };
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }

        const handleLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) return; // skip non-JSON noise, never crash
            let evt;
            try {
                evt = JSON.parse(trimmed);
            } catch {
                return; // malformed chunk: ignore, never crash
            }
            if (!evt || typeof evt.type !== 'string') return;
            if (evt.type === 'text' && evt.part && typeof evt.part.text === 'string') {
                textParts.push(evt.part.text);
            }
            if ((evt.type === 'tool_use' || evt.type === 'tool') && evt.part && evt.part.tool) {
                toolNames.add(String(evt.part.tool).toLowerCase());
            }
            if (typeof onEvent === 'function') {
                try { onEvent(evt); } catch {}
            }
        };

        timer = setTimeout(() => {
            if (textParts.join('')) {
                finishResolve();
                return;
            }
            const err = new Error(`OpenCode timeout after ${timeoutMs}ms`);
            err.code = 'TIMEOUT';
            finishReject(err);
        }, timeoutMs);
        if (timer.unref) timer.unref();

        child.stdout.on('data', d => {
            const chunk = d.toString();
            stdout += chunk;
            lineBuf += chunk;
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop();
            for (const line of lines) handleLine(line);
        });
        child.stderr.on('data', d => {
            stderr += d.toString();
        });
        child.on('error', err => finishReject(err));
        child.on('close', (code) => {
            if (lineBuf.trim()) handleLine(lineBuf);
            if (textParts.join('')) {
                finishResolve();
                return;
            }
            if (code !== 0) {
                const err = new Error(`opencode exit code ${code}`);
                err.code = 'EXIT';
                err.exitCode = code;
                finishReject(err);
                return;
            }
            finishResolve();
        });
    });
}

module.exports = {
    run,
    runStream,
    parseMcpTools,
    isServerUrlConfigured,
    isServerReachable,
    getRuntimeMode,
    getRuntimeDetail,
    assertRuntimeAvailable,
    runtimeUnavailableError,
    MCP_TIMEOUT_MS,
    PROJECT_ROOT
};
