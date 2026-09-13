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

    it('Vercel catch-all api/[...all].js exports same handler (parity)', async () => {
        const handlerAll = require('../api/[...all].js');
        const handlerIndex = require('../api/index.js');
        // Both should be functions handling (req,res)
        assert.equal(typeof handlerAll, 'function');
        assert.equal(typeof handlerIndex, 'function');
        // Functional parity: GET /api/health via [...all] also 200
        const http2 = require('http');
        const s2 = http2.createServer((req, res) => handlerAll(req, res));
        await new Promise((r) => s2.listen(0, '127.0.0.1', r));
        const base2 = `http://127.0.0.1:${s2.address().port}`;
        try {
            const r = await fetch(`${base2}/api/health`);
            assert.equal(r.status, 200);
            const r2 = await fetch(`${base2}/api/auth/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'x', password: 'y' })
            });
            assert.notEqual(r2.status, 404);
        } finally {
            if (s2.closeAllConnections) s2.closeAllConnections();
            await new Promise((r) => s2.close(r));
        }
    });
});
