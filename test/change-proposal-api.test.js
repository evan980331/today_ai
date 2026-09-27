// P3-7 proposal HTTP API tests. Boots a real express app mounting the
// route with a stub auth (mirrors authMiddleware's contract: req.user or
// 401 at the route), real ToolRegistry + proposal service, temp workspaces.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const proposals = require('../src/services/changeProposalService');
const changeProposalsRouter = require('../src/routes/changeProposals');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p37f-test-${Date.now()}-${(n += 1)}`;

let server = null;
let baseUrl = '';

async function writeFixture(root, rel, content) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
}

async function makeWs(owner = 'alice', files = {}) {
    const ws = await WorkspaceService.default().create({ sessionId: sid(), owner });
    for (const [rel, content] of Object.entries(files)) {
        await writeFixture(ws.rootPath, rel, content);
    }
    return ws;
}

const api = (p, opts = {}) => fetch(`${baseUrl}${p}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.user === null ? {} : { 'x-test-user': opts.user || 'alice' }), ...(opts.headers || {}) },
    ...opts.fetch
});

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-propapi-test-'));
    process.env.WORKSPACE_ROOT = ROOT;
    resetSharedMemoryForTests();
    registerNativeTools(toolRegistry);

    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use('/api', (req, res, next) => {
        const u = req.headers['x-test-user'];
        if (u) req.user = { username: String(u) };
        next();
    });
    app.use('/api', changeProposalsRouter);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (SAVED_ROOT === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = SAVED_ROOT;
    if (SAVED_DB_URL !== undefined) process.env.DATABASE_URL = SAVED_DB_URL;
    resetSharedMemoryForTests();
    if (ROOT) await fsp.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    proposals._clearForTests();
});

describe('P3-7 proposal API', () => {
    it('1 GET returns proposal with diffs', async () => {
        const ws = await makeWs('alice', { 'a.js': 'old\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'new\n' }] });
        const res = await api(`/api/change-proposals/${p.proposalId}`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.proposalId, p.proposalId);
        assert.equal(data.status, 'pending');
        assert.ok(data.changes[0].diff.includes('-old'));
        assert.ok(!('rootPath' in data));
        assert.ok(JSON.stringify(data).includes('a.js'));
    });
    it('2 GET unknown id is 404 with code', async () => {
        const res = await api('/api/change-proposals/prop_00000000000000000000000000000000');
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.ok(data.code === 'PROPOSAL_NOT_FOUND' || data.causeCode === 'PROPOSAL_NOT_FOUND');
    });
    it('3 GET without user is 401', async () => {
        const res = await api('/api/change-proposals/prop_x', { user: null });
        assert.equal(res.status, 401);
    });
    it('4 apply without user is 401 and changes nothing', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const res = await api(`/api/change-proposals/${p.proposalId}/apply`, { user: null, fetch: { method: 'POST', body: JSON.stringify({}) } });
        assert.equal(res.status, 401);
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
    it('5 apply approves the exact proposal', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const res = await api(`/api/change-proposals/${p.proposalId}/apply`, { fetch: { method: 'POST', body: JSON.stringify({ sessionId: ws.sessionId }) } });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.status, 'applied');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'y\n');
    });
    it('6 second apply fails (not pending)', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        await api(`/api/change-proposals/${p.proposalId}/apply`, { fetch: { method: 'POST', body: '{}' } });
        const res = await api(`/api/change-proposals/${p.proposalId}/apply`, { fetch: { method: 'POST', body: '{}' } });
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.code, 'PROPOSAL_NOT_PENDING');
    });
    it('7 reject marks rejected and writes nothing', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const res = await api(`/api/change-proposals/${p.proposalId}/reject`, { fetch: { method: 'POST', body: '{}' } });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).status, 'rejected');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
    it('8 stale apply surfaces the code', async () => {
        const ws = await makeWs('alice', { 'a.js': 'v1\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'v2\n' }] });
        await writeFixture(ws.rootPath, 'a.js', 'external\n');
        const res = await api(`/api/change-proposals/${p.proposalId}/apply`, { fetch: { method: 'POST', body: '{}' } });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, 'PROPOSAL_STALE');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'external\n');
    });
    it('9 cross-owner access is 404', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const get = await api(`/api/change-proposals/${p.proposalId}`, { user: 'bob' });
        assert.equal(get.status, 404);
        const apply = await api(`/api/change-proposals/${p.proposalId}/apply`, { user: 'bob', fetch: { method: 'POST', body: '{}' } });
        assert.equal(apply.status, 404);
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
    it('10 client-supplied owner is ignored', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const res = await api(`/api/change-proposals/${p.proposalId}/apply`, { fetch: { method: 'POST', body: JSON.stringify({ owner: 'bob', rootPath: '/tmp' }) } });
        assert.equal(res.status, 200);
        assert.equal((await proposals.get({ proposalId: p.proposalId, owner: 'alice' })).owner, 'alice');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'y\n');
    });
    it('11 wrong session is rejected', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const created = await proposals.propose({ workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const res = await api(`/api/change-proposals/${created.proposalId}?sessionId=nope`, { fetch: {} });
        assert.equal(res.status, 404);
    });
    it('12 response never leaks server paths or secrets', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const data = await (await api(`/api/change-proposals/${p.proposalId}`)).json();
        const text = JSON.stringify(data);
        assert.ok(!text.includes(ws.rootPath));
        assert.ok(!text.includes('DATABASE_URL'));
        assert.ok(!('env' in data));
    });
});
