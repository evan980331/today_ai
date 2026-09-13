// P0.7-6/P0.7-13: Agent Worker provider abstraction.
//
// Today AI backend only knows this interface — never OpenCode processes,
// PIDs, local cwd, or child_process details:
//
//   create(opts)            -> { workerId, workspaceId, status, ... } (public view)
//   execute(workerId, fn)   -> runs fn(client, worker, signal) inside lifecycle
//   abort(workerId)         -> aborts in-flight execution (worker survives)
//   destroy(workerId)       -> stop + cleanup workspace
//
// Implementations:
//   LocalProcessWorkerProvider - single-host agentWorker.js (this round).
//   RemoteWorkerProvider       - HTTP worker API (src/services/remoteWorker.js).
// No queue/Redis/K8s this round; the interface stays replaceable.
const agentWorker = require('./agentWorker');

class LocalProcessWorkerProvider {
    constructor(opts = {}) {
        this.spawnFn = opts.spawnFn || null;
        this.controllers = new Map(); // workerId -> AbortController (in-flight)
    }

    // Create + start only; execution happens via execute(). (withWorker()
    // fuses create+execute+destroy for one-shot flows; the provider keeps
    // the worker alive across execute() calls within one owner flow.)
    async create(opts = {}) {
        const pub = await agentWorker.createWorker({ workspaceId: opts.workspaceId || null });
        try {
            await agentWorker.startWorker(pub.workerId, {
                timeoutMs: opts.startTimeoutMs,
                spawnFn: this.spawnFn
            });
        } catch (e) {
            await agentWorker.cleanupWorker(pub.workerId).catch(() => {});
            throw e;
        }
        return agentWorker.getWorker(pub.workerId);
    }

    async execute(workerId, fn, opts = {}) {
        const worker = agentWorker.getWorker(workerId);
        if (!worker) {
            const err = new Error(`unknown worker: ${workerId}`);
            err.code = 'WORKER_NOT_FOUND';
            err.status = 404;
            throw err;
        }
        if (this.controllers.has(workerId)) {
            const err = new Error('Worker already running an execution');
            err.code = 'WORKER_BUSY';
            err.status = 409;
            throw err;
        }
        const controller = new AbortController();
        this.controllers.set(workerId, controller);
        const { OpenCodeClient } = require('./agentClient');
        const client = new OpenCodeClient({ transport: 'cli', workspaceDir: worker.workspacePath });
        const timeoutMs = opts.executionTimeoutMs || agentWorker.AGENT_EXECUTION_TIMEOUT_MS;
        let timer = null;
        try {
            agentWorker.markRunning(workerId);
            const out = await Promise.race([
                fn(client, worker, controller.signal),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        try { controller.abort(); } catch {}
                        const e = new Error(`Agent execution timed out after ${timeoutMs}ms`);
                        e.code = 'TIMEOUT';
                        reject(e);
                    }, timeoutMs);
                    if (timer.unref) timer.unref();
                })
            ]);
            agentWorker.markIdle(workerId);
            return out;
        } finally {
            if (timer) clearTimeout(timer);
            try { controller.abort(); } catch {}
            this.controllers.delete(workerId);
        }
    }

    async abort(workerId) {
        const controller = this.controllers.get(workerId);
        if (!controller) return { ok: false, reason: 'no in-flight execution' };
        controller.abort();
        return { ok: true };
    }

    async destroy(workerId, { cleanup = true } = {}) {
        await this.abort(workerId).catch(() => {});
        return agentWorker.cleanupWorker(workerId);
    }
}

module.exports = { LocalProcessWorkerProvider, executePrompt, useRemoteWorker };

// Whether Today AI routes should execute via a remote Agent Worker
// instead of local withWorker(). Requires BOTH env vars; never inferred
// from OPENCODE_SERVER_URL (that one addresses an OpenCode Server, which
// is a different hop).
function useRemoteWorker() {
    return !!(process.env.WORKER_URL && process.env.WORKER_SHARED_SECRET);
}

// One-shot prompt execution for routes. Local path reuses withWorker()
// (workspace lifecycle + mock support). Remote path proxies one execution
// through the worker API (create -> execute -> destroy in finally).
// Returns { result, mcpTools } in both cases.
async function executePrompt({ prompt, workspaceId = null, sessionId = null, signal = null, timeoutMs = 600000 } = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw Object.assign(new Error('prompt is required'), { status: 400 });
    }
    if (useRemoteWorker()) {
        const { RemoteWorkerClient } = require('./remoteWorker');
        const client = new RemoteWorkerClient({});
        const w = await client.create({ workspaceId });
        try {
            return await client.execute(w.workerId, { prompt, sessionId, signal, timeoutMs });
        } finally {
            await client.destroy(w.workerId).catch(() => {});
        }
    }
    const agentWorker = require('./agentWorker');
    return agentWorker.withWorker({ workspaceId, signal }, async (client) =>
        client.sendPrompt(prompt, { timeoutMs })
    );
}
