// P2-I controlled multi-step execution tests.
// Deterministic: explicit step injection only, no LLM, no replanning.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/agent/planner');
const core = require('../src/agent/core');
const { AgentState } = require('../src/agent/state');
const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');

let calls;

beforeEach(() => {
    toolRegistry._clearForTests();
    calls = {};
    const mk = (name, fn) => toolRegistry.register({
        name, description: name,
        execute: async (input) => {
            calls[name] = (calls[name] || 0) + 1;
            return fn(input);
        }
    });
    mk('ms_a', (i) => `A:${i}`);
    mk('ms_b', (i) => `B:${i}`);
    mk('ms_c', (i) => `C:${i}`);
});

const task = (id = 'm1') => ({ id, prompt: 'x', sessionId: 's' });
const APPROVED = { approval: { status: 'approved' } };

describe('P2-I A basic', () => {
    it('1 single step still works', async () => {
        const out = await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_a', input: '1' }] });
        assert.equal(out.status, 'completed');
        assert.equal(out.result, 'A:1');
        assert.deepEqual(out.mcpTools, ['ms_a']);
        assert.equal(out.steps.length, 1);
        assert.equal(out.steps[0].status, 'completed');
    });
    it('2 two tool steps execute in order', async () => {
        const order = [];
        toolRegistry._clearForTests();
        for (const n of ['ms_a', 'ms_b']) {
            toolRegistry.register({ name: n, description: n, execute: async () => { order.push(n); return n; } });
        }
        const out = await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_a' }, { kind: 'tool', name: 'ms_b' }] });
        assert.deepEqual(order, ['ms_a', 'ms_b']);
        assert.equal(out.result, 'ms_b');
    });
    it('3 three tool steps execute in order', async () => {
        const out = await core.run(task(), {
            steps: [
                { kind: 'tool', name: 'ms_a', input: '1' },
                { kind: 'tool', name: 'ms_b', input: '2' },
                { kind: 'tool', name: 'ms_c', input: '3' }
            ]
        });
        assert.equal(out.steps.map((s) => s.status).join(','), 'completed,completed,completed');
        assert.equal(out.result, 'C:3');
        assert.deepEqual(out.mcpTools, ['ms_a', 'ms_b', 'ms_c']);
    });
    it('4 results preserved independently', async () => {
        const out = await core.run(task(), {
            steps: [
                { kind: 'tool', name: 'ms_a', input: '1' },
                { kind: 'tool', name: 'ms_b', input: '2' }
            ]
        });
        assert.equal(out.steps[0].result.result, 'A:1');
        assert.equal(out.steps[1].result.result, 'B:2');
        assert.equal(out.steps[0].error, null);
    });
});

describe('P2-I B mixed execution', () => {
    it('5 tool -> tool', async () => {
        const out = await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_a' }, { kind: 'tool', name: 'ms_b' }] });
        assert.equal(out.status, 'completed');
    });
    it('6 runtime -> tool', async () => {
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'r-ok', mcpTools: [] });
        try {
            const out = await core.run(task(), {
                steps: [{ kind: 'runtime', name: 'opencode', input: 'hi' }, { kind: 'tool', name: 'ms_a', input: '1' }]
            });
            assert.equal(out.steps[0].status, 'completed');
            assert.equal(out.steps[1].status, 'completed');
            assert.equal(out.result, 'A:1');
        } finally {
            rt.execute = orig;
        }
    });
    it('7 tool -> runtime', async () => {
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'r-done', mcpTools: [] });
        try {
            const out = await core.run(task(), {
                steps: [{ kind: 'tool', name: 'ms_a', input: '1' }, { kind: 'runtime', name: 'opencode', input: 'hi' }]
            });
            assert.equal(out.result, 'r-done');
            assert.deepEqual(out.mcpTools, ['ms_a']);
        } finally {
            rt.execute = orig;
        }
    });
    it('8 runtime -> runtime', async () => {
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        let n = 0;
        rt.execute = async () => { n += 1; return { result: `r${n}`, mcpTools: [] }; };
        try {
            const out = await core.run(task(), {
                steps: [{ kind: 'runtime', name: 'opencode', input: 'a' }, { kind: 'runtime', name: 'opencode', input: 'b' }]
            });
            assert.equal(out.result, 'r2');
            assert.equal(out.steps.length, 2);
        } finally {
            rt.execute = orig;
        }
    });
});

describe('P2-I C failure policy', () => {
    it('9 step1 failure stops plan', async () => {
        toolRegistry.register({
            name: 'ms_fail', description: 'f',
            execute: async () => { throw Object.assign(new Error('boom'), { code: 'WORKER_ERROR' }); }
        });
        await assert.rejects(() => core.run(task(), {
            steps: [{ kind: 'tool', name: 'ms_fail' }, { kind: 'tool', name: 'ms_a', input: '1' }]
        }), /boom/);
        assert.equal(calls.ms_a || 0, 0);
    });
    it('10 later steps become skipped', async () => {
        toolRegistry.register({
            name: 'ms_fail', description: 'f',
            execute: async () => { throw Object.assign(new Error('boom'), { code: 'WORKER_ERROR' }); }
        });
        try {
            await core.run(task(), {
                steps: [{ kind: 'tool', name: 'ms_fail' }, { kind: 'tool', name: 'ms_a' }, { kind: 'tool', name: 'ms_b' }]
            });
            assert.fail('should throw');
        } catch (e) {
            assert.deepEqual(e.steps.map((s) => s.status), ['failed', 'skipped', 'skipped']);
        }
    });
    it('11 failed step result preserved', async () => {
        toolRegistry.register({
            name: 'ms_fail', description: 'f',
            execute: async () => { throw Object.assign(new Error('boom-info'), { code: 'WORKER_ERROR' }); }
        });
        try {
            await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_a', input: '1' }, { kind: 'tool', name: 'ms_fail' }] });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.steps[0].status, 'completed');
            assert.equal(e.steps[0].result.result, 'A:1');
            assert.equal(e.steps[1].status, 'failed');
            assert.ok(e.steps[1].error.includes('boom-info'));
        }
    });
    it('12 final status failed', async () => {
        toolRegistry.register({
            name: 'ms_fail', description: 'f',
            execute: async () => { const e = new Error('nope'); e.status = 400; throw e; }
        });
        await assert.rejects(() => core.run(task(), { steps: [{ kind: 'tool', name: 'ms_fail' }] }), /nope/);
    });
});

describe('P2-I D permission in multi-step', () => {
    it('13 write tool without approval stops plan', async () => {
        registerNativeTools(toolRegistry);
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2i-'));
        const saved = process.env.WORKSPACE_ROOT;
        process.env.WORKSPACE_ROOT = root;
        try {
            await assert.rejects(() => core.run(task(), {
                steps: [
                    { kind: 'tool', name: 'filesystem.write', input: { path: 'a.txt', content: 'x' } },
                    { kind: 'tool', name: 'ms_a', input: '1' }
                ]
            }), (e) => e.code === 'PERMISSION_REQUIRED');
            assert.equal(calls.ms_a || 0, 0);
            assert.ok(!fs.existsSync(path.join(root, 'a.txt')));
        } finally {
            if (saved === undefined) delete process.env.WORKSPACE_ROOT;
            else process.env.WORKSPACE_ROOT = saved;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('14 later steps skipped on permission error', async () => {
        registerNativeTools(toolRegistry);
        try {
            await core.run(task(), {
                steps: [
                    { kind: 'tool', name: 'filesystem.write', input: { path: 'a.txt', content: 'x' } },
                    { kind: 'tool', name: 'ms_b', input: '2' }
                ]
            });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.code, 'PERMISSION_REQUIRED');
            assert.deepEqual(e.steps.map((s) => s.status), ['failed', 'skipped']);
        }
    });
    it('15 approved write tool executes mid-plan', async () => {
        registerNativeTools(toolRegistry);
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2i-'));
        const saved = process.env.WORKSPACE_ROOT;
        process.env.WORKSPACE_ROOT = root;
        try {
            const out = await core.run(task(), {
                steps: [
                    { kind: 'tool', name: 'filesystem.write', input: { path: 'a.txt', content: 'hi' } },
                    { kind: 'tool', name: 'ms_a', input: '1' }
                ],
                approval: { status: 'approved' }
            });
            assert.equal(out.status, 'completed');
            assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hi');
            assert.equal(out.result, 'A:1');
        } finally {
            if (saved === undefined) delete process.env.WORKSPACE_ROOT;
            else process.env.WORKSPACE_ROOT = saved;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('16 permission error does not retry', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => core.run(task(), {
            steps: [
                { kind: 'tool', name: 'filesystem.write', input: { path: 'a.txt', content: 'x' } },
                { kind: 'tool', name: 'filesystem.write', input: { path: 'b.txt', content: 'x' } }
            ]
        }), (e) => e.code === 'PERMISSION_REQUIRED');
    });
});

describe('P2-I E abort', () => {
    it('17 abort on step1', async () => {
        const c = new AbortController();
        c.abort();
        try {
            await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_a' }, { kind: 'tool', name: 'ms_b' }], signal: c.signal });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.code, 'ABORTED');
            assert.deepEqual(e.steps.map((s) => s.status), ['skipped', 'skipped']);
        }
        assert.equal(calls.ms_a || 0, 0);
    });
    it('18 abort during step1 execution skips the rest', async () => {
        const c = new AbortController();
        toolRegistry._clearForTests();
        toolRegistry.register({
            name: 'ms_first', description: 'f',
            execute: async () => { c.abort(); return 'first'; }
        });
        toolRegistry.register({ name: 'ms_a', description: 'a', execute: async () => 'A' });
        try {
            await core.run(task(), {
                steps: [{ kind: 'tool', name: 'ms_first' }, { kind: 'tool', name: 'ms_a' }],
                signal: c.signal
            });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.code, 'ABORTED');
            assert.deepEqual(e.steps.map((s) => s.status), ['aborted', 'skipped']);
        }
        assert.equal(calls.ms_a || 0, 0);
    });
    it('19 abort mid-plan skips the rest', async () => {
        toolRegistry.register({
            name: 'ms_abortme', description: 'x',
            execute: async () => { throw Object.assign(new Error('stop'), { code: 'ABORTED' }); }
        });
        try {
            await core.run(task(), {
                steps: [{ kind: 'tool', name: 'ms_a', input: '1' }, { kind: 'tool', name: 'ms_abortme' }, { kind: 'tool', name: 'ms_b' }]
            });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.code, 'ABORTED');
            assert.deepEqual(e.steps.map((s) => s.status), ['completed', 'aborted', 'skipped']);
        }
    });
});

describe('P2-I F timeout', () => {
    it('20 timeout on step', async () => {
        toolRegistry.register({ name: 'ms_hang', description: 'h', execute: async () => new Promise(() => {}) });
        try {
            await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_hang' }], timeoutMs: 30 });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.code, 'TIMEOUT');
            assert.equal(e.steps[0].status, 'timeout');
        }
    });
    it('21 later steps skipped after timeout', async () => {
        toolRegistry.register({ name: 'ms_hang', description: 'h', execute: async () => new Promise(() => {}) });
        try {
            await core.run(task(), {
                steps: [{ kind: 'tool', name: 'ms_hang' }, { kind: 'tool', name: 'ms_a' }],
                timeoutMs: 30
            });
            assert.fail('should throw');
        } catch (e) {
            assert.deepEqual(e.steps.map((s) => s.status), ['timeout', 'skipped']);
        }
        assert.equal(calls.ms_a || 0, 0);
    });
});

describe('P2-I G limits', () => {
    it('22 MAX_STEPS enforced', () => {
        assert.equal(core.MAX_STEPS, 8);
    });
    it('23 nine steps stop with MAX_STEPS_EXCEEDED', async () => {
        const steps = [];
        for (let i = 0; i < 9; i += 1) steps.push({ kind: 'tool', name: 'ms_a', input: String(i) });
        try {
            await core.run(task(), { steps });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.code, 'MAX_STEPS_EXCEEDED');
            assert.equal(e.steps.length, 9);
            assert.deepEqual(e.steps.slice(0, 8).map((s) => s.status), Array(8).fill('completed'));
            assert.equal(e.steps[8].status, 'skipped');
        }
        assert.equal(calls.ms_a, 8);
    });
    it('23b exactly eight steps all execute', async () => {
        const steps = [];
        for (let i = 0; i < 8; i += 1) steps.push({ kind: 'tool', name: 'ms_a', input: String(i) });
        const out = await core.run(task(), { steps });
        assert.equal(out.status, 'completed');
        assert.equal(calls.ms_a, 8);
    });
});

describe('P2-I H compatibility', () => {
    it('24 existing single-step planner works', () => {
        const planner = require('../src/agent/planner');
        const steps = planner.plan({ prompt: 'hi', tools: ['ms_a'] });
        assert.equal(steps.length, 1);
        assert.equal(steps[0].name, 'ms_a');
    });
    it('25 calculator still works', async () => {
        registerNativeTools(toolRegistry);
        const out = await core.run({ id: 'c1', prompt: '2 + 3', sessionId: 's', tools: ['calculator'] }, {});
        assert.equal(out.result, '5');
    });
    it('26 filesystem.read still works', async () => {
        registerNativeTools(toolRegistry);
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2i-'));
        const saved = process.env.WORKSPACE_ROOT;
        process.env.WORKSPACE_ROOT = root;
        try {
            fs.writeFileSync(path.join(root, 'r.txt'), 'read-me');
            const out = await core.run({ id: 'r1', prompt: 'r.txt', sessionId: 's', tools: ['filesystem.read'] }, {});
            assert.equal(out.result.content, 'read-me');
        } finally {
            if (saved === undefined) delete process.env.WORKSPACE_ROOT;
            else process.env.WORKSPACE_ROOT = saved;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('27 filesystem.write still goes through Permission', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => core.run({ id: 'w1', prompt: 'x', sessionId: 's', tools: ['filesystem.write'] }, {}), (e) => e.code === 'PERMISSION_REQUIRED');
    });
    it('28 OpenCode runtime still works', async () => {
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'rt-ok', mcpTools: [] });
        try {
            const out = await core.run({ id: 'rt1', prompt: 'hi', sessionId: 's', tools: [] }, {});
            assert.equal(out.result, 'rt-ok');
            assert.equal(out.status, 'completed');
        } finally {
            rt.execute = orig;
        }
    });
});

describe('P2-I I state', () => {
    it('29 currentStep tracks the running step', async () => {
        const { AgentState } = require('../src/agent/state');
        const st = new AgentState('s1');
        st.setStep({ id: 'step-2' });
        assert.equal(st.currentStep.id, 'step-2');
        assert.ok(st.history.length >= 1);
    });
    it('30 completed steps preserved', async () => {
        const out = await core.run(task(), {
            steps: [{ kind: 'tool', name: 'ms_a', input: '1' }, { kind: 'tool', name: 'ms_b', input: '2' }]
        });
        assert.equal(out.steps.filter((s) => s.status === 'completed').length, 2);
    });
    it('31 failed step preserved', async () => {
        toolRegistry.register({
            name: 'ms_fail', description: 'f',
            execute: async () => { const e = new Error('bad'); e.status = 400; throw e; }
        });
        try {
            await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_fail' }] });
            assert.fail('should throw');
        } catch (e) {
            assert.equal(e.steps[0].status, 'failed');
            assert.ok(e.steps[0].error.includes('bad'));
        }
    });
    it('32 skipped steps preserved', async () => {
        toolRegistry.register({
            name: 'ms_fail', description: 'f',
            execute: async () => { const e = new Error('bad'); e.status = 400; throw e; }
        });
        try {
            await core.run(task(), {
                steps: [{ kind: 'tool', name: 'ms_fail' }, { kind: 'tool', name: 'ms_a' }, { kind: 'tool', name: 'ms_b' }]
            });
            assert.fail('should throw');
        } catch (e) {
            assert.deepEqual(e.steps.map((s) => s.id), ['step-1', 'step-2', 'step-3']);
            assert.equal(e.steps[2].result, null);
        }
    });
});

describe('P2-I J determinism', () => {
    it('33 same plan produces same step ordering', async () => {
        const mk = () => [{ kind: 'tool', name: 'ms_a', input: '1' }, { kind: 'tool', name: 'ms_b', input: '2' }];
        const o1 = await core.run(task('d1'), { steps: mk() });
        const o2 = await core.run(task('d2'), { steps: mk() });
        assert.deepEqual(o1.steps.map((s) => s.name), o2.steps.map((s) => s.name));
        assert.equal(o1.result, o2.result);
    });
    it('34 no hidden retry loop (WORKER_ERROR retries once per step)', async () => {
        let n = 0;
        toolRegistry.register({
            name: 'ms_retry', description: 'r',
            execute: async () => { n += 1; throw Object.assign(new Error('t'), { code: 'WORKER_ERROR' }); }
        });
        await assert.rejects(() => core.run(task(), {
            steps: [{ kind: 'tool', name: 'ms_retry' }, { kind: 'tool', name: 'ms_a' }]
        }), (e) => e.code === 'TOOL_EXECUTION_ERROR');
        assert.equal(n, 2);
        assert.equal(calls.ms_a || 0, 0);
    });
    it('35 no recursive infinite execution', async () => {
        const out = await core.run(task(), { steps: [{ kind: 'tool', name: 'ms_a', input: '1' }] });
        assert.equal(calls.ms_a, 1);
        assert.equal(out.steps.length, 1);
    });
    it('36 planner validates injected steps', () => {
        const planner = require('../src/agent/planner');
        assert.throws(() => planner.plan({ prompt: 'x' }, { steps: [{ kind: 'nope', name: 'a' }] }), (e) => e.code === 'PLANNING_ERROR');
        assert.throws(() => planner.plan({ prompt: 'x' }, { steps: [{ kind: 'tool' }] }), (e) => e.code === 'PLANNING_ERROR');
        const steps = planner.plan({ prompt: 'x' }, { steps: [{ kind: 'tool', name: 'ms_a' }] });
        assert.equal(steps[0].id, 'step-1');
        assert.equal(steps[0].input, '');
    });
});
