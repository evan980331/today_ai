// P3-9 checkpoint HTTP API. Mounted in src/app.js AFTER authMiddleware:
// owner always comes from the logged-in session, never the request body.
//
// GET  /api/checkpoints/:id          -> public checkpoint view (summary,
//                                        never raw file contents)
// POST /api/checkpoints/:id/resume   -> continue the run { approval?,
//                                        expectedVersion?, sessionId? }
// POST /api/checkpoints/:id/cancel   -> mark cancelled (non-terminal only)
//
// Resume executes through CodeAgentLoopService (same executor, budgets,
// and approval gates as a fresh run). A human pressing resume+approve is
// an explicit per-checkpoint decision; the agent itself has no HTTP
// identity here and can never self-approve through this endpoint.
const express = require('express');
const { AgentCheckpointService } = require('../services/agentCheckpointService');
const loop = require('../services/codeAgentLoopService');

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

function publicView(rec) {
    const st = rec.state && typeof rec.state === 'object' ? rec.state : {};
    const counts = st.counts && typeof st.counts === 'object' ? st.counts : {};
    return {
        checkpointId: rec.checkpointId,
        ownerId: rec.ownerId,
        sessionId: rec.sessionId,
        workspaceId: rec.workspaceId,
        status: rec.status,
        version: rec.version,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        summary: {
            stepsUsed: Number.isInteger(counts.steps) ? counts.steps : 0,
            testsUsed: Number.isInteger(counts.tests) ? counts.tests : 0,
            contextsUsed: Number.isInteger(counts.contexts) ? counts.contexts : 0,
            proposalId: typeof st.pendingProposalId === 'string' ? st.pendingProposalId : (typeof st.createdProposalId === 'string' ? st.createdProposalId : null),
            correctionAttempts: Number.isInteger(st.correctionBase) ? st.correctionBase + (Array.isArray(st.correctionsLog) ? st.correctionsLog.length : 0) : 0,
            finalStatus: typeof st.finalStatus === 'string' ? st.finalStatus : null,
            failureReason: typeof st.failureReason === 'string' ? st.failureReason : null
        }
    };
}

function sendError(res, err) {
    const causeCode = err && err.cause && typeof err.cause.code === 'string' ? err.cause.code : undefined;
    let status = err && (err.status === 400 || err.status === 404 || err.status === 409) ? err.status : 500;
    if (status !== 404 && (causeCode === 'CHECKPOINT_NOT_FOUND')) status = 404;
    const code = err && typeof err.code === 'string' ? err.code : undefined;
    res.status(status).json({ error: (err && err.message) || '執行失敗', code, causeCode });
}

router.get('/checkpoints/:id', async (req, res) => {
    const owner = ownerOf(req, res);
    if (!owner) return;
    try {
        const rec = await AgentCheckpointService.default().getById(req.params.id, owner, { sessionId: sessionOf(req) });
        res.json(publicView(rec));
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/checkpoints/:id/resume', async (req, res) => {
    const owner = ownerOf(req, res);
    if (!owner) return;
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const approval = body.approval === 'approved' ? { status: 'approved' } : undefined;
        const expectedVersion = body.expectedVersion === undefined ? undefined : body.expectedVersion;
        if (expectedVersion !== undefined && (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1)) {
            return res.status(400).json({ error: 'expectedVersion must be a positive integer', code: 'TOOL_INVALID_INPUT' });
        }
        // Goal/workspace/session rebind to the stored checkpoint: the
        // loop verifies caller-supplied ids against stored ones.
        const out = await loop.run({
            owner,
            goal: typeof body.goal === 'string' && body.goal ? body.goal : 'resume checkpoint',
            workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : null,
            sessionId: sessionOf(req),
            checkpointId: req.params.id,
            expectedVersion,
            approval
        });
        res.json(out);
    } catch (e) {
        sendError(res, e);
    }
});

router.post('/checkpoints/:id/cancel', async (req, res) => {
    const owner = ownerOf(req, res);
    if (!owner) return;
    try {
        const rec = await AgentCheckpointService.default().cancel(req.params.id, owner, { sessionId: sessionOf(req) });
        res.json(publicView(rec));
    } catch (e) {
        sendError(res, e);
    }
});

module.exports = router;
