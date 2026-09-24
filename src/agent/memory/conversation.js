// Conversation memory — thin wrapper over chat_logs / agent_sessions.
// Phase 1-A: interface only, no new tables, delegates to db.js.
const db = require('../../db/db');

async function getHistory(sessionId, opts) {
    return db.getHistory(sessionId, opts);
}

async function saveLog(entry) {
    return db.saveLog(entry);
}

async function createAgentSession(data) {
    return db.createAgentSession(data);
}

async function updateAgentSessionStatus(id, status) {
    return db.updateAgentSessionStatus(id, status);
}

async function getAgentSession(id) {
    // db does not expose single get, fallback to list
    return null;
}

module.exports = { getHistory, saveLog, createAgentSession, updateAgentSessionStatus, getAgentSession };
