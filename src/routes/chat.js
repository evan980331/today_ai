const express = require('express');
const crypto = require('crypto');
const { chatLimiter } = require('../middleware/rateLimit');
const { saveLog } = require('../db/db');
const { validateSessionId } = require('../services/session');
const opencodeService = require('../services/opencode');

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

    // Enforce single response
    let responded = false;
    const safeJson = (code, payload) => {
        if (responded || res.headersSent) return;
        responded = true;
        res.status(code).json(payload);
    };

    const start = Date.now();
    // Save user message (fire-and-forget, but await to ensure order; swallow DB errors)
    await saveLog({ sessionId, role: 'user', content: prompt, prompt }).catch(()=>{});

    try {
        const result = await opencodeService.run(prompt, { timeoutMs: opencodeService.MCP_TIMEOUT_MS });
        if (responded) return;
        const latencyMs = Date.now() - start;
        // Avoid duplicate write: ensure only one save per AI response
        await saveLog({ sessionId, role: 'ai', content: result, prompt, latencyMs }).catch(()=>{});
        safeJson(200, { result, sessionId });
    } catch (err) {
        if (responded) return;
        const isTimeout = err.code === 'TIMEOUT';
        const status = isTimeout ? 504 : 500;
        const details = (err.stderr || err.message || '').slice(0, 2000);
        // Save error as ai log for history (single write)
        await saveLog({ sessionId, role: 'ai', content: `ERROR: ${details}`, prompt, latencyMs: Date.now() - start }).catch(()=>{});
        const errorMsg = isTimeout ? 'OpenCode timeout' : 'OpenCode execution failed';
        safeJson(status, {
            error: errorMsg,
            details,
            hint: 'Check OPENCODE_SERVER_URL and opencode auth (opencode providers list)',
            sessionId
        });
    }
});

module.exports = router;
