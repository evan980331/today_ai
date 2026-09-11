const express = require('express');
const { historyLimiter } = require('../middleware/rateLimit');
const { listSessions, fetchHistory, removeSession } = require('../services/session');

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

module.exports = router;
