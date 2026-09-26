// Agent execution cancellation tests (Stop button backend contract).
// Covers: normal run, AbortController cancel, multi-step stop, lock/state
// cleanup, command abort, timeout-vs-cancel distinction, run-after-cancel.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/agent/core');
const toolRegistry = require('../src/services/tools/toolRegistry');
const orchestrator = require('../src/services/agentOrchestrator');

beforeEach(() => {
    toolRegistry._clearForTests();
    orchestrator._clearForTests();
});

function hangTool(name = 'cancel_hang') {
    toolRegistry.register({
        name, description: name,
        execute: async () => new Promise(() => {})
    });
}

describe('agent cancellation basics', () => {
    it('1 normal execution still passes', async () => {
        toolRegistry.register({ name: 'cancel_ok', description: 'ok', execute: async (i) => `ok:${i}` });
        const out = await core.run({ id: 'c1', prompt: 'hi', sessionId: 's', tools: ['cancel_ok'] }, {});
        assert.equal(out.result, 'ok:hi');
    });
    it('2 AbortController cancellation surfaces ABORTED', async () => {
        hangTool();
        const c = new AbortController();
        const p = core.run({ id: 'c2', prompt: 'x', sessionId: 's', tools: ['cancel_hang'] }, { signal: c.signal, timeoutMs: 60000 });
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
    });
    it('3 multi-step stops after cancellation, later steps skipped', async () => {
        const ran = [];
        toolRegistry.register({ name: 'cancel_s1', description: 's1', execute: async () => { ran.push('s1'); return 's1'; } });
        hangTool('cancel_s2');
        toolRegistry.register({ name: 'cancel_s3', description: 's3', execute: async () => { ran.push('s3'); return 's3'; } });
        const c = new AbortController();
        const p = core.run({ id: 'c3', prompt: 'x', sessionId: 's' }, {
            signal: c.signal,
            timeoutMs: 60000,
            steps: [
                { kind: 'tool', name: 'cancel_s1', input: 'x' },
                { kind: 'tool', name: 'cancel_s2', input: 'x' },
                { kind: 'tool', name: 'cancel_s3', input: 'x' }
            ]
        });
        setTimeout(() => c.abort(), 50);
        await assert.rejects(p, (e) => {
            assert.equal(e.code, 'ABORTED');
            const st = (e.steps || []).map((s) => s.status);
            assert.deepEqual(st, ['completed', 'aborted', 'skipped']);
            return true;
        });
        assert.deepEqual(ran, ['s1']);
    });
    it('5 approved hanging command-style tool aborts without spawning more work', async () => {
        let calls = 0;
        toolRegistry.register({
            name: 'cancel_cmd', description: 'cmd', needsApproval: true,
            execute: async () => { calls += 1; return new Promise(() => {}); }
        });
        const c = new AbortController();
        const p = core.run(
            { id: 'c5', prompt: 'x', sessionId: 's', tools: ['cancel_cmd'] },
            { signal: c.signal, timeoutMs: 60000, approval: { status: 'approved' } }
        );
        setTimeout(() => c.abort(), 50);
        await assert.rejects(p, (e) => e.code === 'ABORTED');
        assert.equal(calls, 1);
    });
    it('8 timeout and user cancellation stay distinct', async () => {
        hangTool('cancel_t1');
        hangTool('cancel_t2');
        const t1 = { id: 't1', prompt: 'x', sessionId: 's', tools: ['cancel_t1'] };
        await assert.rejects(() => core.run(t1, { timeoutMs: 30 }), (e) => e.code === 'TIMEOUT');
        const c = new AbortController();
        const p = core.run({ id: 't2', prompt: 'x', sessionId: 's', tools: ['cancel_t2'] }, { signal: c.signal, timeoutMs: 60000 });
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
    });
});

describe('orchestrator cancellation cleanup', () => {
    function hangRuntime(name) {
        orchestrator.registerRuntime(name, {
            execute: async () => new Promise(() => {}),
            executeStream: async ({ signal }) => {
                await new Promise((resolve, reject) => {
                    if (signal.aborted) return reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
                    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
                });
            },
            abort: () => ({ ok: true }),
            health: async () => ({ available: true })
        });
    }
    it('4/6 abort cleans controllers + status, lock released for next run', async () => {
        hangRuntime('cancel_hangrt');
        const t = orchestrator.createTask({ prompt: 'x', sessionId: 's-cancel-1', runtime: 'cancel_hangrt' });
        const c = new AbortController();
        const p = orchestrator.streamTask(t.id, { signal: c.signal });
        await new Promise((r) => setTimeout(r, 50));
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
        assert.equal(orchestrator.getTask(t.id).status, 'aborted');
        assert.deepEqual(orchestrator.abortTask(t.id), { ok: false, reason: 'no in-flight execution' });
        orchestrator.unregisterRuntime('cancel_hangrt');
    });
    it('7 new instruction runs immediately after cancellation', async () => {
        hangRuntime('cancel_hangrt2');
        const t1 = orchestrator.createTask({ prompt: 'x', sessionId: 's-cancel-2', runtime: 'cancel_hangrt2' });
        const c = new AbortController();
        const p = orchestrator.streamTask(t1.id, { signal: c.signal });
        await new Promise((r) => setTimeout(r, 50));
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
        orchestrator.unregisterRuntime('cancel_hangrt2');
        orchestrator.registerRuntime('cancel_quick', {
            execute: async () => 'quick-ok',
            executeStream: async () => ({ result: 'quick-ok', mcpTools: [] }),
            abort: () => ({ ok: true }),
            health: async () => ({ available: true })
        });
        try {
            const t2 = orchestrator.createTask({ prompt: 'hi again', sessionId: 's-cancel-2', runtime: 'cancel_quick' });
            const out = await orchestrator.streamTask(t2.id, {});
            assert.equal(out.result, 'quick-ok');
            assert.equal(orchestrator.getTask(t2.id).status, 'completed');
        } finally {
            orchestrator.unregisterRuntime('cancel_quick');
        }
    });
});
