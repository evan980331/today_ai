// P0.7: Agent Worker HTTP API (worker side).
//
// Served by src/workerServer.js on the worker host — NOT mounted in the
// main Today AI app (see P0.7-12: API and Worker stay separable).
//
//   POST   /workers                 { workspaceId? } -> strict view (201)
//   GET    /workers/:id             -> strict view
//   POST   /workers/:id/execute     { prompt, sessionId? } -> { result, mcpTools }
//   POST   /workers/:id/execute/stream { prompt, sessionId? } -> SSE:
//            event: upstream, data: <raw OpenCode event JSON>
//            event: done,     data: {"result","mcpTools"}
//            event: error,    data: {"message","status"}
//   POST   /workers/:id/abort       -> { ok }
//   DELETE /workers/:id             -> { ok }
//
// Auth: `X-Worker-Auth: <WORKER_SHARED_SECRET>` compared with
// constant-time comparison. NOT Bearer (this stack has no bearer
// convention). Missing/misconfigured secret denies everything (fail closed).
//
// Strict view exposes ONLY: workerId, workspaceId, status, timestamps,
// lastError. Never password, PID, ports, URLs, or absolute paths.
//
// Validation: every untrusted field is checked; `cwd`/`port`/`password`/
// `command`/`args`/`env` in the body are rejected outright (400). The
// worker resolves workspacePath from workspaceId itself — callers can
// never pick an arbitrary cwd.
const express = require('express');
const crypto = require('crypto');
const agentWorker = require('../services/agentWorker');
const { createToolCollector, mergeMcpTools } = require('../services/agentEvents');
const { validateWorkspaceId } = require('../services/workspace');
const { validateSessionId } = require('../services/session');
const { validateRepoUrl, validateRef } = require('../services/git');

const router = express.Router();

// In-flight executions per worker (abort targets). Separate from the
// Today AI session lock: one worker runs at most one execution here.
const inflight = new Map(); // workerId -> AbortController

function workerAuth(req, res, next) {
    const secret = process.env.WORKER_SHARED_SECRET || '';
    const got = req.headers['x-worker-auth'];
    const ok = typeof got === 'string' && secret.length > 0 &&
        got.length === secret.length &&
        crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret));
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

router.use(workerAuth);

function strictView(pub) {
    return {
        workerId: pub.workerId,
        workspaceId: pub.workspaceId,
        status: pub.status,
        createdAt: pub.createdAt,
        startedAt: pub.startedAt,
        stoppedAt: pub.stoppedAt,
        lastError: pub.lastError || null
    };
}

function rejectForbiddenFields(body) {
    if (!body || typeof body !== 'object') return null;
    for (const f of ['cwd', 'port', 'password', 'command', 'args', 'env', 'serverUrl']) {
        if (body[f] !== undefined) return `forbidden field: ${f}`;
    }
    return null;
}

function sendError(res, err) {
    const code = err && err.code;
    let status = err && typeof err.status === 'number' ? err.status : 500;
    if (status === 500) {
        // Map worker/upstream codes explicitly; never leak stacks.
        status = code === 'WORKER_NOT_FOUND' ? 404
            : code === 'WORKER_BUSY' ? 409
            : code === 'WORKER_LIMIT' ? 429
            : code === 'WORKER_AUTH' || code === 'UPSTREAM_AUTH' ? 502
            : code === 'UPSTREAM_UNREACHABLE' || code === 'UPSTREAM_ERROR' ? 502
            : code === 'TIMEOUT' ? 504
            : code === 'ABORTED' ? 499
            : 500;
    }
    const message = (err && err.message) ? String(err.message).slice(0, 300) : 'Worker error';
    res.status(status).json({ error: message });
}

function validateExecuteBody(body) {
    if (!body || typeof body !== 'object') throw Object.assign(new Error('Invalid request body'), { status: 400 });
    const forbidden = rejectForbiddenFields(body);
    if (forbidden) throw Object.assign(new Error(forbidden), { status: 400 });
    const { prompt, sessionId, repository, branch } = body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw Object.assign(new Error('prompt is required and must be non-empty'), { status: 400 });
    }
    if (prompt.length > 8000) throw Object.assign(new Error('prompt too long (max 8000)'), { status: 400 });
    if (sessionId !== undefined && sessionId !== null) validateSessionId(sessionId);
    if (repository !== undefined && repository !== null) validateRepoUrl(repository);
    if (branch !== undefined && branch !== null) validateRef(branch, 'branch');
    return { prompt: prompt.trim(), sessionId: sessionId || null };
}

// POST /workers — create + start. MAX_WORKERS enforced inside createWorker.
router.post('/workers', async (req, res) => {
    try {
        const body = req.body || {};
        const forbidden = rejectForbiddenFields(body);
        if (forbidden) return res.status(400).json({ error: forbidden });
        let workspaceId = null;
        if (body.workspaceId !== undefined && body.workspaceId !== null) {
            workspaceId = validateWorkspaceId(body.workspaceId);
        }
        const pub = await agentWorker.createWorker({ workspaceId });
        try {
            await agentWorker.startWorker(pub.workerId, {});
        } catch (e) {
            await agentWorker.cleanupWorker(pub.workerId).catch(() => {});
            throw e;
        }
        res.status(201).json(strictView(agentWorker.getWorker(pub.workerId)));
    } catch (err) {
        sendError(res, err);
    }
});

// GET /workers/:id
router.get('/workers/:id', async (req, res) => {
    try {
        const pub = agentWorker.getWorker(req.params.id);
        if (!pub) return res.status(404).json({ error: 'Unknown worker' });
        res.json(strictView(pub));
    } catch (err) {
        sendError(res, err);
    }
});

// POST /workers/:id/execute — one execution; 409 while one is in flight.
router.post('/workers/:id/execute', async (req, res) => {
    const id = req.params.id;
    try {
        const pub = agentWorker.getWorker(id);
        if (!pub) return res.status(404).json({ error: 'Unknown worker' });
        if (inflight.has(id)) return res.status(409).json({ error: 'Worker already running an execution' });
        const { prompt } = validateExecuteBody(req.body);
        const controller = new AbortController();
        inflight.set(id, controller);
        const timeoutMs = agentWorker.AGENT_EXECUTION_TIMEOUT_MS;
        const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
        if (timer.unref) timer.unref();
        try {
            agentWorker.markRunning(id);
            const client = agentWorker.workerClient(id);
            const collector = createToolCollector();
            const ses = await client.createSession({ title: prompt.slice(0, 80) });
            // SSE subscription runs alongside the prompt so tool calls observed
            // on the event stream merge into mcpTools; the POST /message
            // response alone misses them (its parts carry text only).
            const evDone = client.subscribeSessionEvents(ses.id, {
                signal: controller.signal,
                onRawEvent: (raw) => collector.onRawEvent(raw)
            });
            const msgP = client.promptSession(ses.id, prompt, { signal: controller.signal, timeoutMs: timeoutMs - 5000 });
            const [, msgRes] = await Promise.all([evDone, msgP]);
            agentWorker.markIdle(id);
            res.json({
                result: (msgRes && msgRes.result) || '',
                mcpTools: mergeMcpTools(msgRes && msgRes.mcpTools, collector.tools())
            });
        } finally {
            clearTimeout(timer);
            inflight.delete(id);
        }
    } catch (err) {
        inflight.delete(id);
        if (err && err.code === 'ABORTED') return res.status(499).json({ error: 'aborted' });
        sendError(res, err);
    }
});

function sseSendSafe(res, event, data) {
    if (!res || res.writableEnded || res.destroyed) return false;
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch {
        return false;
    }
}

// POST /workers/:id/execute/stream — SSE version of execute.
// Forwards RAW OpenCode events as `event: upstream` (Today AI normalizes
// for the browser; the raw schema never reaches the frontend). Terminal:
// `event: done {result, mcpTools}` / `event: error {message, status}`.
// Same auth, validation, in-flight guard and abort wiring as execute.
router.post('/workers/:id/execute/stream', async (req, res) => {
    const id = req.params.id;
    try {
        const pub = agentWorker.getWorker(id);
        if (!pub) return res.status(404).json({ error: 'Unknown worker' });
        if (inflight.has(id)) return res.status(409).json({ error: 'Worker already running an execution' });
        const { prompt } = validateExecuteBody(req.body);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        if (res.flushHeaders) res.flushHeaders();
        const controller = new AbortController();
        inflight.set(id, controller);
        const timeoutMs = agentWorker.AGENT_EXECUTION_TIMEOUT_MS;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { controller.abort(); } catch {}
        }, timeoutMs);
        if (timer.unref) timer.unref();
        let ended = false;
        // NOTE: req 'close' fires when the request BODY is consumed, NOT on
        // client disconnect. Disconnect is res 'close' with !writableEnded.
        res.on('close', () => {
            if (!ended && !res.writableEnded) {
                console.warn(`[workers] res close -> abort workerId=${id} ended=${ended}`);
                ended = true;
                try { controller.abort(); } catch {}
                inflight.delete(id);
            }
        });
        try {
            agentWorker.markRunning(id);
            const client = agentWorker.workerClient(id);
            const collector = createToolCollector();
            const ses = await client.createSession({ title: prompt.slice(0, 80) });
            const evDone = client.subscribeSessionEvents(ses.id, {
                signal: controller.signal,
                onRawEvent: (raw) => { collector.onRawEvent(raw); sseSendSafe(res, 'upstream', raw); }
            });
            const msgP = client.promptSession(ses.id, prompt, { signal: controller.signal });
            const [, msgRes] = await Promise.all([evDone, msgP]);
            agentWorker.markIdle(id);
            if (!ended) {
                sseSendSafe(res, 'done', {
                    result: (msgRes && msgRes.result) || '',
                    mcpTools: mergeMcpTools(msgRes && msgRes.mcpTools, collector.tools())
                });
                ended = true;
                res.end();
            }
        } catch (err) {
            if (!ended) {
                ended = true;
                const isAbort = (err && err.code === 'ABORTED') || controller.signal.aborted;
                const isTimeout = timedOut || (err && err.code === 'TIMEOUT');
                sseSendSafe(res, 'error', {
                    message: isAbort ? 'aborted' : isTimeout ? 'OpenCode timeout' : ((err && err.message) || 'OpenCode execution failed').slice(0, 500),
                    status: isAbort ? 499 : isTimeout ? 504 : 500
                });
                try { res.end(); } catch {}
            }
            if ((err && err.code !== 'ABORTED') || !controller.signal.aborted) {
                try { await agentWorker.workerClient(id).abortSession(id); } catch {}
            }
        } finally {
            clearTimeout(timer);
            inflight.delete(id);
        }
    } catch (err) {
        if (!res.headersSent) return sendError(res, err);
        try { res.end(); } catch {}
    }
});

// POST /workers/:id/abort — aborts in-flight execution; worker survives.
router.post('/workers/:id/abort', async (req, res) => {
    try {
        const pub = agentWorker.getWorker(req.params.id);
        if (!pub) return res.status(404).json({ error: 'Unknown worker' });
        const controller = inflight.get(req.params.id);
        if (!controller) return res.json({ ok: false, reason: 'no in-flight execution' });
        try { controller.abort(); } catch {}
        res.json({ ok: true });
    } catch (err) {
        sendError(res, err);
    }
});

// DELETE /workers/:id — abort + stop + cleanup workspace.
router.delete('/workers/:id', async (req, res) => {
    try {
        const pub = agentWorker.getWorker(req.params.id);
        if (!pub) return res.status(404).json({ error: 'Unknown worker' });
        const controller = inflight.get(req.params.id);
        if (controller) {
            try { controller.abort(); } catch {}
            inflight.delete(req.params.id);
        }
        await agentWorker.cleanupWorker(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        sendError(res, err);
    }
});

module.exports = router;
module.exports._inflight = inflight;
