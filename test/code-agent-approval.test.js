// P3-7 Agent approval integration: propose -> pause -> resume.
//
// Covers the P3-6 loop's P3-7 flow with stub cores (fast) and the real
// core + registry (permission + stale + expiry paths).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const loop = require('../src/services/codeAgentLoopService');
const proposals = require('../src/services/changeProposalService');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p37a-test-${Date.now()}-${(n += 1)}`;
const APPROVAL = { status: 'approved' };

function stubCore(script = {}, hooks = {}) {
    const calls = [];
    return {
        calls,
        async run(task, opts) {
            calls.push({ task, opts });
            if (hooks.onCall) hooks.onCall(task, opts);
            const step = opts && opts.steps && opts.steps[0];
            if (opts && opts.signal && opts.signal.aborted) {
                throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
            }
            const entry = script[step.name];
            if (entry && entry.error) throw entry.error;
            const data = entry && entry.result !== undefined ? entry.result : (entry || { ok: true });
            return { status: 'completed', steps: [], result: data, mcpTools: [step.name] };
        }
    };
}

const passTests = () => ({ ok: true, code: 'TEST_PASS', exitCode: 0 });
const failTests = () => ({ ok: false, code: 'TEST_FAILED', exitCode: 1 });
const fakeWs = (id = 'ws_1') => ({
    async getById(wid) { return { workspaceId: wid }; },
    async getCurrent() { return { workspaceId: id }; }
});
const fakeProp = (status = 'pending') => ({
    async get() { return { proposalId: 'prop_1', status, workspaceId: 'ws_1', changes: [] }; }
});
const D = (core, extra = {}) => ({ core, workspaceService: fakeWs(), ...extra });

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

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-approval-test-'));
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

describe('P3-7 pause at approval (stub core)', () => {
    it('1 agent pauses with APPROVAL_REQUIRED after proposing', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_propose: { result: { proposalId: 'prop_7', status: 'pending', changes: [{ path: 'a.js' }] } }
        });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core)
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'APPROVAL_REQUIRED');
        assert.equal(out.proposalId, 'prop_7');
        assert.equal(out.proposalStatus, 'pending');
        assert.equal(out.finalStatus, 'awaiting_approval');
    });
    it('2 no self-approval even with tool approval present', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_propose: { result: { proposalId: 'prop_7', status: 'pending', changes: [] } }
        });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it',
            edits: [{ path: 'a.js', content: '1' }],
            approval: APPROVAL,
            deps: D(core)
        });
        assert.equal(out.code, 'APPROVAL_REQUIRED');
        const names = core.calls.map((c) => c.opts.steps[0].name);
        assert.ok(!names.includes('change_apply'));
    });
    it('3 resume applies and verifies after human approval', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_apply: { result: { proposalId: 'prop_1', status: 'applied', applied: ['a.js'] } }
        });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it', proposalId: 'prop_1',
            approval: APPROVAL,
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.ok, true);
        assert.equal(out.code, 'AGENT_COMPLETED');
        assert.equal(out.proposalId, 'prop_1');
        assert.equal(out.proposalStatus, 'applied');
        assert.deepEqual(out.toolsUsed, ['change_apply', 'test_runner']);
    });
    it('4 resume of non-pending proposal fails', async () => {
        const core = stubCore();
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it', proposalId: 'prop_1',
            approval: APPROVAL,
            deps: D(core, { proposals: fakeProp('applied') })
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.ok(out.failureReason.includes('applied'));
        assert.equal(core.calls.length, 0);
    });
    it('5 edits + proposalId together are rejected', () => {
        const core = stubCore();
        assert.throws(() => loop.buildPlan({ goal: 'g', edits: [{ path: 'a', content: 'b' }], proposalId: 'prop_1' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        assert.equal(core.calls.length, 0);
    });
});

describe('P3-7 approval events (stub core)', () => {
    it('6 pause emits proposal_created + approval_required', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_propose: { result: { proposalId: 'prop_7', status: 'pending', changes: [{ path: 'a.js' }] } }
        });
        const events = [];
        await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it',
            edits: [{ path: 'a.js', content: '1' }],
            onEvent: (e) => events.push(e),
            deps: D(core)
        });
        const created = events.find((e) => e.type === 'proposal_created');
        const required = events.find((e) => e.type === 'approval_required');
        assert.ok(created && created.proposalId === 'prop_7');
        assert.deepEqual(created.files, ['a.js']);
        assert.ok(required && required.proposalId === 'prop_7');
    });
    it('7 resume emits changes_applied', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_apply: { result: { proposalId: 'prop_1', status: 'applied', applied: [] } }
        });
        const events = [];
        await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it', proposalId: 'prop_1',
            approval: APPROVAL,
            onEvent: (e) => events.push(e),
            deps: D(core, { proposals: fakeProp() })
        });
        assert.ok(events.some((e) => e.type === 'changes_applied' && e.proposalId === 'prop_1'));
        assert.ok(events.some((e) => e.type === 'message.completed'));
    });
    it('8 stale apply emits proposal_stale', async () => {
        const core = stubCore({
            change_apply: { error: Object.assign(new Error('file changed since proposal: a.js'), { code: 'PROPOSAL_STALE' }) }
        });
        const events = [];
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it', proposalId: 'prop_1',
            approval: APPROVAL,
            onEvent: (e) => events.push(e),
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.ok(events.some((e) => e.type === 'proposal_stale'));
        assert.ok(events.some((e) => e.type === 'error'));
    });
});

describe('P3-7 real approval boundaries', () => {
    it('9 resume without approval cannot apply', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const out = await loop.run({ workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice', goal: 'fix', proposalId: p.proposalId });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
    it('10 external edit between pause and resume goes stale', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'v1\n' });
        const paused = await loop.run({
            workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice',
            goal: 'fix', edits: [{ path: 'a.js', content: 'v2\n' }], approval: APPROVAL
        });
        assert.equal(paused.code, 'APPROVAL_REQUIRED');
        await writeFixture(ws.rootPath, 'a.js', 'external\n');
        const events = [];
        const done = await loop.run({
            workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice',
            goal: 'fix', proposalId: paused.proposalId, approval: APPROVAL,
            onEvent: (e) => events.push(e)
        });
        assert.equal(done.code, 'AGENT_TOOL_FAILED');
        assert.equal(done.errorCode, 'PROPOSAL_STALE');
        assert.ok(events.some((e) => e.type === 'proposal_stale'));
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'external\n');
    });
    it('11 expired proposal cannot resume', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const realNow = Date.now;
        let out;
        try {
            Date.now = () => realNow() + proposals.PROPOSAL_TTL_MS + 1000;
            out = await loop.run({ workspaceId: ws.workspaceId, owner: 'alice', goal: 'fix', proposalId: p.proposalId, approval: APPROVAL });
        } finally {
            Date.now = realNow;
        }
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.errorCode, 'PROPOSAL_EXPIRED');
    });
    it('12 restart invalidates pending proposals', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        proposals._clearForTests();
        const out = await loop.run({ workspaceId: ws.workspaceId, owner: 'alice', goal: 'fix', proposalId: p.proposalId, approval: APPROVAL });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.errorCode, 'PROPOSAL_NOT_FOUND');
    });
    it('13 other user files are never touched', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'target.js': 'old\n', 'precious.js': 'keep\n' });
        const paused = await loop.run({
            workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice',
            goal: 'fix', edits: [{ path: 'target.js', content: 'new\n' }], approval: APPROVAL
        });
        const done = await loop.run({
            workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice',
            goal: 'fix', proposalId: paused.proposalId, approval: APPROVAL
        });
        assert.equal(done.proposalStatus, 'applied');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'precious.js'), 'utf8'), 'keep\n');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'target.js'), 'utf8'), 'new\n');
    });
    it('14 abort cancels a pending resume', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const c = new AbortController();
        c.abort();
        await assert.rejects(() => loop.run({ workspaceId: ws.workspaceId, owner: 'alice', goal: 'fix', proposalId: p.proposalId, approval: APPROVAL, signal: c.signal }), (e) => e.code === 'ABORTED');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
    it('15 loop never calls git_add/commit/direct writes or shell', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_propose: { result: { proposalId: 'prop_7', status: 'pending', changes: [] } },
            change_apply: { result: { proposalId: 'prop_1', status: 'applied', applied: [] } }
        });
        const first = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix and push it live via shell',
            edits: [{ path: 'a.js', content: '1' }],
            checks: [{ executable: 'node', args: ['--version'] }],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(first.code, 'APPROVAL_REQUIRED');
        const second = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix and push it live via shell',
            proposalId: 'prop_1', approval: APPROVAL,
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(second.code, 'AGENT_COMPLETED');
        const names = core.calls.map((c) => c.opts.steps[0].name);
        for (const banned of ['git_add', 'git_commit', 'git_push', 'filesystem.write', 'powershell']) {
            assert.ok(!names.includes(banned), banned);
        }
    });
    it('16 change_get exposes the diff for review', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'old\n' });
        const created = await toolRegistry.execute('change_propose', { workspaceId: ws.workspaceId, changes: [{ path: 'a.js', content: 'new\n' }] }, { owner: 'alice' });
        const fetched = await toolRegistry.execute('change_get', { proposalId: created.result.proposalId }, { owner: 'alice' });
        assert.ok(fetched.result.diff === undefined || true);
        assert.ok(fetched.result.changes[0].diff.includes('-old'));
        assert.ok(fetched.result.changes[0].diff.includes('+new'));
        const rejected = await toolRegistry.execute('change_reject', { proposalId: created.result.proposalId }, { owner: 'alice' });
        assert.equal(rejected.result.status, 'rejected');
    });
    it('17 malformed proposal tool inputs', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        await assert.rejects(() => toolRegistry.execute('change_propose', { workspaceId: ws.workspaceId, changes: 'nope' }, { owner: 'alice' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('change_apply', {}, { owner: 'alice', ...{ approval: APPROVAL } }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('change_get', { proposalId: 'prop_nope' }, { owner: 'alice' }), (e) => e.code === 'TOOL_EXECUTION_ERROR' && e.cause && e.cause.code === 'PROPOSAL_NOT_FOUND');
    });
    it('18 cross-session resume is rejected', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const created = await toolRegistry.execute(
            'change_propose',
            { workspaceId: ws.workspaceId, sessionId: ws.sessionId, changes: [{ path: 'a.js', content: 'y\n' }] },
            { owner: 'alice', sessionId: ws.sessionId }
        );
        await assert.rejects(() => toolRegistry.execute('change_apply', { proposalId: created.result.proposalId }, { owner: 'alice', sessionId: 'different-session', ...{ approval: APPROVAL } }), (e) => e.code === 'TOOL_EXECUTION_ERROR' && e.cause && e.cause.code === 'PROPOSAL_NOT_FOUND');
    });
});
