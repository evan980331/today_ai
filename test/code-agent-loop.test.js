// P3-6 Code Agent Loop tests (P3-7: edits go through change_propose and
// pause with APPROVAL_REQUIRED; resume via proposalId + human approval).
//
// Unit tests cover plan building/validation/budgets with an injected stub
// core. Integration tests use the REAL Agent Core + ToolRegistry against
// temporary fixture workspaces (never the real repo).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const loop = require('../src/services/codeAgentLoopService');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p36-test-${Date.now()}-${(n += 1)}`;
const APPROVED = { approval: { status: 'approved' } };
const APPROVAL = { status: 'approved' };

// Stub Agent Core: script maps tool name -> { result } data or { error }.
// Emulates core.run(task, opts) shape and honors pre-aborted signals.
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

const failTests = () => ({ ok: false, code: 'TEST_FAILED', exitCode: 1 });
const passTests = () => ({ ok: true, code: 'TEST_PASS', exitCode: 0 });

// Fake proposal lookup for stub-core resume runs.
const fakeProp = (status = 'pending') => ({
    async get() { return { proposalId: 'prop_1', status, workspaceId: 'ws_1', changes: [] }; }
});
// Fake owner-scoped workspace resolution for stub-core runs (no disk).
const fakeWs = (id = 'ws_1') => ({
    async getById(wid) { return { workspaceId: wid }; },
    async getCurrent() { return { workspaceId: id }; }
});
const D = (core, extra = {}) => ({ core, workspaceService: fakeWs(), ...extra });

async function writeFixture(root, rel, content) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
}

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-loop-test-'));
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
});

describe('P3-6 plan building', () => {
    it('1 plan order without edits: inspect -> status -> test', () => {
        const plan = loop.buildPlan({ goal: 'fix the failing tests', workspaceId: 'ws_x' });
        assert.deepEqual(plan.map((s) => s.tool), ['code_context', 'git_status', 'test_runner']);
        assert.deepEqual(plan.map((s) => s.type), ['inspect', 'status', 'test']);
    });
    it('2 plan with edits appends one propose step (no direct writes)', () => {
        const plan = loop.buildPlan({ goal: 'fix it', workspaceId: 'ws_x', edits: [{ path: 'a.js', content: '1' }] });
        assert.deepEqual(plan.map((s) => s.tool), ['code_context', 'git_status', 'test_runner', 'change_propose']);
        assert.deepEqual(plan[3].input.changes, [{ path: 'a.js', content: '1' }]);
    });
    it('2b resume plan is apply + verify', () => {
        const plan = loop.buildPlan({ goal: 'fix it', workspaceId: 'ws_x', proposalId: 'prop_1' });
        assert.deepEqual(plan.map((s) => s.tool), ['change_apply', 'test_runner']);
    });
    it('3 plan with checks adds command steps', () => {
        const plan = loop.buildPlan({ goal: 'check', checks: [{ executable: 'node', args: ['--version'] }] });
        assert.ok(plan.some((s) => s.tool === 'command_execute' && s.type === 'command'));
    });
    it('4 constants: 12 / 3 / 4', () => {
        assert.equal(loop.MAX_AGENT_STEPS, 12);
        assert.equal(loop.MAX_TEST_RUNS, 3);
        assert.equal(loop.MAX_CONTEXT_CALLS, 4);
    });
});

describe('P3-6 plan validation', () => {
    it('5 malformed plans rejected', () => {
        assert.throws(() => loop.validateSteps(null), (e) => e.code === 'PLANNING_ERROR');
        assert.throws(() => loop.validateSteps([null]), (e) => e.code === 'PLANNING_ERROR');
        assert.throws(() => loop.validateSteps([{ type: 'nope', tool: 'code_context' }]), (e) => e.code === 'PLANNING_ERROR');
        assert.throws(() => loop.validateSteps([{ type: 'inspect' }]), (e) => e.code === 'PLANNING_ERROR');
    });
    it('6 forbidden tools rejected (git_add / git_commit / direct writes)', () => {
        for (const tool of ['git_add', 'git_commit', 'filesystem.write', 'filesystem.createDirectory']) {
            assert.throws(() => loop.validateSteps([{ type: 'apply', tool, input: {} }]), (e) => e.code === 'PLANNING_ERROR', tool);
        }
    });
    it('7 unknown tools rejected', () => {
        assert.throws(() => loop.validateSteps([{ type: 'test', tool: 'git_push' }]), (e) => e.code === 'PLANNING_ERROR');
        assert.throws(() => loop.validateSteps([{ type: 'command', tool: 'powershell' }]), (e) => e.code === 'PLANNING_ERROR');
    });
    it('8 goal validation', async () => {
        const core = stubCore();
        await assert.rejects(() => loop.run({ owner: 'alice', goal: '' }, ), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => loop.run({ owner: 'alice', goal: 'x'.repeat(2001), deps: D(core) }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('9 edits validation', async () => {
        const core = stubCore();
        await assert.rejects(() => loop.run({ owner: 'alice', goal: 'g', edits: 'x', deps: D(core) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => loop.run({ owner: 'alice', goal: 'g', edits: new Array(11).fill({ path: 'a', content: 'b' }), deps: D(core) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => loop.run({ owner: 'alice', goal: 'g', edits: [{ path: '', content: 'b' }], deps: D(core) }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('10 owner validation', async () => {
        const core = stubCore();
        await assert.rejects(() => loop.run({ owner: '', goal: 'g', deps: D(core) }), (e) => e.code === 'TOOL_INVALID_INPUT');
        assert.equal(core.calls.length, 0);
    });
});

describe('P3-6 bounded execution (stub core)', () => {
    it('11 code_context -> test flow, tools used in order', async () => {
        const core = stubCore({ test_runner: passTests() });
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'fix the failing tests', deps: D(core) });
        assert.equal(out.ok, true);
        assert.equal(out.code, 'AGENT_COMPLETED');
        assert.deepEqual(out.toolsUsed, ['code_context', 'git_status', 'test_runner']);
        assert.equal(out.steps.length, 3);
        assert.equal(out.tests.length, 1);
        assert.equal(out.tests[0].code, 'TEST_PASS');
    });
    it('12 edits pause at APPROVAL_REQUIRED (no direct write)', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_propose: { result: { proposalId: 'prop_9', status: 'pending', changes: [{ path: 'a.js' }] } }
        });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix it',
            edits: [{ path: 'a.js', content: '1' }, { path: 'b.js', content: '2' }],
            deps: D(core)
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'APPROVAL_REQUIRED');
        assert.equal(out.proposalId, 'prop_9');
        assert.equal(out.proposalStatus, 'pending');
        assert.deepEqual(out.toolsUsed, ['code_context', 'git_status', 'test_runner', 'change_propose']);
        const names = core.calls.map((c) => c.opts.steps[0].name);
        assert.ok(!names.includes('filesystem.write'));
        assert.ok(!names.includes('change_apply'));
    });
    it('13 bounded MAX_AGENT_STEPS', async () => {
        const core = stubCore({ test_runner: passTests() });
        const edits = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.js`, content: 'x' }));
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'big fix', edits,
            deps: D(core, { limits: { MAX_AGENT_STEPS: 3, MAX_TEST_RUNS: 3, MAX_CONTEXT_CALLS: 4 } })
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_STEP_LIMIT');
        assert.ok(out.failureReason.includes('3'));
        assert.equal(out.steps.length, 3);
        assert.equal(core.calls.length, 3);
    });
    it('14 MAX_TEST_RUNS limit (resume path)', async () => {
        const core = stubCore({ test_runner: failTests() });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            deps: D(core, { limits: { MAX_AGENT_STEPS: 12, MAX_TEST_RUNS: 1, MAX_CONTEXT_CALLS: 4 }, proposals: fakeProp() })
        });
        assert.equal(out.code, 'AGENT_STEP_LIMIT');
        assert.ok(out.failureReason.includes('test run limit'));
    });
    it('15 MAX_CONTEXT_CALLS limit (resume path)', async () => {
        const core = stubCore({ test_runner: failTests() });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            deps: D(core, { limits: { MAX_AGENT_STEPS: 12, MAX_TEST_RUNS: 3, MAX_CONTEXT_CALLS: 1 }, proposals: fakeProp() })
        });
        assert.equal(out.code, 'AGENT_STEP_LIMIT');
        assert.ok(out.failureReason.includes('context call limit'));
    });
    it('16 tool failure maps to AGENT_TOOL_FAILED', async () => {
        const core = stubCore({ git_status: { error: Object.assign(new Error('boom'), { code: 'GIT_FAILED' }) } });
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', deps: D(core) });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.failureReason, 'boom');
        assert.equal(out.finalStatus, 'failed');
    });
    it('17 forbidden executable via checks is not bypassed', async () => {
        registerNativeTools(toolRegistry);
        const ws = await WorkspaceService.default().create({ sessionId: sid(), owner: 'alice' });
        const out = await loop.run({
            workspaceId: ws.workspaceId, owner: 'alice', goal: 'run checks',
            checks: [{ executable: 'powershell', args: ['-x'] }],
            approval: APPROVAL
        });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
    });
    it('18 git_add / git_commit / direct writes never auto-called', async () => {
        const core = stubCore({
            test_runner: passTests(),
            change_propose: { result: { proposalId: 'prop_9', status: 'pending', changes: [] } }
        });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix and commit please',
            edits: [{ path: 'a.js', content: '1' }],
            deps: D(core)
        });
        const names = core.calls.map((c) => c.opts.steps[0].name);
        for (const banned of ['git_add', 'git_commit', 'filesystem.write', 'filesystem.createDirectory', 'change_apply']) {
            assert.ok(!names.includes(banned), banned);
        }
        assert.ok(!out.toolsUsed.includes('git_add'));
        assert.equal(out.code, 'APPROVAL_REQUIRED');
    });
    it('19 approval forwarded to core context', async () => {
        const core = stubCore({ test_runner: passTests() });
        await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', approval: APPROVAL, deps: D(core) });
        for (const c of core.calls) {
            assert.deepEqual(c.opts.approval, APPROVAL);
            assert.equal(c.opts.signal, null);
        }
    });
});

describe('P3-6 isolation + cancellation (stub core)', () => {
    it('20 run rejects cross-owner workspaces', async () => {
        registerNativeTools(toolRegistry);
        const ws = await WorkspaceService.default().create({ sessionId: sid(), owner: 'alice' });
        const out = await loop.run({ workspaceId: ws.workspaceId, owner: 'bob', goal: 'inspect', approval: APPROVAL });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
    });
    it('21 workspace isolation via session scope', async () => {
        const core = stubCore({
            code_context: { result: { workspace: { workspaceId: 'WS-A' } } },
            test_runner: passTests()
        });
        const out = await loop.run({ sessionId: 'sess-a', owner: 'alice', goal: 'g', deps: D(core) });
        for (const c of core.calls) {
            assert.equal(c.opts.steps[0].input.sessionId, 'sess-a');
        }
        assert.equal(out.sessionId, 'sess-a');
    });
    it('22 pre-aborted signal rejects ABORTED without running', async () => {
        const core = stubCore();
        const c = new AbortController();
        c.abort();
        await assert.rejects(() => loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', signal: c.signal, deps: D(core) }), (e) => e.code === 'ABORTED');
        assert.equal(core.calls.length, 0);
    });
    it('23 mid-run abort stops before the next step', async () => {
        const c = new AbortController();
        const core = stubCore({ test_runner: passTests() }, {
            onCall: () => {
                if (core.calls.length === 1) c.abort();
            }
        });
        await assert.rejects(() => loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', signal: c.signal, deps: D(core) }), (e) => e.code === 'ABORTED');
        assert.equal(core.calls.length, 1);
    });
});

describe('P3-6 results + events (stub core)', () => {
    it('24 final completed result shape', async () => {
        const core = stubCore({ test_runner: passTests() });
        const out = await loop.run({ workspaceId: 'ws_9', owner: 'alice', goal: 'fix it', deps: D(core) });
        assert.equal(out.ok, true);
        assert.equal(out.code, 'AGENT_COMPLETED');
        assert.equal(out.finalStatus, 'completed');
        assert.equal(out.failureReason, null);
        assert.ok(Array.isArray(out.plan) && out.plan.length === 3);
        assert.ok(Array.isArray(out.steps));
        assert.deepEqual(out.limits, { MAX_AGENT_STEPS: 12, MAX_TEST_RUNS: 3, MAX_CONTEXT_CALLS: 4 });
    });
    it('25 final failed result on tool error', async () => {
        const core = stubCore({ code_context: { error: Object.assign(new Error('ctx down'), { status: 500 }) } });
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', deps: D(core) });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.equal(out.failureReason, 'ctx down');
    });
    it('26 failing baseline tests complete as tests_failing', async () => {
        const core = stubCore({ test_runner: failTests() });
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'fix the failing tests', deps: D(core) });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'AGENT_COMPLETED');
        assert.equal(out.finalStatus, 'tests_failing');
        assert.ok(out.failureReason.includes('TEST_FAILED'));
    });
    it('27 resume verify-fail re-inspect stays bounded', async () => {
        const core = stubCore({ test_runner: failTests() });
        const out = await loop.run({
            workspaceId: 'ws_1', owner: 'alice', goal: 'fix', proposalId: 'prop_1',
            deps: D(core, { proposals: fakeProp() })
        });
        assert.ok(core.calls.length <= 12);
        assert.ok(out.tests.length >= 2, 'verify ran at least twice (apply-verify + re-inspect)');
        assert.ok(['AGENT_STEP_LIMIT', 'AGENT_COMPLETED'].includes(out.code));
    });
    it('28 SSE-compatible event contract', async () => {
        const core = stubCore({ test_runner: passTests() });
        const events = [];
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', onEvent: (e) => events.push(e), deps: D(core) });
        const types = events.map((e) => e.type);
        assert.equal(types[0], 'message.started');
        assert.equal(types[types.length - 1], 'message.completed');
        assert.ok(types.includes('tool.started') && types.includes('tool.completed'));
        assert.ok(events.every((e) => ['message.started', 'tool.started', 'tool.completed', 'message.completed', 'error'].includes(e.type)));
        assert.equal(out.ok, true);
    });
    it('29 error event on tool failure', async () => {
        const core = stubCore({ git_status: { error: Object.assign(new Error('nope'), { status: 500 }) } });
        const events = [];
        const out = await loop.run({ workspaceId: 'ws_1', owner: 'alice', goal: 'g', onEvent: (e) => events.push(e), deps: D(core) });
        assert.equal(out.code, 'AGENT_TOOL_FAILED');
        assert.ok(events.some((e) => e.type === 'error'));
    });
});

describe('P3-6 regression + real integration', () => {
    // Real registry with every native tool EXCEPT test_runner, which is
    // replaced by a stub: on this Windows box the P3-3 cmd-launcher
    // quoting breaks real `npm test` (env issue, out of P3-6 scope), so
    // the stub emulates the fixture's check.js verdict by reading the
    // real file the loop's edits write.
    function registerRealExceptTestRunner(testRunnerExecute) {
        const { defineTool } = require('../src/services/tools/tool');
        const { codeContext } = require('../src/services/tools/codecontext');
        const { commandExecute } = require('../src/services/tools/command');
        const gitTools = require('../src/services/tools/git');
        const fsTools = require('../src/services/tools/filesystem');
        for (const t of [codeContext, commandExecute, gitTools.gitStatus, gitTools.gitDiff, gitTools.gitLog, gitTools.gitBranch, fsTools.filesystemRead, fsTools.filesystemList, fsTools.filesystemWrite, fsTools.filesystemCreateDirectory]) {
            toolRegistry.register(t);
        }
        toolRegistry.register(defineTool({
            name: 'test_runner',
            capabilities: ['test.run'],
            description: 'Stub test_runner for loop integration tests.',
            inputSchema: { type: 'object', properties: {} },
            readOnly: false,
            needsApproval: true,
            execute: testRunnerExecute
        }));
    }
    it('30 no direct process/filesystem access in the loop service', async () => {
        const file = path.join(__dirname, '..', 'src', 'services', 'codeAgentLoopService.js');
        const src = await fsp.readFile(file, 'utf8');
        assert.ok(!/require\(['"]fs['"]\)/.test(src));
        assert.ok(!/fs\/promises/.test(src));
        assert.ok(!/child_process/.test(src));
        assert.ok(!/spawn\s*\(/.test(src));
        assert.ok(!/execFile\s*\(/.test(src));
        assert.ok(!/[^a-zA-Z]exec\s*\(/.test(src));
        assert.ok(!/gitService|commandService|testRunnerService/.test(src), 'must go through core/registry, not services directly');
        assert.ok(!loop.AUTO_TOOLS.has('filesystem.write'), 'loop must not auto-write');
        assert.ok(loop.FORBIDDEN_TOOLS.has('filesystem.write'), 'direct writes are forbidden plans');
        assert.ok(loop.AUTO_TOOLS.has('change_propose') && loop.AUTO_TOOLS.has('change_apply'));
    });
    it('31 real loop completes on a passing fixture', async () => {
        toolRegistry._clearForTests();
        registerRealExceptTestRunner(async () => ({
            result: { ok: true, code: 'TEST_PASS', workspaceId: 'ws', command: { executable: 'npm', args: ['test'] }, exitCode: 0, stdout: 'pass', stderr: '', timedOut: false, durationMs: 1, truncated: false },
            mcpTools: ['test_runner']
        }));
        const ws = await WorkspaceService.default().create({ sessionId: sid(), owner: 'alice' });
        await writeFixture(ws.rootPath, 'app.js', 'module.exports = 1;');
        const out = await loop.run({ workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice', goal: 'verify the tests pass', approval: APPROVAL });
        assert.equal(out.code, 'AGENT_COMPLETED');
        assert.equal(out.finalStatus, 'completed');
        assert.equal(out.tests.length, 1);
        assert.equal(out.tests[0].code, 'TEST_PASS');
        assert.ok(out.toolsUsed.includes('code_context'));
    });
    it('32 real propose-pause-resume flips a failing fixture (no direct write)', async () => {
        toolRegistry._clearForTests();
        const ws = await WorkspaceService.default().create({ sessionId: sid(), owner: 'alice' });
        await writeFixture(ws.rootPath, 'target.txt', 'broken\n');
        const { codeContext } = require('../src/services/tools/codecontext');
        const gitTools = require('../src/services/tools/git');
        const changeTools = require('../src/services/tools/changeProposal');
        const { defineTool } = require('../src/services/tools/tool');
        for (const t of [codeContext, gitTools.gitStatus, changeTools.changePropose, changeTools.changeGet, changeTools.changeApply, changeTools.changeReject]) {
            toolRegistry.register(t);
        }
        toolRegistry.register(defineTool({
            name: 'test_runner',
            capabilities: ['test.run'],
            description: 'Stub test_runner reading the real fixture file.',
            inputSchema: { type: 'object', properties: {} },
            readOnly: false,
            needsApproval: true,
            execute: async () => {
                const v = (await fsp.readFile(path.join(ws.rootPath, 'target.txt'), 'utf8')).trim();
                const pass = v === 'fixed';
                return {
                    result: { ok: pass, code: pass ? 'TEST_PASS' : 'TEST_FAILED', exitCode: pass ? 0 : 1 },
                    mcpTools: ['test_runner']
                };
            }
        }));
        const base = { workspaceId: ws.workspaceId, sessionId: ws.sessionId, owner: 'alice', goal: 'fix the failing tests' };
        const paused = await loop.run({ ...base, edits: [{ path: 'target.txt', content: 'fixed\n' }], approval: APPROVAL });
        assert.equal(paused.code, 'APPROVAL_REQUIRED');
        assert.ok(typeof paused.proposalId === 'string' && paused.proposalId.startsWith('prop_'));
        assert.equal(paused.proposalStatus, 'pending');
        assert.equal((await fsp.readFile(path.join(ws.rootPath, 'target.txt'), 'utf8')), 'broken\n');
        const done = await loop.run({ ...base, proposalId: paused.proposalId, approval: APPROVAL });
        assert.equal(done.code, 'AGENT_COMPLETED');
        assert.equal(done.finalStatus, 'completed');
        assert.equal(done.tests[done.tests.length - 1].code, 'TEST_PASS');
        assert.equal((await fsp.readFile(path.join(ws.rootPath, 'target.txt'), 'utf8')), 'fixed\n');
    });
});
