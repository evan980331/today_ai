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
});
