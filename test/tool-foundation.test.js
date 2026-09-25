// P2-A Native Tool Foundation tests.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { defineTool, createExecutionContext, validateToolInput } = require('../src/services/tools/tool');
const toolRegistry = require('../src/services/tools/toolRegistry');
const core = require('../src/agent/core');

beforeEach(() => {
    toolRegistry._clearForTests();
});

describe('P2-A tool contract', () => {
    it('1 valid tool registration', () => {
        const t = toolRegistry.register({ name: 'ok_tool', description: 'ok', execute: async () => 'ok' });
        assert.equal(t.name, 'ok_tool');
        assert.equal(t.readOnly, false);
        assert.equal(t.needsApproval, false);
        assert.ok(Object.isFrozen(t));
    });
    it('2 invalid tool definitions fail at creation/registration', () => {
        assert.throws(() => defineTool(null), /object/);
        assert.throws(() => defineTool({ name: 'Bad!', description: 'x', execute: async () => 1 }), /name/);
        assert.throws(() => defineTool({ name: 'ok', description: '', execute: async () => 1 }), /description/);
        assert.throws(() => defineTool({ name: 'ok', description: 'x' }), /execute/);
        assert.throws(() => defineTool({ name: 'ok', description: 'x', execute: async () => 1, inputSchema: [] }), /inputSchema/);
        assert.throws(() => defineTool({ name: 'ok', description: 'x', execute: async () => 1, readOnly: 'yes' }), /readOnly/);
        assert.throws(() => toolRegistry.register({ name: 'bad name', description: 'x', execute: async () => 1 }), /name/);
    });
    it('3 duplicate registration is explicit, never silent overwrite', () => {
        toolRegistry.register({ name: 'dup', description: 'a', execute: async () => 'a' });
        assert.throws(() => toolRegistry.register({ name: 'dup', description: 'b', execute: async () => 'b' }), /already registered/);
        assert.equal(toolRegistry.get('dup').description, 'a');
    });
    it('4/5 get() and has()', () => {
        assert.equal(toolRegistry.get('missing'), null);
        assert.equal(toolRegistry.has('missing'), false);
        toolRegistry.register({ name: 'g', description: 'G', execute: async () => 1 });
        assert.equal(toolRegistry.get('g').description, 'G');
        assert.equal(toolRegistry.has('g'), true);
    });
    it('6 list() returns stable metadata copies', () => {
        toolRegistry.register({ name: 'm', description: 'M', inputSchema: { type: 'string' }, readOnly: true, execute: async () => 1 });
        const l = toolRegistry.list();
        assert.equal(l.length, 1);
        assert.deepEqual(l[0], { name: 'm', description: 'M', inputSchema: { type: 'string' }, readOnly: true, needsApproval: false, capabilities: [] });
        assert.equal(typeof l[0].execute, 'undefined');
    });
    it('13 list() cannot mutate registry internal state', () => {
        toolRegistry.register({ name: 'imm', description: 'I', execute: async () => 1 });
        const l = toolRegistry.list();
        l.push({ name: 'fake' });
        l[0].name = 'hacked';
        l[0].inputSchema = { hacked: true };
        assert.equal(toolRegistry.has('fake'), false);
        assert.equal(toolRegistry.get('imm').name, 'imm');
        assert.deepEqual(toolRegistry.list(), [{ name: 'imm', description: 'I', inputSchema: null, readOnly: false, needsApproval: false, capabilities: [] }]);
    });
});

describe('P2-A execution boundary', () => {
    it('7 unknown tool -> TOOL_NOT_FOUND', async () => {
        await assert.rejects(() => toolRegistry.execute('nope', 'x'), (e) => e.code === 'TOOL_NOT_FOUND');
    });
    it('8 tool execute success', async () => {
        toolRegistry.register({ name: 'echo', description: 'e', execute: async (input) => `hi:${input}` });
        assert.equal(await toolRegistry.execute('echo', 'a'), 'hi:a');
    });
    it('9 tool execution error -> TOOL_EXECUTION_ERROR', async () => {
        toolRegistry.register({ name: 'boom', description: 'b', execute: async () => { throw new Error('kaput'); } });
        await assert.rejects(() => toolRegistry.execute('boom', 'x'), (e) => e.code === 'TOOL_EXECUTION_ERROR');
    });
    it('5b invalid input has consistent error form (status 400)', async () => {
        toolRegistry.register({ name: 'stronly', description: 's', inputSchema: { type: 'string' }, execute: async () => 'never' });
        await assert.rejects(() => toolRegistry.execute('stronly', 123), (e) => e.status === 400);
        // direct validator agrees
        assert.throws(() => validateToolInput(toolRegistry.get('stronly'), 123), (e) => e.status === 400);
    });
    it('10 ABORTED is never wrapped', async () => {
        const c = new AbortController();
        c.abort();
        toolRegistry.register({ name: 'slow', description: 's', execute: async () => 'never' });
        await assert.rejects(() => toolRegistry.execute('slow', 'x', { signal: c.signal }), (e) => e.code === 'ABORTED');
        // tool-thrown ABORTED also passes through
        toolRegistry.register({ name: 'aborter', description: 'a', execute: async () => { throw Object.assign(new Error('stop'), { code: 'ABORTED' }); } });
        await assert.rejects(() => toolRegistry.execute('aborter', 'x'), (e) => e.code === 'ABORTED' && !/TOOL_EXECUTION_ERROR/.test(e.code));
    });
    it('11 TIMEOUT is never wrapped', async () => {
        toolRegistry.register({ name: 'hang', description: 'h', execute: async () => new Promise(() => {}) });
        await assert.rejects(() => toolRegistry.execute('hang', 'x', { timeoutMs: 30 }), (e) => e.code === 'TIMEOUT');
    });
    it('12 execution context is per-run', () => {
        const a = createExecutionContext({ taskId: 't1', sessionId: 's1' });
        const b = createExecutionContext({ taskId: 't2', sessionId: 's2' });
        assert.notEqual(a, b);
        a.taskId = 'mutated';
        assert.equal(b.taskId, 't2');
        assert.deepEqual(a.approval, { status: 'not_required' });
    });
    it('12b ctx carries taskId/sessionId/signal/timeout', async () => {
        let seen = null;
        toolRegistry.register({ name: 'ctxspy', description: 'c', execute: async (input, ctx) => { seen = ctx; return 'ok'; } });
        const c = new AbortController();
        await toolRegistry.execute('ctxspy', 'x', { taskId: 'tt', sessionId: 'ss', signal: c.signal, timeoutMs: 1000 });
        assert.equal(seen.taskId, 'tt');
        assert.equal(seen.sessionId, 'ss');
        assert.equal(seen.signal, c.signal);
        assert.equal(seen.timeoutMs, 1000);
    });
});

describe('P2-A calculator + core regression', () => {
    it('14 calculator regression', async () => {
        const { calculator } = require('../src/services/tools/calculator');
        toolRegistry.register(calculator);
        assert.equal((await toolRegistry.execute('calculator', '2 + 3 * 4')).result, '14');
        await assert.rejects(() => toolRegistry.execute('calculator', 123), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('calculator', ''), /non-empty/);
    });
    it('15 Agent Core does not directly depend on calculator implementation', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'core.js'), 'utf8');
        assert.ok(!src.includes('calculator'), 'core must not reference calculator');
        assert.ok(src.includes('toolRegistry'), 'core must go through ToolRegistry');
    });
    it('15b core tool path still normalizes { result, mcpTools }', async () => {
        toolRegistry.register({ name: 'raw', description: 'r', execute: async () => 'plain' });
        const out = await core.run({ id: 'p2a1', prompt: 'x', sessionId: 's', tools: ['raw'] }, {});
        assert.equal(out.result, 'plain');
        assert.ok(out.mcpTools.includes('raw'));
    });
    it('16 tools:[] still goes OpenCode runtime direct path', async () => {
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'runtime-ok', mcpTools: [] });
        try {
            const out = await core.run({ id: 'p2a2', prompt: 'hello', sessionId: 's', tools: [] }, {});
            assert.equal(out.result, 'runtime-ok');
        } finally {
            rt.execute = orig;
        }
    });
});
