// P2-F Permission / Approval boundary tests.
// Test-only approval-required tool; production native tools stay untouched.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { defineTool } = require('../src/services/tools/tool');
const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const core = require('../src/agent/core');

let executions;

function approvalTool() {
    executions = 0;
    return defineTool({
        name: 'test.approvalRequired',
        description: 'test-only approval gate',
        inputSchema: { type: 'object', properties: {} },
        readOnly: false,
        needsApproval: true,
        execute: async () => {
            executions += 1;
            return { result: 'ok', mcpTools: ['test.approvalRequired'] };
        }
    });
}

beforeEach(() => {
    toolRegistry._clearForTests();
    toolRegistry.register(approvalTool());
});

const APPROVED = { approval: { status: 'approved' } };

describe('P2-F permission boundary', () => {
    it('1 needsApproval=false executes without approval', async () => {
        toolRegistry.register({ name: 'open', description: 'o', execute: async () => 'open-ok' });
        assert.equal(await toolRegistry.execute('open', null), 'open-ok');
    });
    it('2 needsApproval=true + no approval -> PERMISSION_REQUIRED', async () => {
        await assert.rejects(() => toolRegistry.execute('test.approvalRequired', {}), (e) => e.code === 'PERMISSION_REQUIRED' && e.status === 400);
    });
    it('3 pending -> PERMISSION_REQUIRED', async () => {
        await assert.rejects(
            () => toolRegistry.execute('test.approvalRequired', {}, { approval: { status: 'pending' } }),
            (e) => e.code === 'PERMISSION_REQUIRED'
        );
    });
    it('4 rejected -> PERMISSION_DENIED', async () => {
        await assert.rejects(
            () => toolRegistry.execute('test.approvalRequired', {}, { approval: { status: 'rejected' } }),
            (e) => e.code === 'PERMISSION_DENIED' && e.status === 400
        );
    });
    it('5 approved -> execute', async () => {
        const out = await toolRegistry.execute('test.approvalRequired', {}, APPROVED);
        assert.equal(out.result, 'ok');
    });
    it('6 rejected executes tool zero times', async () => {
        await assert.rejects(() => toolRegistry.execute('test.approvalRequired', {}, { approval: { status: 'rejected' } }));
        assert.equal(executions, 0);
    });
    it('7 pending executes tool zero times', async () => {
        await assert.rejects(() => toolRegistry.execute('test.approvalRequired', {}));
        assert.equal(executions, 0);
    });
    it('8 approved executes tool once', async () => {
        await toolRegistry.execute('test.approvalRequired', {}, APPROVED);
        assert.equal(executions, 1);
    });
    it('9 permission errors never retry via core', async () => {
        const task = { id: 'p1', prompt: 'x', sessionId: 's', tools: ['test.approvalRequired'] };
        await assert.rejects(() => core.run(task, {}), (e) => e.code === 'PERMISSION_REQUIRED');
        assert.equal(executions, 0);
        assert.equal(core.isRetryable(Object.assign(new Error('x'), { code: 'PERMISSION_REQUIRED', status: 400 })), false);
        assert.equal(core.isRetryable(Object.assign(new Error('x'), { code: 'PERMISSION_DENIED', status: 400 })), false);
    });
    it('9b approved flows through core', async () => {
        const task = { id: 'p2', prompt: 'x', sessionId: 's', tools: ['test.approvalRequired'] };
        const out = await core.run(task, { approval: { status: 'approved' } });
        assert.equal(out.result, 'ok');
        assert.equal(executions, 1);
    });
    it('10 approval context never leaks across executions', async () => {
        await toolRegistry.execute('test.approvalRequired', {}, APPROVED);
        assert.equal(executions, 1);
        await assert.rejects(() => toolRegistry.execute('test.approvalRequired', {}), (e) => e.code === 'PERMISSION_REQUIRED');
        assert.equal(executions, 1);
    });
    it('11 taskId/sessionId reach the tool with approval', async () => {
        toolRegistry.register(defineTool({
            name: 'test.ctxspy', description: 's', inputSchema: null, needsApproval: true,
            execute: async (input, ctx) => ({ taskId: ctx.taskId, sessionId: ctx.sessionId })
        }));
        const out = await toolRegistry.execute('test.ctxspy', null, { taskId: 't9', sessionId: 's9', approval: { status: 'approved' } });
        assert.equal(out.taskId, 't9');
        assert.equal(out.sessionId, 's9');
    });
    it('12 abort still wins (already-aborted, approved tool)', async () => {
        const c = new AbortController();
        c.abort();
        await assert.rejects(
            () => toolRegistry.execute('test.approvalRequired', {}, { signal: c.signal, approval: { status: 'approved' } }),
            (e) => e.code === 'ABORTED'
        );
        assert.equal(executions, 0);
    });
    it('13 timeout still applies (approved hanging tool)', async () => {
        toolRegistry.register(defineTool({
            name: 'test.hang', description: 'h', needsApproval: true,
            execute: async () => new Promise(() => {})
        }));
        await assert.rejects(
            () => toolRegistry.execute('test.hang', null, { timeoutMs: 30, approval: { status: 'approved' } }),
            (e) => e.code === 'TIMEOUT'
        );
    });
    it('14 malformed approval status -> APPROVAL_INVALID or REQUIRED, never execute', async () => {
        await assert.rejects(
            () => toolRegistry.execute('test.approvalRequired', {}, { approval: { status: 'maybe' } }),
            (e) => e.code === 'APPROVAL_INVALID'
        );
        await assert.rejects(
            () => toolRegistry.execute('test.approvalRequired', {}, { approval: 'yes' }),
            (e) => e.code === 'PERMISSION_REQUIRED'
        );
        assert.equal(executions, 0);
    });
    it('15 unknown tool still TOOL_NOT_FOUND (before permission)', async () => {
        await assert.rejects(() => toolRegistry.execute('nope.missing', null, APPROVED), (e) => e.code === 'TOOL_NOT_FOUND');
    });
    it('16 production 15 tools keep needsApproval=false except write tools', () => {
        toolRegistry._clearForTests();
        const r = registerNativeTools(toolRegistry);
        assert.equal(r.registered.length, 15);
        for (const t of toolRegistry.list()) {
            if (t.name === 'filesystem.write' || t.name === 'filesystem.createDirectory') {
                assert.equal(t.needsApproval, true, t.name);
            } else {
                assert.equal(t.needsApproval, false, t.name);
            }
        }
    });
    it('permission errors carry no input or paths', async () => {
        await assert.rejects(
            () => toolRegistry.execute('test.approvalRequired', { secret: 's3cr3t', path: '/abs/root/x' }),
            (e) => !String(e.message).includes('s3cr3t') && !String(e.message).includes('/abs/root')
        );
    });
});
