// P3-1 Workspace Management tests.
// Service tests use a temp WORKSPACE_ROOT + memory store (no DB needed).
// DB round-trip runs only when DATABASE_URL is configured, else skipped.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { WorkspaceService } = require('../src/services/workspaceService');
const { MemoryWorkspaceStore } = require('../src/services/workspaceStore');
const { getWorkspaceRoot } = require('../src/services/workspace');

let ROOT = null;
let SAVED_ROOT;

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-ws-test-'));
    process.env.WORKSPACE_ROOT = ROOT;
});

after(async () => {
    if (SAVED_ROOT === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = SAVED_ROOT;
    if (ROOT) await fsp.rm(ROOT, { recursive: true, force: true });
});

const svc = () => new WorkspaceService(new MemoryWorkspaceStore());
let n = 0;
const sid = () => `p31-test-${Date.now()}-${(n += 1)}`;

describe('P3-1 lifecycle', () => {
    it('create returns full entity', async () => {
        const s = svc();
        const ws = await s.create({ sessionId: sid(), owner: 'alice' });
        assert.ok(/^ws_[0-9a-f]{16}$/.test(ws.workspaceId));
        assert.equal(ws.status, 'active');
        assert.equal(ws.repository, null);
        assert.ok(ws.rootPath);
        assert.ok(ws.createdAt && ws.updatedAt);
        assert.ok(fs.existsSync(ws.rootPath));
    });
    it('create is idempotent per active session', async () => {
        const s = svc();
        const id = sid();
        const a = await s.create({ sessionId: id, owner: 'alice' });
        const b = await s.create({ sessionId: id, owner: 'alice' });
        assert.equal(a.workspaceId, b.workspaceId);
    });
    it('getById returns workspace; unknown -> 404', async () => {
        const s = svc();
        const ws = await s.create({ sessionId: sid(), owner: 'alice' });
        assert.equal((await s.getById(ws.workspaceId, 'alice')).workspaceId, ws.workspaceId);
        await assert.rejects(() => s.getById('ws_deadbeefdeadbeef', 'alice'), (e) => e.status === 404);
    });
    it('getCurrent returns active; none -> 404', async () => {
        const s = svc();
        const id = sid();
        await assert.rejects(() => s.getCurrent(id, 'alice'), (e) => e.status === 404);
        const ws = await s.create({ sessionId: id, owner: 'alice' });
        assert.equal((await s.getCurrent(id, 'alice')).workspaceId, ws.workspaceId);
    });
    it('update repository + status', async () => {
        const s = svc();
        const ws = await s.create({ sessionId: sid(), owner: 'alice' });
        const repo = { provider: 'github', owner: 'octo', name: 'repo', ref: 'main' };
        const u1 = await s.update(ws.workspaceId, 'alice', { repository: repo });
        assert.deepEqual(u1.repository, repo);
        const u2 = await s.update(ws.workspaceId, 'alice', { status: 'archived' });
        assert.equal(u2.status, 'archived');
        await assert.rejects(() => s.update(ws.workspaceId, 'alice', { status: 'nope' }), (e) => e.status === 400);
    });
    it('update rejects rootPath and immutable ids', async () => {
        const s = svc();
        const ws = await s.create({ sessionId: sid(), owner: 'alice' });
        await assert.rejects(() => s.update(ws.workspaceId, 'alice', { rootPath: '/tmp/x' }), (e) => e.status === 400);
        await assert.rejects(() => s.update(ws.workspaceId, 'alice', { sessionId: 'other' }), (e) => e.status === 400);
    });
    it('archive flips status, keeps dir, idempotent', async () => {
        const s = svc();
        const ws = await s.create({ sessionId: sid(), owner: 'alice' });
        const a1 = await s.archive(ws.workspaceId, 'alice');
        assert.equal(a1.status, 'archived');
        assert.ok(fs.existsSync(ws.rootPath), 'archive must not delete the directory');
        const a2 = await s.archive(ws.workspaceId, 'alice');
        assert.equal(a2.status, 'archived');
        await assert.rejects(() => s.getCurrent(ws.sessionId, 'alice'), (e) => e.status === 404);
    });
    it('archive unknown -> 404', async () => {
        const s = svc();
        await assert.rejects(() => s.archive('ws_deadbeefdeadbeef', 'alice'), (e) => e.status === 404);
    });
    it('new create after archive gets a different id', async () => {
        const s = svc();
        const id = sid();
        const a = await s.create({ sessionId: id, owner: 'alice' });
        await s.archive(a.workspaceId, 'alice');
        const b = await s.create({ sessionId: id, owner: 'alice' });
        assert.notEqual(a.workspaceId, b.workspaceId);
    });
});

describe('P3-1 isolation', () => {
    it('different sessions get different workspaceIds', async () => {
        const s = svc();
        const a = await s.create({ sessionId: sid(), owner: 'alice' });
        const b = await s.create({ sessionId: sid(), owner: 'alice' });
        assert.notEqual(a.workspaceId, b.workspaceId);
    });
    it('sessions never see each other workspaces', async () => {
        const s = svc();
        const a = await s.create({ sessionId: sid(), owner: 'alice' });
        const otherSid = sid();
        await assert.rejects(() => s.getCurrent(a.sessionId, 'alice').then((w) => {
            if (w.sessionId === otherSid) throw new Error('leak');
            return s.getCurrent(otherSid, 'alice');
        }), (e) => e.status === 404);
    });
    it('cross-owner reads look like 404', async () => {
        const s = svc();
        const ws = await s.create({ sessionId: sid(), owner: 'alice' });
        await assert.rejects(() => s.getById(ws.workspaceId, 'bob'), (e) => e.status === 404);
        await assert.rejects(() => s.getCurrent(ws.sessionId, 'bob'), (e) => e.status === 404);
        await assert.rejects(() => s.archive(ws.workspaceId, 'bob'), (e) => e.status === 404);
    });
});

describe('P3-1 validation + path safety', () => {
    it('invalid workspaceId rejected', async () => {
        const s = svc();
        for (const bad of ['', null, '..', '../x', 'a/b', 123]) {
            await assert.rejects(() => s.getById(bad, 'alice'), (e) => e.status === 400 || e.status === 404, String(bad));
        }
    });
    it('traversal sessionId rejected', async () => {
        const s = svc();
        await assert.rejects(() => s.create({ sessionId: '../../etc', owner: 'alice' }), (e) => e.status === 400);
        await assert.rejects(() => s.create({ sessionId: '', owner: 'alice' }), (e) => e.status === 400);
    });
    it('rootPath is derived inside WORKSPACE_ROOT', async () => {
        const s = svc();
        const ws = await s.create({ sessionId: sid(), owner: 'alice' });
        const root = getWorkspaceRoot();
        const rel = path.relative(root, ws.rootPath);
        assert.ok(rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
        assert.ok(!ws.rootPath.includes('..'));
    });
    it('repository metadata round-trips; invalid shapes rejected', async () => {
        const s = svc();
        const ws = await s.create({
            sessionId: sid(), owner: 'alice',
            repository: { provider: 'github', owner: 'o', name: 'r' }
        });
        assert.deepEqual(ws.repository, { provider: 'github', owner: 'o', name: 'r', ref: null });
        await assert.rejects(() => s.create({ sessionId: sid(), owner: 'alice', repository: { provider: 'github' } }), (e) => e.status === 400);
        await assert.rejects(() => s.create({ sessionId: sid(), owner: 'alice', repository: { provider: 'g', owner: 'o', name: 'r', ref: 'a b' } }), (e) => e.status === 400);
        await assert.rejects(() => s.create({ sessionId: sid(), owner: 'alice', repository: 'nope' }), (e) => e.status === 400);
    });
});

describe('P3-1 HTTP routes (stub auth)', () => {
    let server = null;
    let base = null;
    let savedDbUrl;
    before(async () => {
        // Force the memory store for route-logic tests: no DB table needed,
        // deterministic without network. Restored afterwards for DB suite.
        savedDbUrl = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;
        const express = require('express');
        const router = require('../src/routes/workspaces');
        const app = express();
        app.use(express.json({ limit: '100kb' }));
        app.use((req, res, next) => {
            req.user = { username: req.headers['x-test-user'] || 'alice' };
            next();
        });
        app.use('/api', router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((r) => server.close(r));
        }
    });
    const call = (user, method, p, body) => fetch(`${base}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-user': user },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

    it('POST /api/workspaces creates (201) + GET current', async () => {
        const id = sid();
        const c = await call('alice', 'POST', '/api/workspaces', { sessionId: id });
        assert.equal(c.status, 201);
        assert.ok(c.body.workspaceId);
        const g = await call('alice', 'GET', `/api/workspaces/current?sessionId=${id}`);
        assert.equal(g.status, 200);
        assert.equal(g.body.workspaceId, c.body.workspaceId);
    });
    it('GET /api/workspaces/:id + cross-owner 404', async () => {
        const c = await call('alice', 'POST', '/api/workspaces', { sessionId: sid() });
        assert.equal((await call('alice', 'GET', `/api/workspaces/${c.body.workspaceId}`)).status, 200);
        const b = await call('bob', 'GET', `/api/workspaces/${c.body.workspaceId}`);
        assert.equal(b.status, 404);
    });
    it('PATCH updates repository; rejects rootPath', async () => {
        const c = await call('alice', 'POST', '/api/workspaces', { sessionId: sid() });
        const p = await call('alice', 'PATCH', `/api/workspaces/${c.body.workspaceId}`, { repository: { provider: 'github', owner: 'o', name: 'r' } });
        assert.equal(p.status, 200);
        assert.equal(p.body.repository.name, 'r');
        const bad = await call('alice', 'PATCH', `/api/workspaces/${c.body.workspaceId}`, { rootPath: '/tmp' });
        assert.equal(bad.status, 400);
    });
    it('POST /:id/archive archives, idempotent, keeps dir', async () => {
        const c = await call('alice', 'POST', '/api/workspaces', { sessionId: sid() });
        const a1 = await call('alice', 'POST', `/api/workspaces/${c.body.workspaceId}/archive`);
        assert.equal(a1.status, 200);
        assert.equal(a1.body.status, 'archived');
        const a2 = await call('alice', 'POST', `/api/workspaces/${c.body.workspaceId}/archive`);
        assert.equal(a2.status, 200);
        assert.ok(fs.existsSync(c.body.rootPath));
    });
    it('different sessions isolated over HTTP', async () => {
        const a = await call('alice', 'POST', '/api/workspaces', { sessionId: sid() });
        const b = await call('alice', 'POST', '/api/workspaces', { sessionId: sid() });
        assert.notEqual(a.body.workspaceId, b.body.workspaceId);
    });
    it('invalid sessionId rejected over HTTP', async () => {
        const r = await call('alice', 'POST', '/api/workspaces', { sessionId: '../../x' });
        assert.equal(r.status, 400);
    });
});

describe('P3-1 HTTP auth wiring (real app)', () => {
    let server = null;
    let base = null;
    before(async () => {
        const handler = require('../api/index.js');
        server = http.createServer((req, res) => handler(req, res));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((r) => server.close(r));
        }
    });
    it('unauthenticated workspace routes require login', async () => {
        // Auth is configured in this repo (login exists); without a session
        // cookie the router behind authMiddleware must refuse.
        const r1 = await fetch(`${base}/api/workspaces/current?sessionId=x`);
        assert.ok([401, 403].includes(r1.status), `got ${r1.status}`);
        const r2 = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.ok([401, 403].includes(r2.status), `got ${r2.status}`);
    });
});

describe('P3-1 DB store (skipped without DATABASE_URL)', () => {
    it('db round-trip create/get/update/archive', async (t) => {
        if (!process.env.DATABASE_URL) return t.skip('no DATABASE_URL');
        const db = require('../src/db/db');
        await db.initDb();
        const { DbWorkspaceStore } = require('../src/services/workspaceStore');
        const store = new DbWorkspaceStore();
        const id = `ws_t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
        const sidv = sid();
        const created = await store.create({ workspaceId: id, sessionId: sidv, owner: 'alice', repository: null, rootPath: ROOT, status: 'active' });
        assert.ok(created, 'row created');
        try {
            assert.equal((await store.getById(id)).sessionId, sidv);
            assert.equal((await store.getActiveBySession(sidv, 'alice')).workspaceId, id);
            const repo = { provider: 'github', owner: 'o', name: 'r', ref: null };
            assert.deepEqual((await store.update(id, { repository: repo })).repository, repo);
            assert.equal((await store.update(id, { status: 'archived' })).status, 'archived');
            assert.equal(await store.getActiveBySession(sidv, 'alice'), null);
        } finally {
            await db.deleteWorkspaceRow(id);
        }
    });
});
