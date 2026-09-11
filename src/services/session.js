const { getSessions, getHistory, deleteSession } = require('../db/db');

function validateSessionId(id) {
    if (!id || typeof id !== 'string') throw Object.assign(new Error('sessionId is required'), { status: 400 });
    if (id.length > 128) throw Object.assign(new Error('sessionId too long'), { status: 400 });
    if (!/^[a-zA-Z0-9._\-]+$/.test(id) && id !== 'default') {
        // Allow UUID format
        if (!/^[0-9a-fA-F-]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
            throw Object.assign(new Error('Invalid sessionId format'), { status: 400 });
        }
    }
    return id;
}

function validateLimit(limit, max = 200, def = 50) {
    const n = parseInt(limit);
    if (limit === undefined || limit === null || limit === '') return def;
    if (isNaN(n) || n < 1 || n > max) throw Object.assign(new Error(`limit must be 1-${max}`), { status: 400 });
    return n;
}

function validateBefore(before) {
    if (!before) return null;
    const d = new Date(before);
    if (isNaN(d.getTime())) throw Object.assign(new Error('Invalid before timestamp'), { status: 400 });
    return d.toISOString();
}

async function listSessions(limit) {
    const safeLimit = validateLimit(limit, 100, 50);
    return getSessions(safeLimit);
}

async function fetchHistory({ sessionId, limit, before }) {
    const id = validateSessionId(sessionId);
    const safeLimit = validateLimit(limit, 200, 50);
    const safeBefore = before ? validateBefore(before) : null;
    return getHistory({ sessionId: id, limit: safeLimit, before: safeBefore });
}

async function removeSession(sessionId) {
    const id = validateSessionId(sessionId);
    await deleteSession(id);
}

module.exports = { validateSessionId, validateLimit, validateBefore, listSessions, fetchHistory, removeSession };
