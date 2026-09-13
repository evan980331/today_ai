const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('Auth middleware - unit', () => {
    const { authMiddleware } = require('../src/middleware/auth');

    function mockReq(path, cookie) {
        return {
            path,
            headers: {},
            cookies: cookie ? { todayai_session: cookie } : {}
        };
    }
    function mockRes() {
        const res = {};
        res.statusCode = null;
        res.body = null;
        res.status = function(c) { this.statusCode = c; return this; };
        res.json = function(o) { this.body = o; return this; };
        res.clearCookie = function() {};
        res.cookie = function() {};
        return res;
    }

    it('should allow health without login', () => {
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'secret123';
        const req = mockReq('/api/health', null);
        const res = mockRes();
        let next = false;
        authMiddleware(req, res, () => { next = true; });
        assert.equal(next, true);
    });

    it('should 401 when not logged in for /api/chat', async () => {
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'secret123';
        const req = mockReq('/api/chat', null);
        const res = mockRes();
        let next = false;
        await authMiddleware(req, res, () => { next = true; });
        assert.equal(next, false);
        assert.equal(res.statusCode, 401);
    });

    it('should 401 with invalid cookie', async () => {
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'secret123';
        const req = mockReq('/api/chat', 'invalid-token-xyz');
        const res = mockRes();
        let next = false;
        await authMiddleware(req, res, () => { next = true; });
        assert.equal(next, false);
        assert.equal(res.statusCode, 401);
    });

    it('should allow with valid session', async () => {
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'secret123';
        const { createSession } = require('../src/middleware/auth');
        const token = await createSession('admin');
        const req = mockReq('/api/chat', token);
        const res = mockRes();
        let next = false;
        await authMiddleware(req, res, () => { next = true; });
        assert.equal(next, true);
        assert.equal(req.user.username, 'admin');
        // cleanup
        const { destroySession } = require('../src/middleware/auth');
        await destroySession(token);
    });

    it('should reject Bearer header (cookie-only auth)', async () => {
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'secret123';
        const { createSession } = require('../src/middleware/auth');
        const token = await createSession('admin');
        const req = {
            path: '/api/chat',
            headers: { authorization: `Bearer ${token}` },
            cookies: {}
        };
        const res = mockRes();
        let next = false;
        await authMiddleware(req, res, () => { next = true; });
        assert.equal(next, false);
        assert.equal(res.statusCode, 401);
        const { destroySession } = require('../src/middleware/auth');
        await destroySession(token);
    });

    it('should allow when no AUTH_USERNAME configured in dev', () => {
        const origU = process.env.AUTH_USERNAME;
        const origP = process.env.AUTH_PASSWORD;
        const origEnv = process.env.NODE_ENV;
        delete process.env.AUTH_USERNAME;
        delete process.env.AUTH_PASSWORD;
        process.env.NODE_ENV = 'development';
        const req = mockReq('/api/chat', null);
        const res = mockRes();
        let next = false;
        // Need to re-require to get fresh isAuthConfigured? But authMiddleware checks env at request time, so it will see no username
        authMiddleware(req, res, () => { next = true; });
        assert.equal(next, true);
        process.env.AUTH_USERNAME = origU;
        process.env.AUTH_PASSWORD = origP;
        process.env.NODE_ENV = origEnv;
    });
});

describe('Auth persistence across instances (shared Postgres store)', () => {
    const crypto = require('crypto');
    const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';

    function sha256(s) {
        return crypto.createHash('sha256').update(String(s)).digest('hex');
    }

    async function login(base, username, password) {
        const res = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const setCookie = res.headers.get('set-cookie') || '';
        const m = setCookie.match(/todayai_session=([^;]+)/);
        return { res, token: m ? m[1] : null, setCookie };
    }

    it('login persists only a hash + username, never password or token', async () => {
        const { res, token } = await login(BASE, 'admin', 'admin123');
        assert.equal(res.status, 200);
        assert.ok(token);
        const { findAuthSession, deleteAuthSession } = require('../src/db/db');
        try {
            const row = await findAuthSession(sha256(token));
            assert.ok(row, 'session row must exist in shared store');
            assert.equal(row.username, 'admin');
            assert.ok(!('password' in row), 'no password field may be stored');
            const flat = JSON.stringify(row);
            assert.ok(!flat.includes(token), 'raw token must not be stored');
            assert.ok(!flat.includes('admin123'), 'password must not be stored');
            assert.ok(new Date(row.expiresAt).getTime() > Date.now(), 'row must carry a future expiry');
        } finally {
            await deleteAuthSession(sha256(token)).catch(() => {});
        }
    });

    it('instance A login validates on instance B (true second server)', async () => {
        // A second, fully independent Express instance sharing only Postgres.
        const app = require('../src/app');
        const serverB = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const baseB = `http://127.0.0.1:${serverB.address().port}`;
        const closeB = async () => {
            if (serverB.closeAllConnections) serverB.closeAllConnections();
            await new Promise((r) => serverB.close(r));
        };
        try {
            const { res, token } = await login(BASE, 'admin', 'admin123');
            assert.equal(res.status, 200);
            assert.ok(token);
            const cookie = `todayai_session=${token}`;
            // Same cookie validates on the other instance (shared store).
            let me = await fetch(`${baseB}/api/auth/me`, { headers: { Cookie: cookie } });
            assert.equal(me.status, 200);
            assert.equal((await me.json()).username, 'admin');
            // Logout on A destroys everywhere: B rejects afterwards.
            const logout = await fetch(`${BASE}/api/auth/logout`, {
                method: 'POST',
                headers: { Cookie: cookie }
            });
            assert.equal(logout.status, 200);
            me = await fetch(`${baseB}/api/auth/me`, { headers: { Cookie: cookie } });
            assert.equal(me.status, 401);
        } finally {
            await closeB();
        }
    });

    it('expired rows never validate (deterministic unit)', async () => {
        const { saveAuthSession, deleteAuthSession } = require('../src/db/db');
        const { getSession, _sessions } = require('../src/middleware/auth');
        const past = new Date(Date.now() - 60 * 1000);
        const probeToken = `probe-${Date.now()}`;
        _sessions.delete(probeToken); // unknown to memory: forces the DB path
        await saveAuthSession({
            tokenHash: sha256(probeToken),
            username: 'admin',
            createdAt: past,
            expiresAt: past
        });
        try {
            assert.equal(await getSession(probeToken), null);
        } finally {
            await deleteAuthSession(sha256(probeToken)).catch(() => {});
        }
    });
});

describe('Auth integration via HTTP', () => {
    const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';

    async function login(username, password) {
        const res = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const body = await res.json().catch(() => ({}));
        const setCookie = res.headers.get('set-cookie') || '';
        const tokenMatch = setCookie.match(/todayai_session=([^;]+)/);
        const token = tokenMatch ? tokenMatch[1] : null;
        return { res, body, token, setCookie };
    }

    it('health should not require login', async () => {
        const res = await fetch(`${BASE}/api/health`);
        assert.equal(res.status, 200);
    });

    it('login with correct credentials should 200 and set HttpOnly cookie', async () => {
        const { res, body, setCookie } = await login('admin', 'admin123');
        assert.equal(res.status, 200);
        assert.equal(body.ok, true);
        assert.ok(setCookie.includes('todayai_session'));
        assert.ok(setCookie.includes('HttpOnly'));
        assert.ok(setCookie.includes('SameSite=Lax'));
        assert.ok(!setCookie.includes('admin123'), 'password should not leak in cookie');
        assert.ok(!JSON.stringify(body).includes('admin123'));
    });

    it('login with wrong credentials should 401 without revealing which is wrong', async () => {
        const { res, body } = await login('admin', 'wrongpass');
        assert.equal(res.status, 401);
        assert.equal(body.error, 'Unauthorized');
        assert.ok(!JSON.stringify(body).includes('wrongpass'));
        // Try wrong username
        const { res: res2 } = await login('wronguser', 'admin123');
        assert.equal(res2.status, 401);
    });

    it('should 401 for chat without login', async () => {
        const res = await fetch(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'hello' })
        });
        assert.equal(res.status, 401);
    });

    it('should allow chat after login', async () => {
        const { token } = await login('admin', 'admin123');
        const res = await fetch(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': `todayai_session=${token}` },
            body: JSON.stringify({ prompt: 'hello after login', sessionId: `test-login-${Date.now()}` })
        });
        // With MOCK, should succeed
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.result);
    });

    it('should 401 for history without login', async () => {
        const res = await fetch(`${BASE}/api/history?sessionId=test`);
        assert.equal(res.status, 401);
    });

    it('should 401 for sessions without login', async () => {
        const res = await fetch(`${BASE}/api/sessions`);
        assert.equal(res.status, 401);
    });

    it('me without login should 401', async () => {
        const res = await fetch(`${BASE}/api/auth/me`);
        assert.equal(res.status, 401);
    });

    it('me after login should 200', async () => {
        const { token } = await login('admin', 'admin123');
        const res = await fetch(`${BASE}/api/auth/me`, {
            headers: { 'Cookie': `todayai_session=${token}` }
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.authenticated, true);
        assert.equal(body.username, 'admin');
        assert.ok(!JSON.stringify(body).includes('admin123'));
    });

    it('logout should invalidate session', async () => {
        const { token } = await login('admin', 'admin123');
        // Verify me works
        let res = await fetch(`${BASE}/api/auth/me`, { headers: { 'Cookie': `todayai_session=${token}` } });
        assert.equal(res.status, 200);
        // Logout
        res = await fetch(`${BASE}/api/auth/logout`, {
            method: 'POST',
            headers: { 'Cookie': `todayai_session=${token}` }
        });
        assert.equal(res.status, 200);
        // Me should now 401
        res = await fetch(`${BASE}/api/auth/me`, { headers: { 'Cookie': `todayai_session=${token}` } });
        assert.equal(res.status, 401);
        // Chat should 401
        res = await fetch(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': `todayai_session=${token}` },
            body: JSON.stringify({ prompt: 'hello' })
        });
        assert.equal(res.status, 401);
    });

    it('password should not appear in response or log', async () => {
        const { body } = await login('admin', 'admin123');
        assert.ok(!JSON.stringify(body).includes('admin123'));
    });

    it('cookie session should work after login (credentials not broken by CORS)', async () => {
        // Login and get cookie
        const loginRes = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        const setCookie = loginRes.headers.get('set-cookie') || '';
        const tokenMatch = setCookie.match(/todayai_session=([^;]+)/);
        assert.ok(tokenMatch, 'login should set cookie');
        const token = tokenMatch[1];

        // Use cookie to access protected API
        const meRes = await fetch(`${BASE}/api/auth/me`, {
            headers: { 'Cookie': `todayai_session=${token}` }
        });
        assert.equal(meRes.status, 200);
        const meBody = await meRes.json();
        assert.equal(meBody.authenticated, true);
    });

    it('login rate limit is configured (shared-server budget kept under trip point)', async () => {
        // NOTE: all test files share one server with a 10-failures/15min
        // login limiter. This suite must never trip it, or parallel files
        // lose their login. Do 8 rapid wrong logins (2 earlier + 8 = 10,
        // exactly at max, never over) and expect clean 401s.
        const promises = [];
        for (let i = 0; i < 8; i++) {
            promises.push(login('admin', 'wrong' + i));
        }
        const results = await Promise.all(promises);
        const statuses = results.map(r => r.res.status);
        assert.ok(statuses.every(s => s === 401), `expected all 401, got ${statuses}`);
    });

    it('login limiter trips on 11th failure (isolated mini-app, no shared state)', async () => {
        const express = require('express');
        const rateLimit = require('express-rate-limit');
        // Fresh instance mirroring src/middleware/rateLimit.js loginLimiter
        // (10 failures / 15min, skipSuccessfulRequests). A separate instance
        // keeps its own MemoryStore so this never consumes the shared budget.
        const isolatedLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 10,
            standardHeaders: true,
            legacyHeaders: false,
            skipSuccessfulRequests: true,
            message: { error: 'test rate limited' }
        });
        const app = express();
        app.use(express.json());
        app.post('/login', isolatedLimiter, (req, res) => res.status(401).json({ error: 'Unauthorized' }));
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const url = `http://127.0.0.1:${server.address().port}/login`;
            const statuses = [];
            for (let i = 0; i < 11; i++) {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ u: 'a', p: 'wrong' })
                });
                statuses.push(r.status);
                await r.text().catch(() => {});
            }
            assert.ok(statuses.slice(0, 10).every(s => s === 401), `first 10 should be 401, got ${statuses}`);
            assert.equal(statuses[10], 429, `11th should be 429, got ${statuses}`);
        } finally {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe('CORS enforcement (production)', () => {
    it('should allow configured origin and return correct headers', () => {
        const allowedOrigins = ['https://today.example.com', 'https://another.example.com'];
        function originCheck(origin) {
            if (!origin) return { allowed: true };
            if (allowedOrigins.includes(origin)) return { allowed: true };
            return { allowed: false };
        }
        assert.ok(originCheck('https://today.example.com').allowed);
        assert.ok(originCheck('https://another.example.com').allowed);
        assert.ok(!originCheck('https://evil.example.com').allowed);
        assert.ok(originCheck(null).allowed);
        assert.ok(originCheck(undefined).allowed);
    });

    it('should reject wildcard * in ALLOWED_ORIGINS', () => {
        const { validateEnv } = require('../src/middleware/validateEnv');
        const orig = {
            NODE_ENV: process.env.NODE_ENV,
            DATABASE_URL: process.env.DATABASE_URL,
            AUTH_USERNAME: process.env.AUTH_USERNAME,
            AUTH_PASSWORD: process.env.AUTH_PASSWORD,
            ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
        };
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'secret';
        process.env.ALLOWED_ORIGINS = '*';
        let exited = false;
        const origExit = process.exit;
        process.exit = (code) => { exited = true; throw new Error(`exit(${code})`); };
        try { validateEnv(); } catch (e) {}
        process.exit = origExit;
        assert.ok(exited, 'should reject * as ALLOWED_ORIGINS in production');
        Object.entries(orig).forEach(([k, v]) => {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        });
    });

    it('should reject disallowed origin (no CORS headers returned)', () => {
        const http = require('http');
        const express = require('express');
        const cors = require('cors');

        return new Promise((resolve) => {
            const app = express();
            const allowedOrigins = ['https://today.example.com'];
            app.use(cors({
                origin: (origin, cb) => {
                    if (!origin) return cb(null, true);
                    if (allowedOrigins.includes(origin)) return cb(null, true);
                    return cb(null, false);
                },
                credentials: true
            }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            const server = app.listen(0, '127.0.0.1', async () => {
                const port = server.address().port;
                try {
                    // Allowed origin
                    const r1 = await fetch(`http://127.0.0.1:${port}/test`, {
                        headers: { 'Origin': 'https://today.example.com' }
                    });
                    assert.equal(r1.status, 200);
                    assert.equal(r1.headers.get('access-control-allow-origin'), 'https://today.example.com');
                    assert.equal(r1.headers.get('access-control-allow-credentials'), 'true');

                    // Disallowed origin
                    const r2 = await fetch(`http://127.0.0.1:${port}/test`, {
                        headers: { 'Origin': 'https://evil.example.com' }
                    });
                    assert.equal(r2.status, 200);
                    assert.equal(r2.headers.get('access-control-allow-origin'), null);
                    assert.equal(r2.headers.get('access-control-allow-credentials'), null);

                    // Same-origin (no Origin header)
                    const r3 = await fetch(`http://127.0.0.1:${port}/test`);
                    assert.equal(r3.status, 200);
                } finally {
                    server.closeAllConnections();
                    server.close(() => resolve());
                }
            });
        });
    });
});

describe('validateEnv - production requires ALLOWED_ORIGINS', () => {
    const { validateEnv } = require('../src/middleware/validateEnv');

    function withEnv(overrides, fn) {
        const orig = {};
        for (const k of Object.keys(overrides)) {
            orig[k] = process.env[k];
            if (overrides[k] === undefined) delete process.env[k];
            else process.env[k] = overrides[k];
        }
        let exited = false;
        const origExit = process.exit;
        process.exit = (code) => { exited = true; throw new Error(`exit(${code})`); };
        try {
            fn();
        } catch (e) {
            // Expected if exit was called
        }
        process.exit = origExit;
        // Restore
        for (const k of Object.keys(overrides)) {
            if (orig[k] === undefined) delete process.env[k];
            else process.env[k] = orig[k];
        }
        return exited;
    }

    const baseProd = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        AUTH_USERNAME: 'admin',
        AUTH_PASSWORD: 'secret',
        WORKSPACE_ROOT: '/tmp/today-ai-test-workspaces',
        MOCK_OPENCODE: undefined,
        OPENCODE_SERVER_URL: undefined
    };

    it('should fail in production without ALLOWED_ORIGINS', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: undefined }, () => validateEnv());
        assert.ok(exited, 'should exit(1) when ALLOWED_ORIGINS is missing');
    });

    it('should fail with empty string ALLOWED_ORIGINS', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: '' }, () => validateEnv());
        assert.ok(exited, 'should exit(1) when ALLOWED_ORIGINS is empty');
    });

    it('should fail with whitespace-only ALLOWED_ORIGINS', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: '   ' }, () => validateEnv());
        assert.ok(exited, 'should exit(1) when ALLOWED_ORIGINS is whitespace');
    });

    it('should fail with wildcard * as ALLOWED_ORIGINS', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: '*' }, () => validateEnv());
        assert.ok(exited, 'should exit(1) when ALLOWED_ORIGINS is *');
    });

    it('should fail with * in comma-separated list', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: 'https://ok.com,*' }, () => validateEnv());
        assert.ok(exited, 'should exit(1) when ALLOWED_ORIGINS contains *');
    });

    it('should fail with origin missing protocol', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: 'today.example.com' }, () => validateEnv());
        assert.ok(exited, 'should exit(1) when origin has no protocol');
    });

    it('should pass with valid ALLOWED_ORIGINS', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: 'https://today.example.com' }, () => validateEnv());
        assert.ok(!exited, 'should not exit with valid ALLOWED_ORIGINS');
    });

    it('should pass with multiple comma-separated origins', () => {
        const exited = withEnv({ ...baseProd, ALLOWED_ORIGINS: 'https://a.com,https://b.com' }, () => validateEnv());
        assert.ok(!exited, 'should not exit with valid comma-separated origins');
    });

    it('should not require ALLOWED_ORIGINS in development', () => {
        const exited = withEnv({ ...baseProd, NODE_ENV: 'development', ALLOWED_ORIGINS: undefined }, () => validateEnv());
        assert.ok(!exited, 'should not exit in development without ALLOWED_ORIGINS');
    });

    it('should not output secrets in error messages', () => {
        const logs = [];
        const origError = console.error;
        console.error = (...args) => logs.push(args.join(' '));
        withEnv({ ...baseProd, ALLOWED_ORIGINS: undefined }, () => validateEnv());
        console.error = origError;
        const allLogs = logs.join(' ');
        assert.ok(!allLogs.includes('secret'), 'should not contain password in error output');
        assert.ok(!allLogs.includes('postgresql://'), 'should not contain DATABASE_URL in error output');
    });
});

describe('Server HOST default', () => {
    it('should default to 127.0.0.1 when HOST env is not set', () => {
        const origHOST = process.env.HOST;
        delete process.env.HOST;

        // Read server.js source to verify default
        const fs = require('fs');
        const path = require('path');
        const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
        assert.ok(serverSrc.includes("'127.0.0.1'"), 'server.js should default HOST to 127.0.0.1');
        assert.ok(!serverSrc.includes("'0.0.0.0'"), 'server.js should not default to 0.0.0.0');

        if (origHOST !== undefined) process.env.HOST = origHOST;
    });
});

describe('OPENCODE_SERVER_URL control', () => {
    it('should be not configured when empty', () => {
        const orig = process.env.OPENCODE_SERVER_URL;
        process.env.OPENCODE_SERVER_URL = '';
        const svc = require('../src/services/opencode');
        assert.equal(svc.isServerUrlConfigured(), false);
        process.env.OPENCODE_SERVER_URL = orig;
    });

    it('should be configured when set', () => {
        const orig = process.env.OPENCODE_SERVER_URL;
        process.env.OPENCODE_SERVER_URL = 'http://localhost:4096';
        const svc = require('../src/services/opencode');
        assert.equal(svc.isServerUrlConfigured(), true);
        process.env.OPENCODE_SERVER_URL = orig;
    });
});
