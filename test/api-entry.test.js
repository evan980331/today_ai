// Vercel entrypoint regression test (GET / 500 FUNCTION_INVOCATION_FAILED).
// Exercises api/index.js through the exact serverless calling convention:
// a plain Node (req, res) pair via http.createServer — no app.listen(),
// no spawn, no extra env. Asserts `/` serves the frontend and unknown
// static paths (e.g. /favicon.ico) fail as 404, never 500.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

describe('Vercel api entrypoint', () => {
    let server = null;
    let base = null;

    before(async () => {
        const handler = require('../api/index.js');
        server = http.createServer((req, res) => handler(req, res));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            server = null;
        }
    });

    it('GET / serves the frontend with 200 (not 500)', async () => {
        const res = await fetch(`${base}/`);
        assert.equal(res.status, 200);
        assert.ok((res.headers.get('content-type') || '').includes('text/html'));
        const body = await res.text();
        assert.ok(body.includes('Today AI'), 'index should render the app shell');
    });

    it('GET /favicon.ico is 404, never 500', async () => {
        const res = await fetch(`${base}/favicon.ico`);
        assert.notEqual(res.status, 500);
        assert.equal(res.status, 404);
        await res.text().catch(() => {});
    });

    it('GET /api/health stays JSON ok through the adapter', async () => {
        const res = await fetch(`${base}/api/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'ok');
    });

    it('POST /api/auth/login is routed (not 404), wrong creds -> 401', async () => {
        const res = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'nope', password: 'wrong' })
        });
        assert.notEqual(res.status, 404, 'login route must be registered');
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.error, 'Unauthorized');
    });

    it('POST /api/auth/logout is routed (not 404)', async () => {
        const res = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
        assert.notEqual(res.status, 404, 'logout route must be registered');
        // without cookie it still returns 200 (clears cookie)
        assert.equal(res.status, 200);
    });

    it('GET /api/auth/me without session is 401 not 404', async () => {
        const res = await fetch(`${base}/api/auth/me`);
        assert.notEqual(res.status, 404);
        assert.equal(res.status, 401);
    });

    it('POST /api/auth/login with valid user reaches handler (real DB user)', async () => {
        const db = require('../src/db/db');
        const { hashPassword } = require('../src/services/password');
        if (!db.getSql()) {
            // no DB in this env — skip (handled by other 401 test)
            return;
        }
        const hash = hashPassword('testpass123');
        await db.upsertAuthUser({ username: 'mockuser', passwordHash: hash });
        try {
            const res = await fetch(`${base}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'mockuser', password: 'testpass123' })
            });
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.ok, true);
            assert.equal(body.username, 'mockuser');
        } finally {
            await db.deleteAuthUser('mockuser').catch(() => {});
        }
    });

    it('Vercel rewrite /api/:path* -> /api preserves routing via handler', async () => {
        // Simulate Vercel rewrites where req.url is mutated to /api but original
        // path is in x-matched-path header. Handler must restore it.
        const handler = require('../api/index.js');
        const http2 = require('http');
        const s2 = http2.createServer((req, res) => handler(req, res));
        await new Promise((r) => s2.listen(0, '127.0.0.1', r));
        const base2 = `http://127.0.0.1:${s2.address().port}`;
        try {
            // Direct routing (no rewrite) — baseline
            const r = await fetch(`${base2}/api/health`);
            assert.equal(r.status, 200);
            // Simulated rewrite: request arrives as /api but header carries original
            const r2 = await new Promise((resolve, reject) => {
                const opts = {
                    hostname: '127.0.0.1',
                    port: new URL(base2).port,
                    path: '/api',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-matched-path': '/api/auth/login'
                    }
                };
                const req2 = http2.request(opts, (res2) => {
                    let d = '';
                    res2.on('data', (c) => d += c);
                    res2.on('end', () => resolve({ status: res2.statusCode, body: d }));
                });
                req2.on('error', reject);
                req2.write(JSON.stringify({ username: 'x', password: 'y' }));
                req2.end();
            });
            // Should be routed to login (401), not 404
            assert.notEqual(r2.status, 404, 'rewritten login must not be 404');
            assert.equal(r2.status, 401);
            // health via rewrite header
            const r3 = await new Promise((resolve, reject) => {
                const opts = {
                    hostname: '127.0.0.1',
                    port: new URL(base2).port,
                    path: '/api',
                    method: 'GET',
                    headers: { 'x-matched-path': '/api/health' }
                };
                const req3 = http2.request(opts, (res3) => {
                    let d = '';
                    res3.on('data', (c) => d += c);
                    res3.on('end', () => resolve({ status: res3.statusCode, body: d }));
                });
                req3.on('error', reject);
                req3.end();
            });
            assert.equal(r3.status, 200, 'rewritten health must be 200');
        } finally {
            if (s2.closeAllConnections) s2.closeAllConnections();
            await new Promise((r) => s2.close(r));
        }
    });
});
