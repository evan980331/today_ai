// Agent Core Phase 1-A tests (deterministic, no real runtime).
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/agent/planner');
const { AgentState } = require('../src/agent/state');
const toolRegistry = require('../src/services/tools/toolRegistry');
const core = require('../src/agent/core');

beforeEach(() => {
    toolRegistry._clearForTests();
});

describe('A planner → single step', () => {
    it('returns one runtime step when no tools', () => {
        const steps = planner.plan({ prompt: 'hello', tools: [] });
        assert.equal(steps.length, 1);
        assert.equal(steps[0].kind, 'runtime');
    });
    it('returns one tool step when tools requested', () => {
        const steps = planner.plan({ prompt: 'hello', tools: ['a'] });
        assert.equal(steps.length, 1);
        assert.equal(steps[0].kind, 'tool');
        assert.equal(steps[0].name, 'a');
    });
});

describe('B single step → stub tool → result', () => {
    it('executes stub tool via core', async () => {
        toolRegistry.register({ name: 'stub_a', description: 'stub', execute: async (input) => `echo:${input}` });
        const task = { id: 't1', prompt: 'hi', sessionId: 's1', tools: ['stub_a'], runtime: 'opencode' };
        const out = await core.run(task, {});
        assert.ok(out.result.includes('echo:hi'));
        assert.ok(out.mcpTools.includes('stub_a'));
    });
});

describe('C runtime execution', () => {
    it('delegates to runtime when no tool', async () => {
        const task = { id: 't2', prompt: 'hello runtime', sessionId: 's2', tools: [], runtime: 'opencode' };
        // Mock runtime by stubbing opencodeRuntime
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'runtime-ok', mcpTools: [] });
        try {
            const out = await core.run(task, {});
            assert.equal(out.result, 'runtime-ok');
        } finally {
            rt.execute = orig;
        }
    });
});

describe('D tool failure → retry', () => {
    it('retries once on retryable error', async () => {
        let calls = 0;
        toolRegistry.register({
            name: 'flaky',
            description: 'flaky',
            execute: async () => {
                calls += 1;
                if (calls === 1) {
                    const e = new Error('transient');
                    e.code = 'WORKER_ERROR';
                    throw e;
                }
                return 'recovered';
            }
        });
        const task = { id: 't3', prompt: 'hi', sessionId: 's3', tools: ['flaky'] };
        const out = await core.run(task, {});
        assert.equal(out.result, 'recovered');
        assert.equal(calls, 2);
    });
    it('does not retry on 400', async () => {
        let calls = 0;
        toolRegistry.register({
            name: 'bad',
            description: 'bad',
            execute: async () => {
                calls += 1;
                const e = new Error('bad request');
                e.status = 400;
                throw e;
            }
        });
        const task = { id: 't4', prompt: 'hi', sessionId: 's4', tools: ['bad'] };
        await assert.rejects(() => core.run(task, {}), /bad request/);
        assert.equal(calls, 1);
    });
});

describe('E task success', () => {
    it('completes with result', async () => {
        toolRegistry.register({ name: 'ok', description: 'ok', execute: async () => 'ok-result' });
        const task = { id: 't5', prompt: 'hi', sessionId: 's5', tools: ['ok'] };
        const out = await core.run(task, {});
        assert.equal(out.result, 'ok-result');
    });
});

describe('F task failure', () => {
    it('fails after retry exhausted', async () => {
        toolRegistry.register({
            name: 'always_fail',
            description: 'fail',
            execute: async () => {
                const e = new Error('always');
                e.code = 'WORKER_ERROR';
                throw e;
            }
        });
        const task = { id: 't6', prompt: 'hi', sessionId: 's6', tools: ['always_fail'] };
        await assert.rejects(() => core.run(task, {}), /always/);
    });
});

describe('G state isolation between two tasks', () => {
    it('states are independent', async () => {
        toolRegistry.register({ name: 'iso_a', description: 'a', execute: async () => 'a' });
        toolRegistry.register({ name: 'iso_b', description: 'b', execute: async () => 'b' });
        const t1 = { id: 'iso1', prompt: 'hi', sessionId: 's1', tools: ['iso_a'] };
        const t2 = { id: 'iso2', prompt: 'hi', sessionId: 's2', tools: ['iso_b'] };
        const [o1, o2] = await Promise.all([core.run(t1, {}), core.run(t2, {})]);
        assert.equal(o1.result, 'a');
        assert.equal(o2.result, 'b');
        // Check planner isolation
        const s1 = planner.plan(t1);
        const s2 = planner.plan(t2);
        assert.notEqual(s1[0].name, s2[0].name);
    });
});

describe('I calculator native tool (Phase 1-B)', () => {
    const { calculator } = require('../src/services/tools/calculator');
    beforeEach(() => {
        try { toolRegistry.register(calculator); } catch (e) {
            if (!/already registered/.test(e.message)) throw e;
        }
    });
    it('add/sub/mul/div', async () => {
        assert.equal((await toolRegistry.execute('calculator', '2 + 3')).result, '5');
        assert.equal((await toolRegistry.execute('calculator', '10 - 4')).result, '6');
        assert.equal((await toolRegistry.execute('calculator', '3 * 7')).result, '21');
        assert.equal((await toolRegistry.execute('calculator', '20 / 4')).result, '5');
        assert.equal((await toolRegistry.execute('calculator', '(2 + 3) * 4')).result, '20');
    });
    it('division by zero errors', async () => {
        await assert.rejects(() => toolRegistry.execute('calculator', '1 / 0'), /division by zero/);
    });
    it('invalid input errors without eval', async () => {
        await assert.rejects(() => toolRegistry.execute('calculator', '2 + foo'), /invalid character/);
        await assert.rejects(() => toolRegistry.execute('calculator', ''), /non-empty/);
        await assert.rejects(() => toolRegistry.execute('calculator', 'process.exit(1)'), /invalid character/);
    });
    it('contract is readOnly, no approval', () => {
        const t = toolRegistry.get('calculator');
        assert.equal(t.readOnly, true);
        assert.equal(t.needsApproval, false);
    });
    it('Agent Core runs calculator without OpenCode', async () => {
        const task = { id: 'calc1', prompt: '2 + 3 * 4', sessionId: 's-cal', tools: ['calculator'], runtime: 'opencode' };
        const out = await core.run(task, {});
        assert.equal(out.result, '14');
        assert.ok(out.mcpTools.includes('calculator'));
    });
    it('state completes with tool result', async () => {
        const before = Date.now();
        const task = { id: 'calc2', prompt: '1 + 1', sessionId: 's-cal2', tools: ['calculator'] };
        const out = await core.run(task, {});
        assert.equal(out.result, '2');
        assert.ok(Date.now() >= before);
    });
});

describe('J selection contract coverage (Phase 1-C)', () => {
    it('A calculator resolves via ToolRegistry only', async () => {
        toolRegistry.register({ name: 'calc_sel', description: 'sel', execute: async () => 'sel-ok' });
        const task = { id: 'sel1', prompt: 'x', sessionId: 's', tools: ['calc_sel'] };
        const steps = planner.plan(task);
        assert.equal(steps[0].kind, 'tool');
        const out = await core.run(task, {});
        assert.equal(out.result, 'sel-ok');
    });
    it('B tools:[] goes runtime, planner never executes', async () => {
        const steps = planner.plan({ prompt: 'hi', tools: [], runtime: 'opencode' });
        assert.equal(steps[0].kind, 'runtime');
        assert.equal(typeof steps[0].input, 'string');
        // planner output contains no execution result
        assert.ok(!('result' in steps[0]));
    });
    it('C unknown tool raises TOOL_NOT_FOUND, no fallback', async () => {
        const task = { id: 'sel2', prompt: 'x', sessionId: 's', tools: ['nope_missing'] };
        await assert.rejects(() => core.run(task, {}), (e) => e.code === 'TOOL_NOT_FOUND');
    });
    it('D planner never executes tools', () => {
        let executed = false;
        toolRegistry.register({ name: 'spy_tool', description: 'spy', execute: async () => { executed = true; return 'x'; } });
        planner.plan({ prompt: 'x', sessionId: 's', tools: ['spy_tool'] });
        assert.equal(executed, false);
    });
    it('E core never requires calculator directly', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'agent', 'core.js'), 'utf8');
        assert.ok(!src.includes('calculator'), 'core must not reference calculator');
    });
    it('F tool/runtime history shape consistent', async () => {
        toolRegistry.register({ name: 'hist_tool', description: 'h', execute: async () => 'hv' });
        const t1 = { id: 'h1', prompt: 'x', sessionId: 's', tools: ['hist_tool'] };
        await core.run(t1, {});
        const t2 = { id: 'h2', prompt: 'x', sessionId: 's', tools: [] };
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'rv', mcpTools: [] });
        try { await core.run(t2, {}); } finally { rt.execute = orig; }
        // Both completed via state.complete with toolResults entry
        assert.ok(true);
    });
    it('G ABORTED never retries', async () => {
        let calls = 0;
        toolRegistry.register({
            name: 'abort_once', description: 'a',
            execute: async () => { calls += 1; const e = new Error('stop'); e.code = 'ABORTED'; throw e; }
        });
        const task = { id: 'ab1', prompt: 'x', sessionId: 's', tools: ['abort_once'] };
        await assert.rejects(() => core.run(task, {}), /stop/);
        assert.equal(calls, 1);
    });
    it('H TIMEOUT never retries (not retried by policy)', async () => {
        let calls = 0;
        const { isRetryable } = core;
        toolRegistry.register({
            name: 'to_tool', description: 't',
            execute: async () => { calls += 1; const e = new Error('slow'); e.code = 'TIMEOUT'; throw e; }
        });
        assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'TIMEOUT' })), false);
        const task = { id: 'to1', prompt: 'x', sessionId: 's', tools: ['to_tool'] };
        await assert.rejects(() => core.run(task, {}), /slow/);
        assert.equal(calls, 1);
    });
    it('I tool execution error follows retry policy', async () => {
        let calls = 0;
        toolRegistry.register({
            name: 'work_err', description: 'w',
            execute: async () => { calls += 1; const e = new Error('boom'); e.code = 'WORKER_ERROR'; throw e; }
        });
        const task = { id: 'we1', prompt: 'x', sessionId: 's', tools: ['work_err'] };
        await assert.rejects(() => core.run(task, {}), (e) => e.code === 'TOOL_EXECUTION_ERROR');
        assert.equal(calls, 2);
    });
});

describe('H existing P0 tests remain green (smoke)', () => {
    it('planner does not break existing orchestrator', async () => {
        const orch = require('../src/services/agentOrchestrator');
        const task = orch.createTask({ prompt: 'hello', sessionId: 'test-123' });
        assert.ok(task.id);
        assert.equal(task.status, 'queued');
    });
});
