// Vercel-first platform tests: tools, registry, orchestrator, runtime.
// No OpenCode specifics leak past the runtime adapter; routes stay thin.
// Real spawn never happens here (mock runtime only).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { defineTool } = require('../src/services/tools/tool');
const registry = require('../src/services/tools/toolRegistry');
const orchestrator = require('../src/services/agentOrchestrator');
const opencodeRuntime = require('../src/services/opencodeRuntime');

const savedEnv = {};
function setEnv(patch) {
    for (const k of Object.keys(patch)) {
        if (!(k in savedEnv)) savedEnv[k] = process.env[k];
        if (patch[k] === undefined) delete process.env[k];
        else process.env[k] = patch[k];
    }
}
function restoreEnv() {
    for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
        delete savedEnv[k];
    }
}

beforeEach(() => {
    setEnv({ MOCK_OPENCODE: 'true', NODE_ENV: undefined, WORKER_URL: undefined, WORKER_SHARED_SECRET: undefined, OPENCODE_SERVER_URL: undefined });
});
afterEach(() => {
    registry._clearForTests();
    orchestrator._clearForTests();
    restoreEnv();
});

describe('Tool interface + registry', () => {
    it('defineTool validates name/description/execute', () => {
        assert.throws(() => defineTool(null), /object/);
        assert.throws(() => defineTool({ name: 'Bad Name!', description: 'x', execute: async () => 1 }), /name/);
        assert.throws(() => defineTool({ name: 'ok', description: '', execute: async () => 1 }), /description/);
        assert.throws(() => defineTool({ name: 'ok', description: 'x' }), /execute/);
        const t = defineTool({ name: 'gmail', description: 'Read mail', execute: async () => 'mail' });
        assert.ok(Object.isFrozen(t));
        assert.equal(t.name, 'gmail');
    });

    it('registry registers once, gets, lists, validates', () => {
        assert.deepEqual(registry.list(), []);
        registry.register({ name: 'github', description: 'Repos', execute: async () => 'repos' });
        assert.ok(registry.has('github'));
        assert.equal(registry.get('github').description, 'Repos');
        assert.deepEqual(registry.list(), [{ name: 'github', description: 'Repos', inputSchema: null, readOnly: false, needsApproval: false, capabilities: [] }]);
        assert.throws(() => registry.register({ name: 'github', description: 'dup', execute: async () => 1 }), /already registered/);
        assert.deepEqual(registry.validateAll(['github']), ['github']);
        assert.deepEqual(registry.validateAll(), []);
        assert.throws(() => registry.validateAll(['nope']), /unknown tools: nope/);
        assert.throws(() => registry.validateAll('github'), /array/);
        assert.equal(registry.get('missing'), null);
    });

    it('registry dispatches execute without OpenCode involvement', async () => {
        registry.register({ name: 'calendar', description: 'Events', execute: async (input) => `events:${input.q}` });
        assert.equal(await registry.get('calendar').execute({ q: 'today' }), 'events:today');
    });
});

describe('Agent orchestrator task lifecycle', () => {
    it('createTask validates runtime + tools, starts queued', () => {
        assert.throws(() => orchestrator.createTask({ sessionId: '' }), /sessionId/);
        assert.throws(() => orchestrator.createTask({ sessionId: 's', runtime: 'nope' }), /unknown runtime/);
        assert.throws(() => orchestrator.createTask({ sessionId: 's', tools: ['gmail'] }), /unknown tools/);
        registry.register({ name: 'gmail', description: 'Mail', execute: async () => 1 });
        const t = orchestrator.createTask({ prompt: 'hi', sessionId: 's-1', owner: 'u', tools: ['gmail'] });
        assert.equal(t.status, 'queued');
        assert.equal(t.runtime, 'opencode');
        assert.deepEqual(t.tools, ['gmail']);
        assert.ok(t.id && t.createdAt);
        assert.equal(orchestrator.getTask(t.id).id, t.id);
        assert.equal(orchestrator.getTask('missing'), null);
    });

    it('runTask completes via mock runtime and records result', async () => {
        const t = orchestrator.createTask({ prompt: 'hello platform', sessionId: 's-2', owner: 'u' });
        const out = await orchestrator.runTask(t.id);
        assert.ok(out.result.includes('mock for: hello platform'));
        const done = orchestrator.getTask(t.id);
        assert.equal(done.status, 'completed');
        assert.ok(done.finishedAt >= done.startedAt);
        assert.deepEqual(done.result, out);
    });

    it('runTask rejects rerun with 409 and maps failures', async () => {
        const t = orchestrator.createTask({ prompt: 'x', sessionId: 's-3' });
        await orchestrator.runTask(t.id);
        await assert.rejects(orchestrator.runTask(t.id), /already completed/);
        await assert.rejects(orchestrator.runTask('nope'), /unknown task/);
        const t2 = orchestrator.createTask({ sessionId: 's-3b' });
        await assert.rejects(orchestrator.runTask(t2.id), /no prompt/);
        assert.equal(orchestrator.getTask(t2.id).status, 'failed');
    });

    it('pre-aborted signal yields aborted status without running', async () => {
        const t = orchestrator.createTask({ prompt: 'x', sessionId: 's-4' });
        const c = new AbortController();
        c.abort();
        await assert.rejects(orchestrator.streamTask(t.id, { signal: c.signal }), /aborted/);
        assert.equal(orchestrator.getTask(t.id).status, 'aborted');
    });

    it('abortTask aborts in-flight stub runtime, unknown is harmless', async () => {
        orchestrator.registerRuntime('stubslow', {
            execute: async () => 'x',
            executeStream: async ({ signal }) => {
                await new Promise((resolve, reject) => {
                    if (signal.aborted) return reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
                    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
                });
            },
            abort: () => ({ ok: true }),
            health: async () => ({ available: true })
        });
        try {
            const t = orchestrator.createTask({ prompt: 'x', sessionId: 's-5', runtime: 'stubslow' });
            const p = orchestrator.streamTask(t.id, { onEvent: () => {} });
            await new Promise((r) => setTimeout(r, 50));
            assert.deepEqual(orchestrator.abortTask(t.id), { ok: true });
            await assert.rejects(p, /aborted/);
            assert.equal(orchestrator.getTask(t.id).status, 'aborted');
            assert.equal(orchestrator.abortTask(t.id).ok, false);
            assert.equal(orchestrator.abortTask('missing').ok, false);
        } finally {
            orchestrator.unregisterRuntime('stubslow');
        }
    });

    it('registerRuntime validates shape + duplicates', () => {
        assert.throws(() => orchestrator.registerRuntime('Bad!', {}), /name/);
        assert.throws(() => orchestrator.registerRuntime('half', { execute: async () => 1 }), /executeStream/);
        assert.throws(() => orchestrator.registerRuntime('opencode', opencodeRuntime), /already registered/);
        assert.equal(orchestrator.unregisterRuntime('nope'), false);
    });

    it('selectRuntime resolves default + registered, rejects unknown', () => {
        assert.equal(orchestrator.selectRuntime({ runtime: 'opencode' }), opencodeRuntime);
        assert.equal(orchestrator.selectRuntime({}), opencodeRuntime);
        assert.throws(() => orchestrator.selectRuntime({ runtime: 'nope' }), /unknown runtime/);
    });
});

describe('opencodeRuntime adapter surface', () => {
    it('exposes execute/executeStream/abort/health without leaking internals', async () => {
        assert.equal(opencodeRuntime.name, 'opencode');
        for (const fn of ['execute', 'executeStream', 'abort', 'health']) {
            assert.equal(typeof opencodeRuntime[fn], 'function');
        }
        await assert.rejects(opencodeRuntime.execute({}), /prompt is required/);
        await assert.rejects(opencodeRuntime.executeStream({}), /prompt is required/);
        assert.equal(opencodeRuntime.abort(null).ok, false);
        const c = new AbortController();
        assert.deepEqual(opencodeRuntime.abort(c), { ok: true });
        assert.ok(c.signal.aborted);
    });

    it('mock execute returns result; health reports mock mode', async () => {
        const out = await opencodeRuntime.execute({ prompt: 'adapter check', workspaceId: 'ws-1' });
        assert.ok(out.result.includes('mock for: adapter check'));
        assert.ok(Array.isArray(out.mcpTools));
        const h = await opencodeRuntime.health();
        assert.equal(h.available, true);
        assert.equal(h.runtime, 'opencode');
    });

    it('mock executeStream emits normalized platform events only', async () => {
        const seen = [];
        const out = await opencodeRuntime.executeStream({
            prompt: 'adapter stream check',
            workspaceId: 'ws-2',
            onEvent: (e) => seen.push(e)
        });
        assert.ok(out.result.includes('mock for: adapter stream check'));
        const types = seen.map((e) => e.type);
        assert.ok(types.includes('message.started'), `got ${types}`);
        assert.ok(types.includes('text.delta'), `got ${types}`);
        assert.ok(types.includes('message.completed'), `got ${types}`);
        for (const e of seen) {
            assert.ok(!('cookie' in e) && !('password' in e) && !('token' in e), 'no secrets in events');
        }
    });

    it('pre-aborted signal fails fast without spawning', async () => {
        const c = new AbortController();
        c.abort();
        await assert.rejects(opencodeRuntime.execute({ prompt: 'x', signal: c.signal }), /aborted/);
        await assert.rejects(opencodeRuntime.executeStream({ prompt: 'x', signal: c.signal }), /aborted/);
    });
});
