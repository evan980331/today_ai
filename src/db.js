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

async function withRetry(fn, retries = 3, baseMs = 200) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const isRetryable = /503|ECONNRESET|ETIMEDOUT|fetch failed|timeout/i.test(e.message);
            if (!isRetryable || i === retries - 1) throw e;
            const delay = baseMs * Math.pow(2, i);
            console.warn(`[DB] retry ${i + 1}/${retries} after ${delay}ms: ${e.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

async function saveLog({ sessionId = 'default', role, content, prompt = null, mcpTools = null, latencyMs = null }) {
    const s = getSql();
    if (!s) return;
    try {
        await withRetry(() => s`
            INSERT INTO chat_logs (session_id, role, content, prompt, mcp_tools, latency_ms)
            VALUES (${sessionId}, ${role}, ${content}, ${prompt}, ${mcpTools ? JSON.stringify(mcpTools) : null}::jsonb, ${latencyMs})
        `);
    } catch (e) {
        console.error('[DB] saveLog failed:', e.message);
    }
}

async function getSessions(limit = 50) {
    const s = getSql();
    if (!s) return [];
    return withRetry(() => s`
        SELECT 
            session_id,
            COUNT(*)::int as msg_count,
            MAX(created_at) as updated_at,
            (array_agg(content ORDER BY created_at ASC))[1] as preview,
            (array_agg(role ORDER BY created_at ASC))[1] as first_role
        FROM chat_logs 
        GROUP BY session_id 
        ORDER BY updated_at DESC 
        LIMIT ${limit}
    `);
}

async function deleteSession(sessionId) {
    const s = getSql();
    if (!s) return;
    return withRetry(() => s`DELETE FROM chat_logs WHERE session_id = ${sessionId}`);
}

async function ping() {
    const s = getSql();
    if (!s) return false;
    await withRetry(() => s`SELECT 1 as ok`);
    return true;
}

module.exports = { getSql, initDb, saveLog, getSessions, deleteSession, ping, withRetry };
