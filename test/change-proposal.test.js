// P3-7 Change Proposal service + tool tests.
//
// Service tests use temporary fixture workspaces (never the real repo).
// Tool tests use the REAL ToolRegistry with real proposal tools.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const proposals = require('../src/services/changeProposalService');
const fsClient = require('../src/services/filesystem/client');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p37-test-${Date.now()}-${(n += 1)}`;
const APPROVED = { approval: { status: 'approved' } };

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

const baseInput = (ws, changes) => ({ workspaceId: ws.workspaceId, owner: 'alice', changes });

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-prop-test-'));
    process.env.WORKSPACE_ROOT = ROOT;
    resetSharedMemoryForTests();
});

after(async () => {
    if (SAVED_ROOT === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = SAVED_ROOT;
    if (SAVED_DB_URL !== undefined) process.env.DATABASE_URL = SAVED_DB_URL;
    resetSharedMemoryForTests();
    if (ROOT) await fsp.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    toolRegistry._clearForTests();
    proposals._clearForTests();
});

describe('P3-7 proposal creation', () => {
    it('1 create update proposal with diff', async () => {
        const ws = await makeWs('alice', { 'a.js': 'old\n' });
        const out = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'new\n' }]));
        assert.ok(/^prop_[0-9a-f]{32}$/.test(out.proposalId));
        assert.equal(out.status, 'pending');
        assert.equal(out.workspaceId, ws.workspaceId);
        assert.equal(out.owner, 'alice');
        assert.equal(out.changes.length, 1);
        assert.equal(out.changes[0].operation, 'update');
        assert.equal(out.changes[0].oldContent, 'old\n');
        assert.equal(out.changes[0].newContent, 'new\n');
        assert.ok(out.changes[0].diff.includes('--- a/a.js'));
        assert.ok(out.changes[0].diff.includes('+++ b/a.js'));
        assert.ok(out.changes[0].diff.includes('-old'));
        assert.ok(out.changes[0].diff.includes('+new'));
    });
    it('2 create-file proposal has null oldContent', async () => {
        const ws = await makeWs('alice');
        const out = await proposals.propose(baseInput(ws, [{ path: 'new.js', content: 'hi\n' }]));
        assert.equal(out.changes[0].operation, 'create');
        assert.equal(out.changes[0].oldContent, null);
    });
    it('3 delete proposal has null newContent', async () => {
        const ws = await makeWs('alice', { 'gone.js': 'x\n' });
        const out = await proposals.propose(baseInput(ws, [{ path: 'gone.js', content: null }]));
        assert.equal(out.changes[0].operation, 'delete');
        assert.equal(out.changes[0].newContent, null);
    });
    it('4 deterministic diff', async () => {
        const ws = await makeWs('alice', { 'a.js': 'old\n' });
        const a = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'new\n' }]));
        const b = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'new\n' }]));
        assert.equal(a.changes[0].diff, b.changes[0].diff);
        assert.notEqual(a.proposalId, b.proposalId);
        const d = proposals.buildDiff('f.txt', 'a\n', 'b\n');
        assert.ok(d.startsWith('--- a/f.txt\n+++ b/f.txt\n@@'));
    });
    it('5 proposing has no side effects', async () => {
        const ws = await makeWs('alice', { 'a.js': 'old\n' });
        const before = await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8');
        await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'new\n' }, { path: 'n.js', content: 'x' }]));
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), before);
        assert.ok(!(await fsp.stat(path.join(ws.rootPath, 'n.js')).then(() => true).catch(() => false)));
    });
});

describe('P3-7 proposal isolation + path security', () => {
    it('6 owner isolation', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'y\n' }]));
        await assert.rejects(() => proposals.get({ proposalId: p.proposalId, owner: 'bob' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
        await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'bob' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
    });
    it('7 session isolation', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        await assert.rejects(() => proposals.get({ proposalId: p.proposalId, owner: 'alice', sessionId: 'other-session' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
        await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice', sessionId: 'other-session' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
    });
    it('8 proposal applies to its own workspace only', async () => {
        const a = await makeWs('alice', { 'a.js': 'x\n' });
        const b = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose(baseInput(a, [{ path: 'a.js', content: 'CHANGED\n' }]));
        const res = await proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' });
        assert.equal(res.status, 'applied');
        assert.equal(await fsp.readFile(path.join(a.rootPath, 'a.js'), 'utf8'), 'CHANGED\n');
        assert.equal(await fsp.readFile(path.join(b.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
    it('9 traversal rejection', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        for (const bad of ['../evil.js', 'sub/../../evil.js', '..\\evil.js']) {
            await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: bad, content: 'x' }])), (e) => e.code === 'INVALID_PATH', bad);
        }
    });
    it('10 absolute path rejection', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: os.tmpdir(), content: 'x' }])), (e) => e.code === 'INVALID_PATH');
        await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: 'C:\\Windows\\x.txt', content: 'x' }])), (e) => e.code === 'INVALID_PATH');
    });
    it('11 UNC rejection', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: '\\\\server\\share\\x.js', content: 'x' }])), (e) => e.code === 'INVALID_PATH');
    });
    it('12 symlink escape rejection', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const link = path.join(ws.rootPath, 'link-out');
        try {
            await fsp.symlink(os.tmpdir(), link, 'dir');
        } catch {
            return;
        }
        await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: 'link-out/evil.js', content: 'x' }])), (e) => e.code === 'INVALID_PATH');
    });
    it('13 secret files rejected', async () => {
        const ws = await makeWs('alice', { '.env': 'K=V\n', 'id_rsa': 'k\n', 'app.token': 't\n' });
        for (const s of ['.env', 'id_rsa', 'app.token', 'db_PASSWORD.json']) {
            await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: s, content: 'x' }])), (e) => e.code === 'INVALID_PATH', s);
        }
    });
});

describe('P3-7 limits + staleness + expiry', () => {
    it('14 size limits enforced', async () => {
        const ws = await makeWs('alice', { 'big.bin': 'x'.repeat(25 * 1024) });
        await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: 'big.bin', content: 'y' }])), (e) => e.code === 'PROPOSAL_TOO_LARGE');
        await assert.rejects(() => proposals.propose(baseInput(ws, [{ path: 'n.js', content: 'y'.repeat(25 * 1024) }])), (e) => e.code === 'PROPOSAL_TOO_LARGE');
        const many = Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.js`, content: 'x' }));
        await assert.rejects(() => proposals.propose(baseInput(ws, many)), (e) => e.code === 'PROPOSAL_TOO_LARGE');
    });
    it('15 stale file blocks apply, external change kept', async () => {
        const ws = await makeWs('alice', { 'a.js': 'v1\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'v2\n' }]));
        await writeFixture(ws.rootPath, 'a.js', 'external\n');
        await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_STALE');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'external\n');
    });
    it('16 stale multi-file apply touches nothing', async () => {
        const ws = await makeWs('alice', { 'a.js': 'a1\n', 'b.js': 'b1\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'a2\n' }, { path: 'b.js', content: 'b2\n' }]));
        await writeFixture(ws.rootPath, 'b.js', 'external\n');
        await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_STALE');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'a1\n');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'b.js'), 'utf8'), 'external\n');
    });
    it('17 expiry via clock travel', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'y\n' }]));
        const realNow = Date.now;
        try {
            Date.now = () => realNow() + proposals.PROPOSAL_TTL_MS + 1000;
            await assert.rejects(() => proposals.get({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_EXPIRED');
            await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_EXPIRED');
        } finally {
            Date.now = realNow;
        }
    });
    it('18 tampered copies cannot change the snapshot', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'REAL\n' }]));
        p.changes[0].newContent = 'TAMPERED\n';
        p.changes[0].path = '../evil.js';
        const res = await proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' });
        assert.equal(res.status, 'applied');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'REAL\n');
    });
    it('19 invalid proposalId', async () => {
        await assert.rejects(() => proposals.get({ proposalId: 'prop_deadbeef', owner: 'alice' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
        await assert.rejects(() => proposals.applyProposal({ proposalId: 'prop_deadbeef', owner: 'alice' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
        await assert.rejects(() => proposals.rejectProposal({ proposalId: '', owner: 'alice' }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
});

describe('P3-7 apply + atomicity', () => {
    it('20 apply update through the gate', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const created = await toolRegistry.execute('change_propose', { workspaceId: ws.workspaceId, changes: [{ path: 'a.js', content: 'y\n' }] }, { owner: 'alice' });
        const pid = created.result.proposalId;
        await assert.rejects(() => toolRegistry.execute('change_apply', { proposalId: pid }, { owner: 'alice' }), (e) => e.code === 'PERMISSION_REQUIRED');
        await assert.rejects(() => toolRegistry.execute('change_apply', { proposalId: pid }, { owner: 'alice', approval: { status: 'rejected' } }), (e) => e.code === 'PERMISSION_DENIED');
        const done = await toolRegistry.execute('change_apply', { proposalId: pid }, { owner: 'alice', ...APPROVED });
        assert.equal(done.result.status, 'applied');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'y\n');
        await assert.rejects(() => toolRegistry.execute('change_apply', { proposalId: pid }, { owner: 'alice', ...APPROVED }), (e) => e.code === 'PROPOSAL_NOT_PENDING');
    });
    it('21 apply create + delete', async () => {
        const ws = await makeWs('alice', { 'gone.js': 'x\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'made.js', content: 'hi\n' }, { path: 'gone.js', content: null }]));
        const res = await proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' });
        assert.deepEqual(res.applied.sort(), ['gone.js', 'made.js']);
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'made.js'), 'utf8'), 'hi\n');
        assert.ok(!(await fsp.stat(path.join(ws.rootPath, 'gone.js')).then(() => true).catch(() => false)));
    });
    it('22 multi-file apply with nested parents', async () => {
        const ws = await makeWs('alice', { 'a.js': 'a\n' });
        const p = await proposals.propose(baseInput(ws, [
            { path: 'a.js', content: 'A\n' },
            { path: 'sub/deep/b.js', content: 'B\n' },
            { path: 'c.js', content: 'C\n' }
        ]));
        const res = await proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' });
        assert.equal(res.applied.length, 3);
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'sub/deep/b.js'), 'utf8'), 'B\n');
    });
    it('23 rollback restores on mid-apply failure', async () => {
        const ws = await makeWs('alice', { 'a.js': 'a1\n', 'b.js': 'b1\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'a2\n' }, { path: 'b.js', content: 'b2\n' }]));
        const origWrite = fsClient.writeFile;
        let n = 0;
        fsClient.writeFile = async (...args) => {
            n += 1;
            if (n === 2) throw Object.assign(new Error('disk gone'), { code: 'EIO' });
            return origWrite(...args);
        };
        try {
            await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_APPLY_FAILED');
        } finally {
            fsClient.writeFile = origWrite;
        }
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'a1\n');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'b.js'), 'utf8'), 'b1\n');
        const again = await proposals.get({ proposalId: p.proposalId, owner: 'alice' });
        assert.equal(again.status, 'pending');
    });
    it('24 phase-1 failure writes nothing (directory in the way)', async () => {
        const ws = await makeWs('alice', { 'a.js': 'a1\n' });
        await fsp.mkdir(path.join(ws.rootPath, 'd'));
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'a2\n' }, { path: 'n.js', content: 'n\n' }]));
        await fsp.mkdir(path.join(ws.rootPath, 'n.js'));
        await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' }));
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'a1\n');
    });
    it('25 reject flow', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'y\n' }]));
        const r = await proposals.rejectProposal({ proposalId: p.proposalId, owner: 'alice' });
        assert.equal(r.status, 'rejected');
        await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_NOT_PENDING');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
});

describe('P3-7 tool contract', () => {
    it('26 tool metadata: propose/get read-only, apply gated', async () => {
        registerNativeTools(toolRegistry);
        assert.deepEqual([toolRegistry.describe('change_propose').readOnly, toolRegistry.describe('change_propose').needsApproval], [true, false]);
        assert.deepEqual([toolRegistry.describe('change_get').readOnly, toolRegistry.describe('change_get').needsApproval], [true, false]);
        const m = toolRegistry.describe('change_apply');
        assert.equal(m.readOnly, false);
        assert.equal(m.needsApproval, true);
        assert.deepEqual(m.capabilities, ['change.apply']);
        assert.equal(toolRegistry.describe('change_reject').needsApproval, false);
    });
    it('27 strict inputs: no owner/rootPath/command/env', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const base = { workspaceId: ws.workspaceId, changes: [{ path: 'a.js', content: 'y\n' }] };
        for (const extra of [{ owner: 'bob' }, { rootPath: ws.rootPath }, { command: 'x' }, { env: {} }, { cwd: '.' }, { executable: 'git' }]) {
            await assert.rejects(() => toolRegistry.execute('change_propose', { ...base, ...extra }, { owner: 'alice' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        }
        await assert.rejects(() => toolRegistry.execute('change_apply', { proposalId: 'prop_x', paths: ['a.js'] }, { owner: 'alice', ...APPROVED }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('change_propose', { workspaceId: ws.workspaceId, changes: 'nope' }, { owner: 'alice' }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('28 restart wipes approvals (store is memory-only)', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose(baseInput(ws, [{ path: 'a.js', content: 'y\n' }]));
        proposals._clearForTests();
        await assert.rejects(() => proposals.get({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
        await assert.rejects(() => proposals.applyProposal({ proposalId: p.proposalId, owner: 'alice' }), (e) => e.code === 'PROPOSAL_NOT_FOUND');
    });
});
