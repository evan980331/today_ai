// P3-7 proposal HTTP API. Mounted in src/app.js AFTER authMiddleware, so
// every endpoint requires authentication; the owner always comes from the
// logged-in session (req.user) — never from the client body.
//
// Human-approval contract: clicking Approve/Reject on one proposal card is
// an explicit per-proposal decision, so the apply call carries approval
// approved for exactly that tool call. The agent can never reach this
// endpoint with its own approval: it has no HTTP identity here.
//
// All execution goes through ToolRegistry.execute() (change_get /
// change_apply / change_reject) — never directly to changeProposalService
// — so the permission gate, owner/session binding, and stale detection
// all still apply. No filesystem paths, no env, no shell from callers.
const express = require('express');
const toolRegistry = require('../services/tools/toolRegistry');

const router = express.Router();

function ownerOf(req, res) {
    const owner = req.user && req.user.username;
    if (!owner || typeof owner !== 'string' || !owner.trim()) {
        res.status(401).json({ error: '未授權：請先登入' });
        return null;
    }
    return owner.trim();
}

function sessionOf(req) {
    const fromBody = req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId : null;
    const fromQuery = req.query && typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
    return fromBody || fromQuery || null;
}

function sendError(res, err) {
    const causeCode = err && err.cause && typeof err.cause.code === 'string' ? err.cause.code : undefined;
    // Service-level NOT_FOUND (owner/session isolation) arrives wrapped as
    // TOOL_EXECUTION_ERROR; restore 404 so callers can tell it apart.
    let status = err && (err.status === 400 || err.status === 404) ? err.status : 500;
    if (status !== 404 && causeCode === 'PROPOSAL_NOT_FOUND') status = 404;
    const code = err && typeof err.code === 'string' ? err.code : undefined;
    res.status(status).json({ error: (err && err.message) || '執行失敗', code, causeCode });
}

// GET /api/change-proposals/:id?sessionId=xxx -> proposal with diffs.
router.get('/change-proposals/:id', async (req, res) => {
    const owner = ownerOf(req, res);
    if (!owner) return;
    try {
        const out = await toolRegistry.execute('change_get', { proposalId: req.params.id }, { owner, sessionId: sessionOf(req) });
        res.json(out.result);
    } catch (e) {
        sendError(res, e);
    }
});

// POST /api/change-proposals/:id/apply { sessionId? } -> applied.
router.post('/change-proposals/:id/apply', async (req, res) => {
    const owner = ownerOf(req, res);
    if (!owner) return;
    try {
        const out = await toolRegistry.execute(
            'change_apply',
            { proposalId: req.params.id },
            { owner, sessionId: sessionOf(req), approval: { status: 'approved' } }
        );
        res.json(out.result);
    } catch (e) {
        sendError(res, e);
    }
});

// POST /api/change-proposals/:id/reject { sessionId? } -> rejected.
router.post('/change-proposals/:id/reject', async (req, res) => {
    const owner = ownerOf(req, res);
    if (!owner) return;
    try {
        const out = await toolRegistry.execute(
            'change_reject',
            { proposalId: req.params.id },
            { owner, sessionId: sessionOf(req) }
        );
        res.json(out.result);
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;
