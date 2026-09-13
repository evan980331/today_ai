const express = require('express');
const crypto = require('crypto');
const { chatLimiter } = require('../middleware/rateLimit');
const { saveLog, createAgentSession, updateAgentSessionStatus } = require('../db/db');
const { validateSessionId } = require('../services/session');
const { tryAcquire, release } = require('../services/executionLock');
const orchestrator = require('../services/agentOrchestrator');
const { DEFAULT_TIMEOUT_MS } = require('../services/opencodeRuntime');

const router = express.Router();

function sendError(res, status, error, details, sessionId) {
    res.status(status).json({ error, details, sessionId });
}

router.post('/chat', chatLimiter, async (req, res) => {
    let { prompt, sessionId } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return sendError(res, 400, 'Prompt is required and must be non-empty string');
    }
    prompt = prompt.trim();
    if (prompt.length > 8000) {
        return sendError(res, 400, 'Prompt too long (max 8000 chars)');
    }

    if (!sessionId) {
        sessionId = crypto.randomUUID();
    } else {
        try {
            validateSessionId(sessionId);
        } catch (e) {
            return sendError(res, 400, e.message);
        }
    }

    // P0-6: one active agent execution per chat session (409 otherwise).
    let lockToken = null;
    try {
        lockToken = tryAcquire(sessionId, { owner: (req.user && req.user.username) || 'unknown' });
    } catch (e) {
        return sendError(res, e.status || 409, e.message, undefined, sessionId);
    }

    // Enforce single response
    let responded = false;
    const safeJson = (code, payload) => {
        if (responded || res.headersSent) return;
        responded = true;
        res.status(code).json(payload);
    };

    const start = Date.now();
    const owner = (req.user && req.user.username) || 'unknown';
    const agentSessionId = crypto.randomUUID();
    try {
        // Save user message (await to ensure order; swallow DB errors)
        await saveLog({ sessionId, role: 'user', content: prompt, prompt }).catch(() => {});
        await createAgentSession({ id: agentSessionId, owner, workspaceId: sessionId }).catch(() => {});
        await updateAgentSessionStatus(agentSessionId, 'running').catch(() => {});

        // Execution goes through the agent orchestrator (task + runtime
        // selection); the route knows nothing about OpenCode specifics.
        // Response contract unchanged: { result, mcpTools, sessionId }.
        const task = orchestrator.createTask({
            prompt,
            sessionId,
            owner,
            runtime: 'opencode'
        });
        const runRes = await orchestrator.runTask(task.id, {
            timeoutMs: DEFAULT_TIMEOUT_MS
        });
        if (responded) return;
        const result = typeof runRes === 'string' ? runRes : runRes.result;
        const mcpTools = typeof runRes === 'string' ? [] : (Array.isArray(runRes.mcpTools) ? runRes.mcpTools : []);
        const latencyMs = Date.now() - start;
        await saveLog({ sessionId, role: 'ai', content: result, prompt, mcpTools, latencyMs }).catch(()=>{});
        await updateAgentSessionStatus(agentSessionId, 'completed').catch(() => {});
        safeJson(200, { result, mcpTools, sessionId });
    } catch (err) {
        if (responded) return;
        const isTimeout = err.code === 'TIMEOUT';
        const isUnavailable = err.code === 'RUNTIME_UNAVAILABLE' || err.code === 'MOCK_FORBIDDEN';
        const status = isTimeout ? 504 : isUnavailable ? 503 : 500;
        const details = (err.stderr || err.message || '').slice(0, 2000);
        const mcpTools = Array.isArray(err.mcpTools) ? err.mcpTools : [];
        await saveLog({ sessionId, role: 'ai', content: `ERROR: ${details}`, prompt, mcpTools, latencyMs: Date.now() - start }).catch(()=>{});
        await updateAgentSessionStatus(agentSessionId, 'failed').catch(() => {});
        const errorMsg = isTimeout ? 'OpenCode timeout' : isUnavailable ? 'OpenCode runtime unavailable' : 'OpenCode execution failed';
        safeJson(status, {
            error: errorMsg,
            details,
            mcpTools,
            hint: 'Check OPENCODE_SERVER_URL and opencode auth (opencode providers list)',
            sessionId
        });
    } finally {
        release(lockToken);
    }
});

module.exports = router;
