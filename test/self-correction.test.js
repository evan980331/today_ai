// P3-8 Self-Correction tests: bounded diagnose -> propose -> approve ->
// apply -> retest, always pausing for human approval.
//
// Stub-core tests cover orchestration/budgets; real-registry tests cover
// the end-to-end chain with real proposals and a file-backed test stub.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const loop = require('../src/services/codeAgentLoopService');
const proposals = require('../src/services/changeProposalService');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p38-test-${Date.now()}-${(n += 1)}`;
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

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-correct-test-'));
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

describe('P3-8 correction triggering (stub core)', () => {
    it('1 failed verification triggers a correction proposal', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'APPROVAL_REQUIRED');
        assert.equal(out.proposalId, 'prop_2');
        assert.notEqual(out.proposalId, 'prop_1');
        assert.equal(out.correctionAttempts, 1);
        assert.equal(out.corrections.length, 1);
        assert.equal(out.corrections[0].attempt, 1);
        assert.equal(out.corrections[0].testResult.code, 'TEST_FAILED');
    });
    it('2 correction pauses for human approval (no apply call)', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        const names = core.calls.map((c) => c.opts.steps[0].name);
        assert.ok(names.includes('change_apply'));
        assert.equal(names.filter((x) => x === 'change_apply').length, 1);
        const proposes = core.calls.filter((c) => c.opts.steps[0].name === 'change_propose');
        assert.equal(proposes.length, 1);
        assert.deepEqual(proposes[0].opts.steps[0].input.changes, [{ path: 'a.js', content: 'fix1' }]);
    });
    it('3 correction never self-approves, even with tool approval', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            approval: APPROVAL,
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.code, 'APPROVAL_REQUIRED');
        const names = core.calls.map((c) => c.opts.steps[0].name);
        assert.equal(names.filter((x) => x === 'change_apply').length, 1);
    });
    it('4 previous proposal stays immutable (apply used the old id)', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        const apply = core.calls.find((c) => c.opts.steps[0].name === 'change_apply');
        assert.equal(apply.opts.steps[0].input.proposalId, 'prop_1');
        assert.deepEqual(Object.keys(apply.opts.steps[0].input).sort(), ['proposalId']);
    });
    it('5 approved correction is applied then retested to PASS', async () => {
        const core = stubCore({ test_runner: passTests(), change_apply: appliedResult('prop_2') });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_2',
            approval: APPROVAL, correctionOffset: 1,
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.ok, true);
        assert.equal(out.code, 'AGENT_COMPLETED');
        assert.equal(out.finalStatus, 'completed');
        assert.equal(out.correctionAttempts, 1);
        assert.equal(out.tests[out.tests.length - 1].code, 'TEST_PASS');
    });
    it('6 second correction round gets attempt 2', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_3') });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_2',
            approval: APPROVAL, correctionOffset: 1,
            corrections: [[{ path: 'a.js', content: 'fix2' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.code, 'APPROVAL_REQUIRED');
        assert.equal(out.proposalId, 'prop_3');
        assert.equal(out.correctionAttempts, 2);
        assert.equal(out.corrections[0].attempt, 2);
    });
    it('17 diagnosis is structured', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.deepEqual(out.diagnosis, { attempt: 1, testCode: 'TEST_FAILED', testExitCode: 1, inspected: ['code_context', 'git_status'] });
        const names = core.calls.map((c) => c.opts.steps[0].name);
        assert.ok(names.includes('code_context') && names.includes('git_status'));
    });
    it('18 correction events carry flags', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        const events = [];
        await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            onEvent: (e) => events.push(e),
            deps: D(core, { proposals: fakeProp() })
        });
        const created = events.find((e) => e.type === 'proposal_created');
        const required = events.find((e) => e.type === 'approval_required');
        assert.equal(created.isCorrection, true);
        assert.equal(created.correctionAttempt, 1);
        assert.equal(required.isCorrection, true);
        assert.equal(required.proposalId, 'prop_2');
    });
});

describe('P3-8 bounds (stub core)', () => {
    it('7 MAX_CORRECTION_ATTEMPTS stops the loop', async () => {
        assert.equal(loop.MAX_CORRECTION_ATTEMPTS, 3);
        const core = stubCore({ test_runner: failTests() });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            correctionOffset: 3,
            corrections: [[{ path: 'a.js', content: 'fix4' }]],
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_CORRECTION_LIMIT');
        assert.equal(out.finalStatus, 'correction_limit');
        assert.equal(out.correctionAttempts, 3);
        assert.ok(out.failureReason.includes('3'));
        const names = core.calls.map((c) => c.opts.steps[0].name);
        assert.ok(!names.includes('change_propose'));
    });
    it('7b three chained attempts then limit', async () => {
        const mk = (pid) => stubCore({ test_runner: failTests(), change_propose: propResult(pid) });
        const r1 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'f1' }]],
            deps: D(mk('prop_2'), { proposals: fakeProp() })
        });
        assert.equal(r1.correctionAttempts, 1);
        const r2 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: r1.proposalId,
            correctionOffset: r1.correctionAttempts,
            corrections: [[{ path: 'a.js', content: 'f2' }]],
            deps: D(mk('prop_3'), { proposals: fakeProp() })
        });
        assert.equal(r2.correctionAttempts, 2);
        const r3 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: r2.proposalId,
            correctionOffset: r2.correctionAttempts,
            corrections: [[{ path: 'a.js', content: 'f3' }]],
            deps: D(mk('prop_4'), { proposals: fakeProp() })
        });
        assert.equal(r3.correctionAttempts, 3);
        assert.equal(r3.proposalId, 'prop_4');
        const r4 = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: r3.proposalId,
            correctionOffset: r3.correctionAttempts,
            corrections: [[{ path: 'a.js', content: 'f4' }]],
            deps: D(mk('prop_5'), { proposals: fakeProp() })
        });
        assert.equal(r4.code, 'AGENT_CORRECTION_LIMIT');
    });
    it('11 shared budgets still bind corrections', async () => {
        const core = stubCore({ test_runner: failTests(), change_propose: propResult('prop_2') });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            deps: D(core, { limits: { MAX_AGENT_STEPS: 4, MAX_TEST_RUNS: 3, MAX_CONTEXT_CALLS: 4 }, proposals: fakeProp() })
        });
        assert.equal(out.code, 'AGENT_STEP_LIMIT');
        assert.ok(!out.corrections.length);
    });
    it('14 corrections input validation', async () => {
        const core = stubCore();
        await assert.rejects(() => loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', proposalId: 'prop_1', corrections: 'x', deps: D(core, { proposals: fakeProp() }) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', proposalId: 'prop_1', corrections: [[{ path: 'a', content: 'b' }], [{ path: 'a', content: 'b' }], [{ path: 'a', content: 'b' }], [{ path: 'a', content: 'b' }]], deps: D(core, { proposals: fakeProp() }) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', proposalId: 'prop_1', corrections: [[]], deps: D(core, { proposals: fakeProp() }) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', proposalId: 'prop_1', correctionOffset: -1, deps: D(core, { proposals: fakeProp() }) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', proposalId: 'prop_1', corrections: [[{ path: '../evil', content: 'x' }]], deps: D(core, { proposals: fakeProp() }) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        assert.equal(core.calls.length, 0);
    });
});

describe('P3-8 stop conditions (stub core)', () => {
    it('8 rejection terminates with rejected status', async () => {
        const core = stubCore();
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            approval: APPROVAL,
            deps: D(core, { proposals: fakeProp('rejected') })
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.finalStatus, 'rejected');
        assert.equal(core.calls.length, 0);
    });
    it('9 stale correction terminates with stale semantics', async () => {
        const core = stubCore({
            change_apply: { error: Object.assign(new Error('file changed since proposal: a.js'), { code: 'PROPOSAL_STALE' }) }
        });
        const events = [];
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            approval: APPROVAL,
            onEvent: (e) => events.push(e),
            deps: D(core, { proposals: fakeProp() })
        });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.errorCode, 'PROPOSAL_STALE');
        assert.ok(events.some((e) => e.type === 'proposal_stale'));
    });
    it('10 cancellation during correction diagnose', async () => {
        const c = new AbortController();
        const core = stubCore({ test_runner: failTests() }, {
            onCall: () => {
                const names = core.calls.map((x) => x.opts.steps[0].name);
                if (names.includes('change_apply')) c.abort();
            }
        });
        await assert.rejects(() => loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            approval: APPROVAL, signal: c.signal,
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            deps: D(core, { proposals: fakeProp() })
        }), (e) => e.code === 'ABORTED');
    });
    it('12 isolation holds on the correction path', async () => {
        const core = stubCore();
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'bob', goal: 'fix', proposalId: 'prop_1',
            corrections: [[{ path: 'a.js', content: 'fix1' }]],
            deps: { core, workspaceService: { async getById() { throw Object.assign(new Error('workspace not found'), { status: 404, code: 'WORKSPACE_NOT_FOUND' }); } }, proposals: { async get() { throw new Error('must not reach proposals'); } } }
        });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(core.calls.length, 0);
    });
    it('21 no corrections + failing verify keeps legacy verdict', async () => {
        const core = stubCore({ test_runner: failTests() });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            deps: D(core, { limits: { MAX_AGENT_STEPS: 4, MAX_TEST_RUNS: 3, MAX_CONTEXT_CALLS: 4 }, proposals: fakeProp() })
        });
        assert.equal(out.finalStatus, 'tests_failing');
        assert.equal(out.correctionAttempts, 0);
        assert.deepEqual(out.corrections, []);
    });
});

describe('P3-8 real end-to-end correction chain', () => {
    function registerLoopTools(testRunnerExecute) {
        const { defineTool } = require('../src/services/tools/tool');
        const { codeContext } = require('../src/services/tools/codecontext');
        const gitTools = require('../src/services/tools/git');
        const changeTools = require('../src/services/tools/changeProposal');
        for (const t of [codeContext, gitTools.gitStatus, changeTools.changePropose, changeTools.changeGet, changeTools.changeApply, changeTools.changeReject]) {
            toolRegistry.register(t);
        }
        toolRegistry.register(defineTool({
            name: 'test_runner',
            capabilities: ['test.run'],
            description: 'File-backed test stub.',
            inputSchema: { type: 'object', properties: {} },
            readOnly: false,
            needsApproval: true,
            execute: testRunnerExecute
        }));
    }
    function fileVerdict(ws) {
        return async () => {
            const v = (await fsp.readFile(path.join(ws.rootPath, 'target.txt'), 'utf8')).trim();
            const pass = v === 'fixed';
            return { result: { ok: pass, code: pass ? 'TEST_PASS' : 'TEST_FAILED', exitCode: pass ? 0 : 1 }, mcpTools: ['test_runner'] };
        };
    }
    it('19 full chain: pause -> apply -> fail -> correct -> apply -> pass', async () => {
        toolRegistry._clearForTests();
        const ws = await makeWs('alice', { 'target.txt': 'broken\n' });
        registerLoopTools(fileVerdict(ws));
        const base = { workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice', goal: 'fix the failing tests' };
        const r1 = await loop.run({ ...base, edits: [{ path: 'target.txt', content: 'still-broken\n' }], approval: APPROVAL });
        assert.equal(r1.code, 'APPROVAL_REQUIRED');
        const r2 = await loop.run({
            ...base, proposalId: r1.proposalId, approval: APPROVAL,
            corrections: [[{ path: 'target.txt', content: 'fixed\n' }]]
        });
        assert.equal(r2.code, 'APPROVAL_REQUIRED');
        assert.equal(r2.correctionAttempts, 1);
        assert.notEqual(r2.proposalId, r1.proposalId);
        assert.equal((await fsp.readFile(path.join(ws.rootPath, 'target.txt'), 'utf8')), 'still-broken\n');
        const r3 = await loop.run({ ...base, proposalId: r2.proposalId, approval: APPROVAL, correctionOffset: r2.correctionAttempts });
        assert.equal(r3.code, 'AGENT_COMPLETED');
        assert.equal(r3.finalStatus, 'completed');
        assert.equal((await fsp.readFile(path.join(ws.rootPath, 'target.txt'), 'utf8')), 'fixed\n');
    });
    it('13 other user files are never touched by corrections', async () => {
        toolRegistry._clearForTests();
        const ws = await makeWs('alice', { 'target.txt': 'broken\n', 'precious.js': 'keep\n' });
        registerLoopTools(fileVerdict(ws));
        const base = { workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice', goal: 'fix' };
        const r1 = await loop.run({ ...base, edits: [{ path: 'target.txt', content: 'v1\n' }], approval: APPROVAL });
        const r2 = await loop.run({
            ...base, proposalId: r1.proposalId, approval: APPROVAL,
            corrections: [[{ path: 'target.txt', content: 'fixed\n' }]]
        });
        assert.equal(r2.code, 'APPROVAL_REQUIRED');
        assert.equal((await fsp.readFile(path.join(ws.rootPath, 'precious.js'), 'utf8')), 'keep\n');
    });
});
