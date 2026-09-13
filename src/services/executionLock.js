// P0-6: per-session agent execution lock.
// Guarantees at most one active agent execution per chat session on this
// instance. Backend-enforced (never rely on frontend buttons).
// NOTE: single-instance lock. Multi-instance deployments must additionally
// consult agent_sessions status; see docs/cloud-architecture.md.
const held = new Map(); // sessionId -> { agentId, owner, startedAt }

function acquire(sessionId, { agentId = null, owner = null } = {}) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw Object.assign(new Error('sessionId is required for lock'), { status: 400 });
    }
    const cur = held.get(sessionId);
    if (cur) {
        const err = new Error('Agent already running for this session');
        err.code = 'SESSION_BUSY';
        err.status = 409;
        err.details = { agentId: cur.agentId, startedAt: cur.startedAt };
        return null;
    }
    const token = { sessionId, agentId, owner, startedAt: Date.now() };
    held.set(sessionId, token);
    return token;
}

function tryAcquire(sessionId, opts) {
    const token = acquire(sessionId, opts);
    if (!token) {
        const cur = held.get(sessionId);
        const err = new Error('Agent already running for this session');
        err.code = 'SESSION_BUSY';
        err.status = 409;
        err.details = { agentId: cur.agentId, startedAt: cur.startedAt };
        throw err;
    }
    return token;
}

function release(tokenOrSessionId) {
    const id = typeof tokenOrSessionId === 'string' ? tokenOrSessionId : tokenOrSessionId && tokenOrSessionId.sessionId;
    if (!id) return false;
    const cur = held.get(id);
    if (!cur) return false;
    if (typeof tokenOrSessionId === 'object' && tokenOrSessionId !== null && cur !== tokenOrSessionId) {
        return false; // stale token: never release someone else's lock
    }
    held.delete(id);
    return true;
}

function isLocked(sessionId) {
    return held.has(sessionId);
}

function _clearForTests() {
    held.clear();
}

module.exports = { acquire, tryAcquire, release, isLocked, _clearForTests };
