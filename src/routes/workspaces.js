// P3-1 workspace API. Mounted in src/app.js AFTER authMiddleware, so every
// endpoint requires authentication; the owner is always the logged-in user.
// No shell, no git operations, no filesystem paths from callers.
const express = require('express');
const { WorkspaceService } = require('../services/workspaceService');

const router = express.Router();

function ownerOf(req) {
    return (req.user && req.user.username) || 'unknown';
}

function sendError(res, err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message, details: err.details || undefined });
}

// POST /api/workspaces { sessionId, repository? } -> active workspace
// (idempotent per session: returns the existing active one if present).
router.post('/workspaces', async (req, res) => {
    try {
        const svc = WorkspaceService.default();
        const ws = await svc.create({
            sessionId: req.body && req.body.sessionId,
            owner: ownerOf(req),
            repository: req.body ? req.body.repository : undefined
        });
        res.status(201).json(ws);
    } catch (e) {
        sendError(res, e);
    }
});

// GET /api/workspaces/current?sessionId=xxx -> active workspace or 404.
router.get('/workspaces/current', async (req, res) => {
    try {
        const svc = WorkspaceService.default();
        const ws = await svc.getCurrent(req.query.sessionId, ownerOf(req));
        res.json(ws);
    } catch (e) {
        sendError(res, e);
    }
});

// GET /api/workspaces/:id -> workspace or 404 (cross-owner reads 404).
router.get('/workspaces/:id', async (req, res) => {
    try {
        const svc = WorkspaceService.default();
        const ws = await svc.getById(req.params.id, ownerOf(req));
        res.json(ws);
    } catch (e) {
        sendError(res, e);
    }
});

// PATCH /api/workspaces/:id { repository?, status? }.
router.patch('/workspaces/:id', async (req, res) => {
    try {
        const svc = WorkspaceService.default();
        const ws = await svc.update(req.params.id, ownerOf(req), req.body || {});
        res.json(ws);
    } catch (e) {
        sendError(res, e);
    }
});

// POST /api/workspaces/:id/archive -> archived (idempotent, never deletes).
router.post('/workspaces/:id/archive', async (req, res) => {
    try {
        const svc = WorkspaceService.default();
        const ws = await svc.archive(req.params.id, ownerOf(req));
        res.json(ws);
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;
