require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

let sql = null;
function getSql() {
    if (!process.env.DATABASE_URL) {
        console.warn('[DB] DATABASE_URL 未設定，持久化將跳過');
        return null;
    }
    if (!sql) sql = neon(process.env.DATABASE_URL);
    return sql;
}

async function initDb() {
    const s = getSql();
    if (!s) return;
    try {
        await s`
            CREATE TABLE IF NOT EXISTS chat_logs (
                id BIGSERIAL PRIMARY KEY,
                session_id TEXT DEFAULT 'default',
                role TEXT CHECK (role IN ('user','ai','system')) NOT NULL,
                content TEXT NOT NULL,
                prompt TEXT,
                mcp_tools JSONB,
                latency_ms INT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `;
        await s`CREATE INDEX IF NOT EXISTS idx_chat_logs_session_created ON chat_logs (session_id, created_at DESC)`;
        console.log('[DB] chat_logs table ready');
    } catch (e) {
        console.error('[DB] init failed:', e.message);
    }
}

async function saveLog({ sessionId = 'default', role, content, prompt = null, mcpTools = null, latencyMs = null }) {
    const s = getSql();
    if (!s) return;
    try {
        await s`
            INSERT INTO chat_logs (session_id, role, content, prompt, mcp_tools, latency_ms)
            VALUES (${sessionId}, ${role}, ${content}, ${prompt}, ${mcpTools ? JSON.stringify(mcpTools) : null}::jsonb, ${latencyMs})
        `;
    } catch (e) {
        console.error('[DB] saveLog failed:', e.message);
    }
}

module.exports = { getSql, initDb, saveLog };
