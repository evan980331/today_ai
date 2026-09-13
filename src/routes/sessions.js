const express = require('express');
const { historyLimiter } = require('../middleware/rateLimit');
const { listSessions, fetchHistory, removeSession } = require('../services/session');
const { getAgentSession, deleteAgentSession, listAgentSessions } = require('../db/db');

const router = express.Router();

function sendError(res, err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message, details: err.details || undefined });
}

// GET /api/sessions
router.get('/sessions', historyLimiter, async (req, res) => {
    try {
        const rows = await listSessions(req.query.limit);
        res.json(rows);
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/sessions/:id', async (req, res) => {
    try {
        await removeSession(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        sendError(res, e);
    }
});

// GET /api/history?sessionId=xxx&limit=50&before=ISO
router.get('/history', historyLimiter, async (req, res) => {
    try {
        const sessionId = req.query.sessionId || 'default';
        const rows = await fetchHistory({ sessionId, limit: req.query.limit, before: req.query.before });
        res.json(rows);
    } catch (e) {
        sendError(res, e);
    }
});

router.delete('/history', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || 'default';
        await removeSession(sessionId);
        res.json({ ok: true });
    } catch (e) {
        sendError(res, e);
    }
});

// GET /api/agent-sessions (owner = authenticated user)
router.get('/agent-sessions', async (req, res) => {
    try {
        const owner = (req.user && req.user.username) || 'unknown';
        const rows = await listAgentSessions(owner, req.query.limit);
        res.json(rows);
    } catch (e) {
        sendError(res, e);
    }
});

// DELETE /api/agent-sessions/:id (owner-checked)
router.delete('/agent-sessions/:id', async (req, res) => {
    try {
        const owner = (req.user && req.user.username) || 'unknown';
        const row = await getAgentSession(req.params.id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (row.owner !== owner) return res.status(403).json({ error: 'Forbidden' });
        await deleteAgentSession(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;
