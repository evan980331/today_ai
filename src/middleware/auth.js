const crypto = require('crypto');
const { getSql, saveAuthSession, findAuthSession, deleteAuthSession, findAuthUserByUsername } = require('../db/db');
const { verifyPassword } = require('../services/password');

// Session store: fast in-process Map (write-through) + shared Postgres
// table (auth_sessions) so a session created on one instance (e.g. Vercel
// instance A login) validates on any other instance. Only the SHA-256 hash
// of the cookie token is persisted — never the token, never a password.
// Map<token, { username, createdAt, expiresAt }>
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isAuthConfigured() {
    // Auth is now DB-backed (auth_users). If DATABASE_URL is present, auth is
    // considered configured; login will query the table. Without DB (dev without
    // DATABASE_URL), fall back to allow-all in non-production for local dev parity.
    if (getSql()) return true;
    return false;
}

async function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex'); // 64 chars, not derived from credentials
    const now = Date.now();
    sessions.set(token, {
        username,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS
    });
    // Awaited: a subsequent request on another instance must see this row.
    // Best-effort when the database is unavailable (dev parity).
    try {
        await saveAuthSession({
            tokenHash: tokenHash(token),
            username,
            createdAt: new Date(now),
            expiresAt: new Date(now + SESSION_TTL_MS)
        });
    } catch {}
    return token;
}

async function getSession(token) {
    if (!token) return null;
    if (!getSql()) {
        // No shared store configured: single-instance memory semantics.
        const sess = sessions.get(token);
        if (!sess) return null;
        if (Date.now() > sess.expiresAt) {
            sessions.delete(token);
            return null;
        }
        return sess;
    }
    // Shared store configured: the database is authoritative so revocation
    // (logout) propagates across instances immediately. The Map is only a
    // fallback while the database is unreachable.
    try {
        const row = await findAuthSession(tokenHash(token));
        if (!row) {
            sessions.delete(token);
            return null;
        }
        if (Date.now() > new Date(row.expiresAt).getTime()) {
            sessions.delete(token);
            try { await deleteAuthSession(tokenHash(token)); } catch {}
            return null;
        }
        const shared = {
            username: row.username,
            createdAt: new Date(row.createdAt).getTime(),
            expiresAt: new Date(row.expiresAt).getTime()
        };
        sessions.set(token, shared);
        return shared;
    } catch {
        const sess = sessions.get(token);
        if (!sess) return null;
        if (Date.now() > sess.expiresAt) {
            sessions.delete(token);
            return null;
        }
        return sess;
    }
}

async function destroySession(token) {
    if (!token) return;
    sessions.delete(token);
    try { await deleteAuthSession(tokenHash(token)); } catch {}
}

// Clean expired sessions every 15min
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [tok, sess] of sessions.entries()) {
        if (now > sess.expiresAt) sessions.delete(tok);
    }
}, 15 * 60 * 1000);
if (cleanupInterval.unref) cleanupInterval.unref();

function getTokenFromRequest(req) {
    if (req.cookies && req.cookies.todayai_session) {
        return req.cookies.todayai_session;
    }
    return null;
}

async function authMiddleware(req, res, next) {
    // Public paths — handle both mounted (/health) and full (/api/health)
    const p = req.path;
    if (p === '/health' || p === '/health/' ||
        p === '/api/health' || p === '/api/health/' ||
        p === '/auth/login' || p === '/auth/login/' ||
        p === '/api/auth/login' || p === '/api/auth/login/' ||
        p === '/auth/logout' || p === '/auth/logout/' ||
        p === '/api/auth/logout' || p === '/api/auth/logout/' ||
        p === '/auth/me' || p === '/api/auth/me') {
        return next();
    }

    // If no auth configured (dev without AUTH_USERNAME), allow all
    if (!isAuthConfigured()) {
        if (process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: 'Unauthorized', details: 'Server AUTH not configured' });
        }
        return next();
    }

    let sess = null;
    try {
        const token = getTokenFromRequest(req);
        sess = await getSession(token);
    } catch (err) {
        return next(err);
    }
    if (!sess) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { username: sess.username };
    req.sessionToken = getTokenFromRequest(req);
    next();
}

// Handlers
async function loginHandler(req, res) {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const trimmedUser = username.trim();
    if (!trimmedUser || typeof password !== 'string' || password.length === 0) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // DB-backed verification (hashed passwords only)
    let ok = false;
    let dbUser = null;
    try {
        dbUser = await findAuthUserByUsername(trimmedUser);
        if (dbUser && dbUser.passwordHash) {
            ok = verifyPassword(password, dbUser.passwordHash);
        }
    } catch {
        // Do not leak DB errors
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!ok || !dbUser) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = await createSession(dbUser.username);
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('todayai_session', token, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'Lax',
        maxAge: SESSION_TTL_MS,
        path: '/'
    });
    res.json({ ok: true, username: dbUser.username });
}

async function logoutHandler(req, res) {
    const token = getTokenFromRequest(req);
    if (token) await destroySession(token);
    res.clearCookie('todayai_session', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/'
    });
    res.json({ ok: true });
}

async function meHandler(req, res) {
    const token = getTokenFromRequest(req);
    const sess = await getSession(token);
    if (!sess) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ authenticated: true, username: sess.username });
}

module.exports = {
    authMiddleware,
    loginHandler,
    logoutHandler,
    meHandler,
    getSession,
    createSession,
    destroySession,
    _sessions: sessions // exposed for tests only
};
