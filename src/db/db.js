require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

let sql = null;
function getSql() {
    if (!process.env.DATABASE_URL) {
        return null;
    }
    if (!sql) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

async function initDb() {
    const s = getSql();
    if (!s) {
        console.warn('[DB] DATABASE_URL not set, persistence disabled');
        return;
    }
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
        // P0-3: agent session model. chat_logs stays untouched (backward compatible);
        // agent_sessions tracks lifecycle, owner and workspace linkage.
        await s`
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                repository TEXT,
                branch TEXT,
                workspace_id TEXT,
                status TEXT CHECK (status IN ('created','running','completed','failed','cancelled')) NOT NULL DEFAULT 'created',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `;
        await s`CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_updated ON agent_sessions (owner, updated_at DESC)`;
        console.log('[DB] agent_sessions table ready');
        // Auth sessions for multi-instance deployments (Vercel serverless):
        // only the SHA-256 hash of the cookie token is stored — never the
        // token itself, never any password.
        await s`
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            )
        `;
        await s`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at)`;
        console.log('[DB] auth_sessions table ready');
        // Auth users: credentials moved from env to DB (hashed passwords only).
        await s`
            CREATE TABLE IF NOT EXISTS auth_users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        await s`CREATE INDEX IF NOT EXISTS idx_auth_users_username ON auth_users (username)`;
        console.log('[DB] auth_users table ready');
        // P3-1: workspace entity store. Additive table only; existing schemas
        // untouched. session_id+owner scoping enforces per-session isolation;
        // repository is a JSONB identity blob (no clone/checkout here).
        await s`
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                owner TEXT NOT NULL,
                repository JSONB,
                root_path TEXT NOT NULL,
                status TEXT CHECK (status IN ('active','archived')) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `;
        await s`CREATE INDEX IF NOT EXISTS idx_workspaces_session_owner ON workspaces (session_id, owner, updated_at DESC)`;
        console.log('[DB] workspaces table ready');
    } catch (e) {
        console.error('[DB] init failed:', e.message);
        // Do not crash server on DB failure
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
    if (!['user', 'ai', 'system'].includes(role)) throw new Error(`Invalid role: ${role}`);
    try {
        await withRetry(() => s`
            INSERT INTO chat_logs (session_id, role, content, prompt, mcp_tools, latency_ms)
            VALUES (${sessionId}, ${role}, ${content}, ${prompt}, ${mcpTools ? JSON.stringify(mcpTools) : null}::jsonb, ${latencyMs})
        `);
    } catch (e) {
        console.error('[DB] saveLog failed:', e.message);
        // Swallow to avoid crashing request
    }
}

async function getSessions(limit = 50) {
    const s = getSql();
    if (!s) return [];
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
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
        LIMIT ${safeLimit}
    `);
}

async function getHistory({ sessionId, limit = 50, before = null }) {
    const s = getSql();
    if (!s) return [];
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    if (before) {
        // Validate ISO timestamp
        const d = new Date(before);
        if (isNaN(d.getTime())) throw new Error('Invalid before timestamp');
        return withRetry(() => s`
            SELECT id, session_id, role, content, prompt, mcp_tools, latency_ms, created_at
            FROM chat_logs 
            WHERE session_id = ${sessionId} AND created_at < ${before}::timestamptz 
            ORDER BY created_at ASC LIMIT ${safeLimit}
        `);
    }
    return withRetry(() => s`
        SELECT id, session_id, role, content, prompt, mcp_tools, latency_ms, created_at
        FROM chat_logs 
        WHERE session_id = ${sessionId} 
        ORDER BY created_at ASC LIMIT ${safeLimit}
    `);
}

async function deleteSession(sessionId) {
    const s = getSql();
    if (!s) return;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('Invalid sessionId');
    return withRetry(() => s`DELETE FROM chat_logs WHERE session_id = ${sessionId}`);
}

async function ping() {
    const s = getSql();
    if (!s) return false;
    await withRetry(() => s`SELECT 1 as ok`);
    return true;
}

const AGENT_STATUS = ['created', 'running', 'completed', 'failed', 'cancelled'];

async function createAgentSession({ id, owner, repository = null, branch = null, workspaceId = null }) {
    const s = getSql();
    if (!s) return null;
    if (!id || typeof id !== 'string' || id.length > 128) throw new Error('Invalid agent session id');
    if (!owner || typeof owner !== 'string' || owner.length > 256) throw new Error('Invalid agent session owner');
    const rows = await withRetry(() => s`
        INSERT INTO agent_sessions (id, owner, repository, branch, workspace_id, status)
        VALUES (${id}, ${owner}, ${repository}, ${branch}, ${workspaceId}, 'created')
        ON CONFLICT (id) DO NOTHING
        RETURNING id, owner, repository, branch, workspace_id AS "workspaceId", status, created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows[0] || null;
}

async function getAgentSession(id) {
    const s = getSql();
    if (!s) return null;
    const rows = await withRetry(() => s`
        SELECT id, owner, repository, branch, workspace_id AS "workspaceId", status,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM agent_sessions WHERE id = ${id}
    `);
    return rows[0] || null;
}

async function updateAgentSessionStatus(id, status) {
    const s = getSql();
    if (!s) return null;
    if (!AGENT_STATUS.includes(status)) throw new Error(`Invalid agent session status: ${status}`);
    const rows = await withRetry(() => s`
        UPDATE agent_sessions SET status = ${status}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, owner, repository, branch, workspace_id AS "workspaceId", status,
                  created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows[0] || null;
}

async function listAgentSessions(owner, limit = 50) {
    const s = getSql();
    if (!s) return [];
    const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    return withRetry(() => s`
        SELECT id, owner, repository, branch, workspace_id AS "workspaceId", status,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM agent_sessions WHERE owner = ${owner}
        ORDER BY updated_at DESC LIMIT ${safeLimit}
    `);
}

async function deleteAgentSession(id) {
    const s = getSql();
    if (!s) return;
    if (!id || typeof id !== 'string' || id.length > 128) throw new Error('Invalid agent session id');
    await withRetry(() => s`DELETE FROM agent_sessions WHERE id = ${id}`);
}

async function saveAuthSession({ tokenHash, username, createdAt, expiresAt }) {
    const s = getSql();
    if (!s) return null;
    if (!tokenHash || typeof tokenHash !== 'string' || tokenHash.length > 128) throw new Error('Invalid auth session id');
    if (!username || typeof username !== 'string' || username.length > 256) throw new Error('Invalid auth session owner');
    const rows = await withRetry(() => s`
        INSERT INTO auth_sessions (token_hash, username, created_at, expires_at)
        VALUES (${tokenHash}, ${username}, ${createdAt}, ${expiresAt})
        ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at
        RETURNING token_hash AS "tokenHash", username,
                  created_at AS "createdAt", expires_at AS "expiresAt"
    `);
    return rows[0] || null;
}

async function findAuthSession(tokenHash) {
    const s = getSql();
    if (!s) return null;
    const rows = await withRetry(() => s`
        SELECT token_hash AS "tokenHash", username,
               created_at AS "createdAt", expires_at AS "expiresAt"
        FROM auth_sessions WHERE token_hash = ${tokenHash}
    `);
    return rows[0] || null;
}

async function deleteAuthSession(tokenHash) {
    const s = getSql();
    if (!s) return;
    if (!tokenHash || typeof tokenHash !== 'string' || tokenHash.length > 128) throw new Error('Invalid auth session id');
    await withRetry(() => s`DELETE FROM auth_sessions WHERE token_hash = ${tokenHash}`);
}

async function findAuthUserByUsername(username) {
    const s = getSql();
    if (!s) return null;
    if (!username || typeof username !== 'string') return null;
    const rows = await withRetry(() => s`
        SELECT id, username, password_hash AS "passwordHash",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM auth_users WHERE username = ${username}
    `);
    return rows[0] || null;
}

async function createAuthUser({ id, username, passwordHash }) {
    const s = getSql();
    if (!s) throw new Error('DATABASE_URL not configured');
    if (!username || typeof username !== 'string' || username.length > 256) throw new Error('Invalid username');
    if (!passwordHash || typeof passwordHash !== 'string') throw new Error('Invalid password hash');
    const uid = id || username;
    const rows = await withRetry(() => s`
        INSERT INTO auth_users (id, username, password_hash)
        VALUES (${uid}, ${username}, ${passwordHash})
        ON CONFLICT (username) DO NOTHING
        RETURNING id, username, password_hash AS "passwordHash",
                  created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows[0] || null;
}

async function upsertAuthUser({ username, passwordHash }) {
    const s = getSql();
    if (!s) throw new Error('DATABASE_URL not configured');
    if (!username || typeof username !== 'string' || username.length > 256) throw new Error('Invalid username');
    if (!passwordHash || typeof passwordHash !== 'string') throw new Error('Invalid password hash');
    const rows = await withRetry(() => s`
        INSERT INTO auth_users (id, username, password_hash, updated_at)
        VALUES (${username}, ${username}, ${passwordHash}, NOW())
        ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()
        RETURNING id, username, password_hash AS "passwordHash",
                  created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows[0] || null;
}

async function countAuthUsers() {
    const s = getSql();
    if (!s) return 0;
    const rows = await withRetry(() => s`SELECT COUNT(*)::int AS count FROM auth_users`);
    return rows[0] ? rows[0].count : 0;
}

async function deleteAuthUser(username) {
    const s = getSql();
    if (!s) return;
    await withRetry(() => s`DELETE FROM auth_users WHERE username = ${username}`);
}

async function createWorkspaceRow({ id, sessionId, owner, repository = null, rootPath, status = 'active' }) {
    const s = getSql();
    if (!s) throw new Error('DATABASE_URL not configured');
    const rows = await withRetry(() => s`
        INSERT INTO workspaces (id, session_id, owner, repository, root_path, status)
        VALUES (${id}, ${sessionId}, ${owner}, ${repository ? JSON.stringify(repository) : null}::jsonb, ${rootPath}, ${status})
        ON CONFLICT (id) DO NOTHING
        RETURNING id, session_id AS "sessionId", owner, repository, root_path AS "rootPath", status,
                  created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows[0] || null;
}

async function getWorkspaceRow(id) {
    const s = getSql();
    if (!s) return null;
    const rows = await withRetry(() => s`
        SELECT id, session_id AS "sessionId", owner, repository, root_path AS "rootPath", status,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM workspaces WHERE id = ${id}
    `);
    return rows[0] || null;
}

async function getActiveWorkspaceBySession(sessionId, owner) {
    const s = getSql();
    if (!s) return null;
    const rows = await withRetry(() => s`
        SELECT id, session_id AS "sessionId", owner, repository, root_path AS "rootPath", status,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM workspaces WHERE session_id = ${sessionId} AND owner = ${owner} AND status = 'active'
        ORDER BY updated_at DESC LIMIT 1
    `);
    return rows[0] || null;
}

async function updateWorkspaceRow(id, { repository, status }) {
    const s = getSql();
    if (!s) throw new Error('DATABASE_URL not configured');
    const rows = await withRetry(() => s`
        UPDATE workspaces
        SET repository = COALESCE(${repository !== undefined ? JSON.stringify(repository) : null}::jsonb, repository),
            status = COALESCE(${status !== undefined ? status : null}, status),
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, session_id AS "sessionId", owner, repository, root_path AS "rootPath", status,
                  created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows[0] || null;
}

// Test/maintenance cleanup only — the product lifecycle archives, never deletes.
async function deleteWorkspaceRow(id) {
    const s = getSql();
    if (!s) return;
    await withRetry(() => s`DELETE FROM workspaces WHERE id = ${id}`);
}

module.exports = {
    getSql, initDb, saveLog, getSessions, getHistory, deleteSession, ping, withRetry,
    AGENT_STATUS, createAgentSession, getAgentSession, updateAgentSessionStatus,
    listAgentSessions, deleteAgentSession,
    saveAuthSession, findAuthSession, deleteAuthSession,
    findAuthUserByUsername, createAuthUser, upsertAuthUser, countAuthUsers, deleteAuthUser,
    createWorkspaceRow, getWorkspaceRow, getActiveWorkspaceBySession, updateWorkspaceRow, deleteWorkspaceRow
};
