// POST /api/chat/stream — SSE streaming endpoint.
// Execution goes through the agent orchestrator (task + runtime selection);
// this route knows nothing about OpenCode specifics and only handles HTTP:
// validation, session lock, agent rows, SSE framing, history, and mapping
// runtime errors to the stable browser contract. The runtime emits
// normalized platform events; local vs remote is invisible here.
const express = require('express');
const crypto = require('crypto');
const { chatLimiter } = require('../middleware/rateLimit');
const { saveLog, createAgentSession, updateAgentSessionStatus } = require('../db/db');
const { validateSessionId } = require('../services/session');
const orchestrator = require('../services/agentOrchestrator');
const { tryAcquire, release } = require('../services/executionLock');

const router = express.Router();

function sseSend(res, event, data) {
    // data must be a plain object: never cookie, password or token.
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.post('/chat/stream', chatLimiter, async (req, res) => {
    let { prompt, sessionId } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt is required and must be non-empty string' });
    }
    prompt = prompt.trim();
    if (prompt.length > 8000) {
        return res.status(400).json({ error: 'Prompt too long (max 8000 chars)' });
    }
    if (!sessionId) {
        sessionId = crypto.randomUUID();
    } else {
        try {
            validateSessionId(sessionId);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    }

    // P0-6: single active execution per chat session, acquired before any
    // await so concurrent requests serialize deterministically.
    let lockToken = null;
    try {
        lockToken = tryAcquire(sessionId, { owner: (req.user && req.user.username) || 'unknown' });
    } catch (e) {
        return res.status(e.status || 409).json({ error: e.message, sessionId });
    }

    const owner = (req.user && req.user.username) || 'unknown';
    const agentSessionId = crypto.randomUUID();
    const controller = new AbortController();
    const start = Date.now();
    let finished = false;
    let fullText = '';
    const mcpTools = new Set();

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();

    const finish = async (status) => {
        if (finished) return;
        finished = true;
        release(lockToken);
        try { await updateAgentSessionStatus(agentSessionId, status); } catch {}
    };

    // Client disconnect -> abort upstream run, mark cancelled, no partial save.
    // NOTE: req 'close' fires when the request body is consumed, NOT on
    // disconnect; res 'close' with !writableEnded is the disconnect signal.
    // withWorker (linked signal below) stops the worker afterwards.
    res.on('close', () => {
        if (!finished && !res.writableEnded) {
            console.warn(`[stream] res close -> abort signal (finished=${finished})`);
            try { controller.abort(); } catch {}
            finish('cancelled');
        }
    });

    try {
        await saveLog({ sessionId, role: 'user', content: prompt, prompt }).catch(() => {});
        await createAgentSession({ id: agentSessionId, owner, workspaceId: sessionId }).catch(() => {});
        await updateAgentSessionStatus(agentSessionId, 'running').catch(() => {});

        sseSend(res, 'session.started', { sessionId, agentSessionId });

        // The orchestrator runs the task on the selected runtime; normalized
        // platform events arrive here and are framed as SSE verbatim.
        // Disconnect aborts via the linked controller signal.
        const task = orchestrator.createTask({
            prompt,
            sessionId,
            owner,
            runtime: 'opencode'
        });
        const runRes = await orchestrator.streamTask(task.id, {
            signal: controller.signal,
            onEvent: (norm) => {
                if (finished || res.writableEnded || !norm) return;
                if (norm.type === 'text.delta' && norm.content) fullText += norm.content;
                if (norm.type === 'tool.started' && norm.tool) mcpTools.add(norm.tool);
                sseSend(res, norm.type, norm);
            }
        });
        const result = typeof runRes === 'string' ? runRes : (runRes.result || fullText);
        const tools = typeof runRes === 'string' ? [] : (Array.isArray(runRes.mcpTools) && runRes.mcpTools.length ? runRes.mcpTools : Array.from(mcpTools));
        await saveLog({ sessionId, role: 'ai', content: result, prompt, mcpTools: tools, latencyMs: Date.now() - start }).catch(() => {});
        await finish('completed');
        if (!res.writableEnded) {
            sseSend(res, 'message.completed', { sessionId, mcpTools: tools });
            sseSend(res, 'done', { type: 'done', sessionId });
            res.end();
        }
    } catch (err) {
        const isAbort = err.code === 'ABORTED';
        const isTimeout = err.code === 'TIMEOUT';
        const isUnavailable = err.code === 'RUNTIME_UNAVAILABLE' || err.code === 'MOCK_FORBIDDEN' ||
            err.code === 'WORKER_UNREACHABLE' || err.code === 'WORKER_AUTH';
        const isNotImplemented = err.code === 'NOT_IMPLEMENTED';
        if (!isAbort) {
            const details = (err.stderr || err.message || '').slice(0, 500);
            await saveLog({ sessionId, role: 'ai', content: `ERROR: ${details}`, prompt, mcpTools: Array.from(mcpTools), latencyMs: Date.now() - start }).catch(() => {});
        }
        await finish(isAbort ? 'cancelled' : 'failed');
        if (!res.writableEnded) {
            const status = isUnavailable ? 503 : isNotImplemented ? 501 : 500;
            // Diagnostic passthrough: the original error code (e.g.
            // WORKER_AUTH vs WORKER_UNREACHABLE) so callers can tell
            // same-message failures apart. Codes are fixed enum strings;
            // never secrets, URLs, or headers.
            const errCode = (err && typeof err.code === 'string') ? err.code : undefined;
            sseSend(res, 'error', {
                type: 'error',
                message: isAbort ? 'aborted' : isTimeout ? 'OpenCode timeout' : isUnavailable ? 'OpenCode runtime unavailable' : isNotImplemented ? 'OpenCode Server API not implemented' : 'OpenCode execution failed',
                status,
                code: errCode
            });
            res.end();
        }
    }

});

module.exports = router;
