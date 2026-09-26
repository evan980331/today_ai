// test_runner Native Tool (P3-4): run the workspace's predefined tests.
//
// Built with defineTool() per the P2-A contract. The model supplies NO
// command: input is limited to { workspaceId?, sessionId?, timeoutMs? }.
// Owner/session come ONLY from the server-supplied execution context.
// Execution: testRunnerService.run() -> WorkspaceService ->
// commandService -> commandPolicy -> process. needsApproval:true so the
// existing ToolRegistry permission gate approves before anything runs.
const { defineTool } = require('./tool');
const testRunnerService = require('../testRunnerService');

function inputError(message) {
    return Object.assign(new Error(`test_runner: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

const testRunner = defineTool({
    name: 'test_runner',
    capabilities: ['test.run'],
    description: 'Run the current workspace predefined tests (npm test / pytest / unittest). Does not accept any custom command.',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 120000)' }
        }
    },
    readOnly: false,
    needsApproval: true,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = input === undefined || input === null ? {} : input;
        if (typeof obj !== 'object' || Array.isArray(obj)) {
            throw inputError('input must be an object');
        }
        // Reject every non-contract field: no command/env/cwd/rootPath/argv.
        const allowed = new Set(['workspaceId', 'sessionId', 'timeoutMs']);
        for (const k of Object.keys(obj)) {
            if (!allowed.has(k)) {
                throw inputError(`field "${k}" is not allowed (no custom command)`);
            }
        }
        const owner = ctx && typeof ctx.owner === 'string' && ctx.owner ? ctx.owner : null;
        if (!owner) {
            throw inputError('authenticated owner is required in the execution context');
        }
        const sessionId = obj.sessionId !== undefined && obj.sessionId !== null
            ? obj.sessionId
            : (ctx && ctx.sessionId) || null;
        const data = await testRunnerService.run({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId,
            owner,
            timeoutMs: obj.timeoutMs === undefined ? null : obj.timeoutMs,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['test_runner'] };
    }
});

module.exports = { testRunner };
