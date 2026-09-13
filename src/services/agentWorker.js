// P0.5: Agent Worker prototype (single-host).
//
// Architecture (NOT shared-server):
//   Today AI -> AgentWorker -> isolated workspace -> dedicated OpenCode Server
//   -> session -> task -> result -> shutdown
//
// Why: verified on opencode 1.18.30 that POST /session ignores the
// `directory` field (always runs in the server cwd), and `serve --port 0`
// is ignored (always binds 4096). Isolation boundary = server process cwd
// + dynamic port + per-worker Basic Auth secret.
//
// Lifecycle: creating -> starting -> ready -> running -> stopping ->
// stopped, plus failed. Session abort and worker shutdown are separate
// lifecycles: aborting a session never kills the worker; shutdown is
// graceful (SIGTERM) with SIGKILL fallback, then workspace cleanup.
//
// Secrets: per-worker random password lives ONLY in process env of the
// child + module memory. Never database, logs, frontend, git, errors.
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { createWorkspace, removeWorkspace, getWorkspacePath } = require('./workspace');
const { OpenCodeClient } = require('./agentClient');

const WORKER_START_TIMEOUT_MS = parseInt(process.env.WORKER_START_TIMEOUT_MS, 10) || 30000;
const AGENT_EXECUTION_TIMEOUT_MS = parseInt(process.env.AGENT_EXECUTION_TIMEOUT_MS, 10) || 600000;
const WORKER_USERNAME = 'worker';

// P0.7-10: resource-limit contract. MAX_WORKERS is ENFORCED below.
// MAX_WORKSPACE_SIZE_MB is config-only for now (honest: NOT enforced —
// measuring on every write is future work, see getWorkerLimits()).
function getWorkerLimits() {
    const maxWorkersRaw = parseInt(process.env.MAX_WORKERS, 10);
    const maxWorkspaceMbRaw = parseInt(process.env.MAX_WORKSPACE_SIZE_MB, 10);
    return {
        maxWorkers: Number.isFinite(maxWorkersRaw) && maxWorkersRaw > 0 ? maxWorkersRaw : null,
        maxWorkspaceSizeMb: Number.isFinite(maxWorkspaceMbRaw) && maxWorkspaceMbRaw > 0 ? maxWorkspaceMbRaw : null,
        enforced: { maxWorkers: true, maxWorkspaceSizeMb: false }
    };
}

const STATUSES = ['creating', 'starting', 'ready', 'running', 'stopping', 'stopped', 'failed'];

const workers = new Map(); // workerId -> record (same-process registry)

function workerError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

// OS-allocated free port (bind 0 -> read -> close). Residual TOCTOU
// (something else binding between close and serve) is accepted for the
// single-host prototype; production worker-per-host binds sequentially.
function allocatePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

function randomPassword() {
    return crypto.randomBytes(24).toString('hex'); // 48 chars, memory only
}

function opencodeBinary() {
    return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

// spawnFn(args, opts) is injectable for deterministic unit tests.
// Default mirrors opencode.js platform handling: on Windows only the npm
// shims (opencode.cmd/.ps1) sit on PATH, so bare `opencode.exe` fails with
// ENOENT and the proven `powershell -Command opencode ...` form is used.
function defaultSpawn(args, opts) {
    if (process.platform === 'win32') {
        const quoted = args.map((a) => (a.includes(' ') ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
        return require('child_process').spawn('powershell.exe', ['-NoProfile', '-Command', `opencode ${quoted}`], {
            ...opts,
            windowsHide: true
        });
    }
    return require('child_process').spawn(opencodeBinary(), args, opts);
}

function newWorkerRecord({ workspaceId, workspacePath, port, username, password }) {
    const now = Date.now();
    return {
        workerId: `wrk_${crypto.randomBytes(8).toString('hex')}`,
        workspaceId,
        workspacePath,
        port,
        serverUrl: `http://127.0.0.1:${port}`,
        username,
        password,
        process: null,
        status: 'creating',
        createdAt: now,
        startedAt: null,
        stoppedAt: null,
        lastError: null
    };
}

function setStatus(worker, status, err) {
    worker.status = status;
    if (err && !worker.lastError) {
        worker.lastError = String((err && err.message) || err).slice(0, 300);
    }
    if (status === 'failed' || status === 'stopped') {
        worker.stoppedAt = Date.now();
    }
}

function killProcess(proc, { gracefulMs = 5000 } = {}) {
    return new Promise((resolve) => {
        if (!proc || proc.exitCode !== null) return resolve({ alreadyGone: true, forced: false });
        let done = false;
        let escalated = false;
        const finish = (forced) => {
            if (done) return;
            done = true;
            resolve({ alreadyGone: false, forced });
        };
        const timer = setTimeout(() => {
            escalated = true;
            try { proc.kill('SIGKILL'); } catch {}
            // Give the OS a beat, then resolve regardless: never hang.
            const fallback = setTimeout(() => finish(true), 1000);
            if (fallback.unref) fallback.unref();
        }, gracefulMs);
        if (timer.unref) timer.unref();
        try {
            // Exit after escalation still counts as forced.
            proc.once('exit', () => { clearTimeout(timer); finish(escalated); });
            proc.kill('SIGTERM');
        } catch {
            clearTimeout(timer);
            finish(false);
        }
    });
}

async function waitForReady(worker, client, timeoutMs) {
    const start = Date.now();
    for (;;) {
        if (worker.process && worker.process.exitCode !== null) {
            throw workerError('WORKER_EXITED', `OpenCode Server exited during startup (code ${worker.process.exitCode})`);
        }
        const h = await client.health().catch(() => ({ available: false }));
        if (h.available) return h;
        if (Date.now() - start > timeoutMs) {
            throw workerError('WORKER_START_TIMEOUT', `OpenCode Server not ready within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}

// createWorker({ workspaceId? }) -> creates workspace + record (no process).
async function createWorker({ workspaceId = null } = {}) {
    const { maxWorkers } = getWorkerLimits();
    if (maxWorkers !== null && workers.size >= maxWorkers) {
        throw workerError('WORKER_LIMIT', `worker limit reached (${maxWorkers})`);
    }
    const id = workspaceId || `ws_${crypto.randomBytes(8).toString('hex')}`;
    const workspacePath = await createWorkspace(id);
    const port = await allocatePort();
    const worker = newWorkerRecord({
        workspaceId: id,
        workspacePath,
        port,
        username: WORKER_USERNAME,
        password: randomPassword()
    });
    workers.set(worker.workerId, worker);
    return publicView(worker);
}

// startWorker(workerId, { timeoutMs, spawnFn }) -> spawns `opencode serve`
// with cwd = workspace path, waits for health. Returns public view.
async function startWorker(workerId, { timeoutMs = WORKER_START_TIMEOUT_MS, spawnFn = null } = {}) {
    const worker = workers.get(workerId);
    if (!worker) throw workerError('WORKER_NOT_FOUND', `unknown worker: ${workerId}`);
    if (worker.status !== 'creating') {
        throw workerError('WORKER_BAD_STATE', `cannot start worker in status ${worker.status}`);
    }
    setStatus(worker, 'starting');
    const spawn = spawnFn || defaultSpawn;
    let proc;
    try {
        proc = spawn(['serve', '--hostname', '127.0.0.1', '--port', String(worker.port)], {
            cwd: worker.workspacePath,
            env: { ...process.env, OPENCODE_SERVER_PASSWORD: worker.password },
            windowsHide: true
        });
    } catch (e) {
        setStatus(worker, 'failed', e);
        throw workerError('WORKER_SPAWN_FAILED', `failed to spawn OpenCode Server: ${e.message}`);
    }
    worker.process = proc;
    worker.startedAt = Date.now();
    proc.once('exit', (code) => {
        if (worker.status === 'starting' || worker.status === 'ready' || worker.status === 'running') {
            setStatus(worker, 'failed', new Error(`OpenCode Server exited unexpectedly (code ${code})`));
        }
    });
    proc.once('error', (e) => {
        if (worker.status === 'starting') {
            setStatus(worker, 'failed', e);
        }
    });
    const client = workerClient(worker);
    try {
        await waitForReady(worker, client, timeoutMs);
    } catch (e) {
        setStatus(worker, 'failed', e);
        await killProcess(proc).catch(() => {});
        throw e;
    }
    if (worker.status !== 'starting') {
        // Exited while waiting (exit handler already marked failed).
        await killProcess(proc).catch(() => {});
        throw workerError('WORKER_EXITED', 'OpenCode Server exited before ready');
    }
    setStatus(worker, 'ready');
    return publicView(worker);
}

// healthWorker(workerId) -> OpenCodeClient health for that worker.
async function healthWorker(workerId, opts = {}) {
    const worker = workers.get(workerId);
    if (!worker) throw workerError('WORKER_NOT_FOUND', `unknown worker: ${workerId}`);
    if (!worker.process || worker.process.exitCode !== null) {
        return { available: false, workerId, status: worker.status, reason: 'process not running' };
    }
    const h = await workerClient(worker).health(opts).catch((e) => ({ available: false, reason: e.message }));
    return { ...h, workerId, status: worker.status };
}

// stopWorker(workerId, { cleanup }) -> graceful SIGTERM, SIGKILL fallback,
// then unregister. Sessions must already be aborted/completed by the caller:
// stop never assumes it is safe to kill mid-write, it only guarantees the
// process is gone afterwards (no zombies).
async function stopWorker(workerId, { cleanup = false, gracefulMs = 5000 } = {}) {
    const worker = workers.get(workerId);
    if (!worker) throw workerError('WORKER_NOT_FOUND', `unknown worker: ${workerId}`);
    if (worker.status === 'stopped') return publicView(worker);
    setStatus(worker, 'stopping');
    const res = await killProcess(worker.process, { gracefulMs }).catch(() => ({ forced: true }));
    setStatus(worker, 'stopped');
    worker.process = null;
    // Scrub secret from memory on shutdown.
    worker.password = null;
    workers.delete(workerId);
    if (cleanup) {
        await removeWorkspace(worker.workspaceId).catch(() => {});
    }
    return { ...publicView(worker), forcedKill: !!res.forced };
}

// cleanupWorker(workerId) -> stop + remove workspace. Idempotent-ish:
// unknown worker + missing workspace both succeed silently.
async function cleanupWorker(workerId) {
    const worker = workers.get(workerId);
    if (!worker) {
        return { ok: true, workerId, missing: true };
    }
    const out = await stopWorker(workerId, { cleanup: true });
    return { ok: true, ...out };
}

// OpenCodeClient bound to a worker's URL + credentials. Route code must use
// this (never hand-assemble URLs).
function workerClient(workerOrId) {
    const worker = typeof workerOrId === 'string' ? workers.get(workerOrId) : workerOrId;
    if (!worker) throw workerError('WORKER_NOT_FOUND', 'unknown worker');
    if (!worker.password) throw workerError('WORKER_CLOSED', 'worker credentials already scrubbed');
    return new OpenCodeClient({
        transport: 'server',
        serverUrl: worker.serverUrl,
        username: worker.username,
        password: worker.password
    });
}

// Mark a ready worker as running an execution (pairs with executionLock at
// the Today AI session layer; worker-level running is informational).
function markRunning(workerId) {
    const worker = workers.get(workerId);
    if (!worker) throw workerError('WORKER_NOT_FOUND', `unknown worker: ${workerId}`);
    if (worker.status !== 'ready') {
        throw workerError('WORKER_BAD_STATE', `cannot run on worker in status ${worker.status}`);
    }
    setStatus(worker, 'running');
    return publicView(worker);
}

function markIdle(workerId) {
    const worker = workers.get(workerId);
    if (!worker) throw workerError('WORKER_NOT_FOUND', `unknown worker: ${workerId}`);
    if (worker.status === 'running') setStatus(worker, 'ready');
    return publicView(worker);
}

// Public view: everything except process handle + password.
function publicView(worker) {
    return {
        workerId: worker.workerId,
        workspaceId: worker.workspaceId,
        workspacePath: worker.workspacePath,
        port: worker.port,
        serverUrl: worker.serverUrl,
        username: worker.username,
        status: worker.status,
        createdAt: worker.createdAt,
        startedAt: worker.startedAt,
        stoppedAt: worker.stoppedAt,
        lastError: worker.lastError
    };
}

function getWorker(workerId) {
    const worker = workers.get(workerId);
    return worker ? publicView(worker) : null;
}

// Full execution helper (P0.6: adopted by /api/chat + /api/chat/stream):
//   create -> start -> running -> fn(client, worker, signal) -> idle
//   -> stop + cleanup. ONE EXECUTION = ONE WORKER, never reused.
// Timeout: aborts via controller, graceful stop, force-kill fallback,
// workspace cleanup, then throws TIMEOUT. Session abort (signal) and worker
// shutdown stay separate lifecycles: aborting the session does NOT stop the
// worker by itself; lifecycle completion does.
// Mock mode (MOCK_OPENCODE=true, dev/test): same lifecycle with no real
// process — record goes ready immediately and fn runs against the mock CLI
// transport. Production never takes this branch (validateEnv exits).
// Failure workspace retention: WORKSPACE_KEEP_ON_FAILURE=true keeps the
// workspace dir on failure for debugging (default false: always cleanup).
async function withWorker(
    { workspaceId = null, startTimeoutMs = WORKER_START_TIMEOUT_MS, executionTimeoutMs = AGENT_EXECUTION_TIMEOUT_MS, spawnFn = null, cleanup = true, signal: externalSignal = null } = {},
    fn
) {
    if (typeof fn !== 'function') throw workerError('WORKER_BAD_ARG', 'withWorker requires a function');
    const pub = await createWorker({ workspaceId });
    const worker = workers.get(pub.workerId);
    const controller = new AbortController();
    const onExternalAbort = () => { try { controller.abort(); } catch {} };
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const opencodeService = require('./opencode');
    const mockMode = opencodeService.getRuntimeMode() === 'mock';
    const client = mockMode ? new OpenCodeClient({ transport: 'cli' }) : workerClient(worker);
    let timer = null;
    let failed = false;
    const timeoutError = () => {
        const err = new Error(`Agent execution timed out after ${executionTimeoutMs}ms`);
        err.code = 'TIMEOUT';
        return err;
    };
    try {
        if (mockMode) {
            if (worker.status === 'creating') {
                // Bypass process spawn; record lifecycle stays truthful.
                worker.status = 'ready';
                worker.startedAt = Date.now();
            }
        } else {
            await startWorker(worker.workerId, { timeoutMs: startTimeoutMs, spawnFn });
        }
        markRunning(worker.workerId);
        // Race the work against the deadline: fn may ignore the signal,
        // so the timeout must settle this helper on its own.
        const out = await Promise.race([
            fn(client, publicView(worker), controller.signal),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    try { controller.abort(); } catch {}
                    reject(timeoutError());
                }, executionTimeoutMs);
                if (timer.unref) timer.unref();
            })
        ]);
        if (workers.get(worker.workerId)) markIdle(worker.workerId);
        return out;
    } catch (e) {
        failed = true;
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
        try { controller.abort(); } catch {}
        const keepDir = failed && process.env.WORKSPACE_KEEP_ON_FAILURE === 'true';
        if (workers.get(worker.workerId)) {
            await stopWorker(worker.workerId, { cleanup: cleanup && !keepDir }).catch(() => {});
        } else if (cleanup && !keepDir) {
            await removeWorkspace(worker.workspaceId).catch(() => {});
        }
    }
}

function _clearForTests() {
    workers.clear();
}

module.exports = {
    withWorker,
    getWorkerLimits,
    STATUSES,
    WORKER_START_TIMEOUT_MS,
    AGENT_EXECUTION_TIMEOUT_MS,
    allocatePort,
    createWorker,
    startWorker,
    healthWorker,
    stopWorker,
    cleanupWorker,
    workerClient,
    markRunning,
    markIdle,
    getWorker,
    publicView,
    _clearForTests
};
