// P3-9 Checkpoint / Resume tests.
//
// Service unit tests use isolated MemoryCheckpointStore instances.
// Loop/API tests use temp workspaces + stub cores (never the real repo).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const loop = require('../src/services/codeAgentLoopService');
const proposals = require('../src/services/changeProposalService');
const { AgentCheckpointService, MemoryCheckpointStore, resetSharedMemoryForTests: resetCpMemory, STATUSES } = require('../src/services/agentCheckpointService');
const checkpointsRouter = require('../src/routes/checkpoints');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p39-test-${Date.now()}-${(n += 1)}`;
const APPROVAL = { status: 'approved' };

const memSvc = () => new AgentCheckpointService(new MemoryCheckpointStore());

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
const propResult = (id) => ({ result: { proposalId: id, status: 'pending', changes: [{ path: 'a.js' }] } });
const appliedResult = (id) => ({ result: { proposalId: id, status: 'applied', applied: ['a.js'] } });

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

let server = null;
let baseUrl = '';
const api = (p, opts = {}) => fetch(`${baseUrl}${p}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.user === null ? {} : { 'x-test-user': opts.user || 'alice' }) },
    ...opts.fetch
});

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-cp-test-'));
    process.env.WORKSPACE_ROOT = ROOT;
    resetSharedMemoryForTests();
    resetCpMemory();

    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use('/api', (req, res, next) => {
        const u = req.headers['x-test-user'];
        if (u) req.user = { username: String(u) };
        next();
    });
    app.use('/api', checkpointsRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (SAVED_ROOT === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = SAVED_ROOT;
    if (SAVED_DB_URL !== undefined) process.env.DATABASE_URL = SAVED_DB_URL;
    resetSharedMemoryForTests();
    resetCpMemory();
    if (ROOT) await fsp.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    toolRegistry._clearForTests();
    proposals._clearForTests();
    resetCpMemory();
});

describe('P3-9 checkpoint service', () => {
    it('1 create assigns opaque id, version 1, running', async () => {
        const svc = memSvc();
        const a = await svc.create({ ownerId: 'alice', sessionId: 's', workspaceId: 'ws', state: { phase: 'x' } });
        const b = await svc.create({ ownerId: 'alice', sessionId: 's', workspaceId: 'ws', state: {} });
        assert.ok(/^checkpoint_[0-9a-f]{24}$/.test(a.checkpointId));
        assert.notEqual(a.checkpointId, b.checkpointId);
        assert.equal(a.version, 1);
        assert.equal(a.status, 'running');
        assert.ok(a.createdAt && a.updatedAt);
    });
    it('2 get returns stored state', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: { n: 1 } });
        const got = await svc.getById(c.checkpointId, 'alice');
        assert.deepEqual(got.state, { n: 1 });
        assert.equal(got.version, 1);
    });
    it('3 update increments version (CAS)', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: {} });
        const u1 = await svc.update(c.checkpointId, 'alice', { status: 'paused', expectedVersion: 1 });
        assert.equal(u1.version, 2);
        assert.equal(u1.status, 'paused');
        const u2 = await svc.update(c.checkpointId, 'alice', { state: { n: 2 }, expectedVersion: 2 });
        assert.equal(u2.version, 3);
        assert.deepEqual(u2.state, { n: 2 });
    });
    it('4 stale version is a conflict, not an overwrite', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: { n: 1 } });
        await svc.update(c.checkpointId, 'alice', { state: { n: 2 }, expectedVersion: 1 });
        await assert.rejects(() => svc.update(c.checkpointId, 'alice', { state: { n: 3 }, expectedVersion: 1 }), (e) => e.code === 'CHECKPOINT_CONFLICT' && e.status === 409);
        assert.deepEqual((await svc.getById(c.checkpointId, 'alice')).state, { n: 2 });
    });
    it('5 invalid status and state rejected', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: {} });
        await assert.rejects(() => svc.update(c.checkpointId, 'alice', { status: 'nope', expectedVersion: 1 }), (e) => e.code === 'CHECKPOINT_INVALID');
        await assert.rejects(() => svc.update(c.checkpointId, 'alice', { state: [1], expectedVersion: 1 }), (e) => e.code === 'CHECKPOINT_INVALID');
        const bad = { name: 'x' };
        bad.self = bad;
        await assert.rejects(() => svc.create({ ownerId: 'alice', state: bad }), (e) => e.code === 'CHECKPOINT_INVALID');
        assert.deepEqual(STATUSES.sort(), ['cancelled', 'completed', 'failed', 'paused', 'running', 'waiting_approval'].sort());
    });
    it('6 owner/session isolation, missing id', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', sessionId: 's1', state: {} });
        await assert.rejects(() => svc.getById(c.checkpointId, 'bob'), (e) => e.code === 'CHECKPOINT_NOT_FOUND');
        await assert.rejects(() => svc.getById(c.checkpointId, 'alice', { sessionId: 's2' }), (e) => e.code === 'CHECKPOINT_NOT_FOUND');
        await assert.rejects(() => svc.getById('checkpoint_000000000000000000000000', 'alice'), (e) => e.code === 'CHECKPOINT_NOT_FOUND');
        await assert.rejects(() => svc.update(c.checkpointId, 'bob', { status: 'failed', expectedVersion: 1 }), (e) => e.code === 'CHECKPOINT_NOT_FOUND');
        const ok = await svc.getById(c.checkpointId, 'alice', { sessionId: 's1' });
        assert.equal(ok.checkpointId, c.checkpointId);
    });
    it('7 claimForResume: terminal refuses, double claim conflicts', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: {} });
        const claimed = await svc.claimForResume(c.checkpointId, 'alice', {});
        assert.equal(claimed.status, 'running');
        assert.equal(claimed.version, 2);
        await svc.update(c.checkpointId, 'alice', { status: 'completed', expectedVersion: 2 });
        await assert.rejects(() => svc.claimForResume(c.checkpointId, 'alice', {}), (e) => e.code === 'CHECKPOINT_TERMINAL');
        const d = await svc.create({ ownerId: 'alice', state: {} });
        await svc.claimForResume(d.checkpointId, 'alice', {});
        await assert.rejects(() => svc.claimForResume(d.checkpointId, 'alice', { expectedVersion: 1 }), (e) => e.code === 'CHECKPOINT_CONFLICT');
    });
    it('8 cancel marks cancelled; terminal cancel refuses', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: {} });
        const out = await svc.cancel(c.checkpointId, 'alice', {});
        assert.equal(out.status, 'cancelled');
        await assert.rejects(() => svc.cancel(c.checkpointId, 'alice', {}), (e) => e.code === 'CHECKPOINT_TERMINAL');
        await assert.rejects(() => svc.cancel(c.checkpointId, 'bob', {}), (e) => e.code === 'CHECKPOINT_NOT_FOUND');
    });
    it('9 restart simulation: fresh instance loads persisted row', async () => {
        const a = new AgentCheckpointService();
        const c = await a.create({ ownerId: 'alice', sessionId: 's', state: { counts: { steps: 7 } } });
        const b = new AgentCheckpointService();
        const got = await b.getById(c.checkpointId, 'alice');
        assert.deepEqual(got.state, { counts: { steps: 7 } });
        assert.equal(got.version, 1);
    });
});

describe('P3-9 loop persistence (stub core)', () => {
    const D = (core, extra = {}) => ({ core, workspaceService: fakeWs(), ...extra });
    it('10 initial run creates a checkpoint', async () => {
        const core = stubCore({ test_runner: passTests() });
        const events = [];
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', onEvent: (e) => events.push(e.type), deps: D(core) });
        assert.equal(out.ok, true);
        assert.ok(typeof out.checkpointId === 'string' && out.checkpointId.startsWith('checkpoint_'));
        assert.ok(out.checkpointVersion >= 2);
        assert.ok(events.includes('checkpoint_created'));
        assert.ok(events.includes('checkpoint_completed'));
        const stored = await AgentCheckpointService.default().getById(out.checkpointId, 'alice');
        assert.equal(stored.status, 'completed');
        assert.equal(stored.version, out.checkpointVersion);
    });
    it('11 state is persisted across steps', async () => {
        const core = stubCore({ test_runner: passTests(), change_propose: propResult('prop_9') });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core)
        });
        assert.equal(out.code, 'APPROVAL_REQUIRED');
        const stored = await AgentCheckpointService.default().getById(out.checkpointId, 'alice');
        assert.equal(stored.status, 'waiting_approval');
        assert.equal(stored.state.pendingProposalId, 'prop_9');
        assert.equal(stored.state.queue.length, 0);
        assert.ok(stored.state.counts.steps >= 4);
        assert.deepEqual(stored.state.toolsUsed, ['code_context', 'git_status', 'test_runner', 'change_propose']);
    });
    it('12 resume continues from stored state (budgets NOT reset)', async () => {
        const core = stubCore({ test_runner: passTests(), change_propose: propResult('prop_9') });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core)
        });
        const before = await AgentCheckpointService.default().getById(r1.checkpointId, 'alice');
        const usedTests = before.state.counts.tests;
        assert.ok(usedTests >= 1);
        const core2 = stubCore({ test_runner: passTests(), change_apply: appliedResult('prop_9') });
        const r2 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g', checkpointId: r1.checkpointId,
            approval: APPROVAL,
            deps: { core: core2, workspaceService: fakeWs(), proposals: fakeProp() }
        });
        assert.equal(r2.code, 'AGENT_COMPLETED');
        const after = await AgentCheckpointService.default().getById(r1.checkpointId, 'alice');
        assert.ok(after.state.counts.tests > usedTests);
        assert.ok(after.state.tests.length >= r2.tests.length);
    });
    it('13 test budget continues across resume', async () => {
        const core = stubCore({ test_runner: passTests(), change_propose: propResult('prop_9') });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core, { limits: { MAX_AGENT_STEPS: 12, MAX_TEST_RUNS: 1, MAX_CONTEXT_CALLS: 4 } })
        });
        assert.equal(r1.code, 'APPROVAL_REQUIRED');
        const core2 = stubCore({ test_runner: passTests(), change_apply: appliedResult('prop_9') });
        const r2 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g', checkpointId: r1.checkpointId,
            approval: APPROVAL,
            deps: { core: core2, workspaceService: fakeWs(), proposals: fakeProp(), limits: { MAX_AGENT_STEPS: 12, MAX_TEST_RUNS: 1, MAX_CONTEXT_CALLS: 4 } }
        });
        assert.equal(r2.code, 'AGENT_STEP_LIMIT');
        assert.ok(r2.failureReason.includes('test run limit'));
    });
    it('14 correctionAttempts persist; no caller offset needed', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'f1' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(r1.correctionAttempts, 1);
        const core2 = stubCore({ test_runner: failTests(), change_propose: propResult('prop_3') });
        const r2 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', checkpointId: r1.checkpointId,
            approval: APPROVAL,
            corrections: [[{ path: 'a.js', content: 'f2' }]],
            deps: { core: core2, workspaceService: fakeWs(), proposals: fakeProp() }
        });
        assert.equal(r2.code, 'APPROVAL_REQUIRED');
        assert.equal(r2.correctionAttempts, 2);
        assert.equal(r2.corrections[0].attempt, 1);
        assert.equal(r2.corrections[1].attempt, 2);
        assert.equal(r2.proposalId, 'prop_3');
    });
    it('15 stored offset wins over caller-supplied offset', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_9') });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'f1' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(r1.correctionAttempts, 1);
        const core2 = stubCore({ test_runner: failTests(), change_propose: propResult('prop_9') });
        const r2 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', checkpointId: r1.checkpointId,
            approval: APPROVAL, correctionOffset: 99,
            corrections: [[{ path: 'a.js', content: 'f2' }]],
            deps: { core: core2, workspaceService: fakeWs(), proposals: fakeProp() }
        });
        assert.equal(r2.code, 'APPROVAL_REQUIRED');
        assert.equal(r2.correctionAttempts, 2);
    });
    it('16 correction limit enforced from checkpoint state', async () => {
        const core = stubCore({ test_runner: failTests() });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            correctionOffset: 3,
            corrections: [[{ path: 'a.js', content: 'f4' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(r1.code, 'AGENT_CORRECTION_LIMIT');
        assert.equal(r1.correctionAttempts, 3);
    });
    it('17 waiting_approval resume requires human approval', async () => {
        const core = stubCore({ test_runner: passTests(), change_propose: propResult('prop_9') });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core)
        });
        const core2 = stubCore({
            change_apply: { error: Object.assign(new Error('tool execution requires approval'), { status: 400, code: 'PERMISSION_REQUIRED' }) }
        });
        const r2 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g', checkpointId: r1.checkpointId,
            deps: { core: core2, workspaceService: fakeWs(), proposals: fakeProp() }
        });
        assert.equal(r2.code, 'AGENT_TOOL_FAILED');
        const stored = await AgentCheckpointService.default().getById(r1.checkpointId, 'alice');
        assert.equal(stored.status, 'failed');
    });
    it('18 terminal checkpoints refuse resume', async () => {
        const core = stubCore({ test_runner: passTests() });
        const done = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', deps: D(core) });
        const core2 = stubCore({});
        for (const id of [done.checkpointId]) {
            const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', checkpointId: id, deps: D(core2) });
            assert.equal(out.code, 'AGENT_TOOL_FAILED');
            assert.equal(out.errorCode, 'CHECKPOINT_TERMINAL');
            assert.equal(core2.calls.length, 0);
        }
    });
    it('19 unauthorized resume is rejected', async () => {
        const core = stubCore({ test_runner: passTests(), change_propose: propResult('prop_9') });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core)
        });
        const core2 = stubCore({});
        const bob = await loop.run({ workspaceId: 'ws_1', owner: 'bob', goal: 'g', checkpointId: r1.checkpointId, deps: D(core2) });
        assert.equal(bob.code, 'AGENT_TOOL_FAILED');
        assert.equal(core2.calls.length, 0);
        const stored = await AgentCheckpointService.default().getById(r1.checkpointId, 'alice');
        assert.equal(stored.status, 'waiting_approval');
    });
    it('20 stale expectedVersion conflicts', async () => {
        const core = stubCore({ test_runner: passTests(), change_propose: propResult('prop_9') });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core)
        });
        const core2 = stubCore({});
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g', checkpointId: r1.checkpointId,
            expectedVersion: 1, approval: APPROVAL,
            deps: { core: core2, workspaceService: fakeWs(), proposals: fakeProp() }
        });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.errorCode, 'CHECKPOINT_CONFLICT');
        assert.equal(core2.calls.length, 0);
    });
    it('21 cancellation persists cancelled, never completed', async () => {
        const c = new AbortController();
        const core = stubCore({ test_runner: passTests() }, {
            onCall: () => {
                if (core.calls.length === 1) c.abort();
            }
        });
        let cpId = null;
        const events = [];
        await assert.rejects(() => loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g', signal: c.signal,
            onEvent: (e) => {
                events.push(e.type);
                if (e.type === 'checkpoint_created') cpId = e.checkpointId;
            },
            deps: D(core)
        }), (e) => e.code === 'ABORTED');
        assert.ok(cpId);
        const stored = await AgentCheckpointService.default().getById(cpId, 'alice');
        assert.equal(stored.status, 'cancelled');
        assert.ok(events.includes('checkpoint_cancelled'));
        assert.ok(!events.includes('checkpoint_completed'));
    });
    it('22 cancelled checkpoints refuse resume', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: {} });
        await svc.cancel(c.checkpointId, 'alice', {});
        const core = stubCore({});
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g', checkpointId: c.checkpointId,
            deps: { core, workspaceService: fakeWs(), checkpoints: svc }
        });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.errorCode, 'CHECKPOINT_TERMINAL');
    });
    it('23 checkpoint events across a pause/resume cycle', async () => {
        const core = stubCore({ test_runner: passTests(), change_propose: propResult('prop_9') });
        const events = [];
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g',
            edits: [{ path: 'a.js', content: '1' }],
            onEvent: (e) => events.push(e.type),
            deps: D(core)
        });
        const core2 = stubCore({ test_runner: passTests(), change_apply: appliedResult('prop_9') });
        await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'g', checkpointId: r1.checkpointId,
            approval: APPROVAL,
            onEvent: (e) => events.push(e.type),
            deps: { core: core2, workspaceService: fakeWs(), proposals: fakeProp() }
        });
        for (const t of ['checkpoint_created', 'checkpoint_waiting_approval', 'checkpoint_resumed', 'checkpoint_completed']) {
            assert.ok(events.includes(t), t);
        }
    });
    it('24 no secrets or env leak into checkpoint state', async () => {
        const core = stubCore({ test_runner: passTests() });
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', deps: D(core) });
        const stored = await AgentCheckpointService.default().getById(out.checkpointId, 'alice');
        const text = JSON.stringify(stored);
        assert.ok(!('env' in stored.state));
        assert.ok(!text.includes('DATABASE_URL'));
        for (const k of Object.keys(stored.state)) {
            assert.ok(!/secret|credential|token|password|env/i.test(k), k);
        }
    });
});

describe('P3-9 checkpoint API', () => {
    it('25 GET returns public view without file contents', async () => {
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, owner: 'alice', changes: [{ path: 'a.js', content: 'SECRET-PLAN-CONTENT\n' }] });
        const shared = require('../src/services/agentCheckpointService');
        shared.resetSharedMemoryForTests();
        const cpSvc = shared.AgentCheckpointService.default();
        const c = await cpSvc.create({ ownerId: 'alice', sessionId: ws.sessionId, workspaceId: ws.workspaceId, state: { pendingProposalId: p.proposalId, counts: { steps: 4, tests: 1, contexts: 1 } } });
        const res = await api(`/api/checkpoints/${c.checkpointId}?sessionId=${ws.sessionId}`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.checkpointId, c.checkpointId);
        assert.equal(data.summary.proposalId, p.proposalId);
        assert.ok(!JSON.stringify(data).includes('SECRET-PLAN-CONTENT'));
    });
    it('26 GET unknown / cross-owner / no-auth', async () => {
        const miss = await api('/api/checkpoints/checkpoint_000000000000000000000000');
        assert.equal(miss.status, 404);
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: {} });
        const bob = await api(`/api/checkpoints/${c.checkpointId}`, { user: 'bob' });
        assert.equal(bob.status, 404);
        const anon = await api(`/api/checkpoints/${c.checkpointId}`, { user: null });
        assert.equal(anon.status, 401);
    });
    it('27 resume without approval cannot apply (real gate)', async () => {
        registerTools();
        const ws = await makeWs('alice', { 'a.js': 'x\n' });
        const p = await proposals.propose({ workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice', changes: [{ path: 'a.js', content: 'y\n' }] });
        const svc = memSvc();
        // NOTE: API route uses the shared default service; seed it instead.
        const shared = require('../src/services/agentCheckpointService');
        shared.resetSharedMemoryForTests();
        const cpSvc = shared.AgentCheckpointService.default();
        const c = await cpSvc.create({
            ownerId: 'alice', sessionId: ws.sessionId, workspaceId: ws.workspaceId,
            state: {
                goal: 'fix', workspaceId: ws.workspaceId, sessionId: ws.sessionId,
                queue: [], counts: { steps: 3, tests: 1, contexts: 1 },
                toolsUsed: ['code_context', 'git_status', 'test_runner'], tests: [],
                correctionsLog: [], diagnosis: null,
                createdProposalId: p.proposalId, createdProposalStatus: 'pending',
                correctionBase: 0, correctionsRemaining: [], pendingCorrection: null,
                resumeProposalId: null, pendingProposalId: p.proposalId
            }
        });
        await cpSvc.update(c.checkpointId, 'alice', { status: 'waiting_approval', expectedVersion: 1, sessionId: ws.sessionId });
        const res = await api(`/api/checkpoints/${c.checkpointId}/resume`, {
            fetch: { method: 'POST', body: JSON.stringify({ sessionId: ws.sessionId }) }
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.code, 'AGENT_TOOL_FAILED');
        assert.equal(await fsp.readFile(path.join(ws.rootPath, 'a.js'), 'utf8'), 'x\n');
    });
    it('28 cancel marks cancelled; terminal cancel refused', async () => {
        const svc = memSvc();
        const c = await svc.create({ ownerId: 'alice', state: {} });
        // Seed the shared default service used by the route.
        const shared = require('../src/services/agentCheckpointService');
        shared.resetSharedMemoryForTests();
        const cpSvc = shared.AgentCheckpointService.default();
        const d = await cpSvc.create({ ownerId: 'alice', state: {} });
        const res = await api(`/api/checkpoints/${d.checkpointId}/cancel`, { fetch: { method: 'POST', body: '{}' } });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).status, 'cancelled');
        const again = await api(`/api/checkpoints/${d.checkpointId}/cancel`, { fetch: { method: 'POST', body: '{}' } });
        assert.equal(again.status, 400);
        const anon = await api(`/api/checkpoints/${d.checkpointId}/cancel`, { user: null, fetch: { method: 'POST', body: '{}' } });
        assert.equal(anon.status, 401);
        assert.equal(c.checkpointId.length > 0, true);
    });
});

function registerTools() {
    const { registerNativeTools } = require('../src/services/tools/nativeTools');
    registerNativeTools(toolRegistry);
}
