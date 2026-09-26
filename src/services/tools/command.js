// command_execute Native Tool: run allowlisted executables inside the
// caller's workspace directory.
//
// Built with defineTool() per the P2-A contract. Structured input only:
// { executable, args?, cwd?, timeoutMs?, sessionId?, workspaceId? }.
// There is intentionally NO free-text `command` field — that would require
// a shell parser. Owner/session come ONLY from the server-supplied
// execution context, never from input. needsApproval:true so the
// ToolRegistry permission gate must approve before anything spawns.
//
// The Agent Core never imports this file — tools reach execution only via
// Planner -> ToolRegistry.
const { defineTool } = require('./tool');
const commandService = require('../commandService');

function inputError(message) {
    return Object.assign(new Error(`command_execute: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

const commandExecute = defineTool({
    name: 'command_execute',
    capabilities: ['command.execute'],
    description: 'Run an allowlisted executable inside the workspace (needs approval)',
    inputSchema: {
        type: 'object',
        properties: {
            executable: { type: 'string', description: 'allowlisted command: npm, npx, node, git, python, pytest' },
            args: { type: 'array', description: 'argv tokens (no shell syntax, paths stay in workspace)' },
            cwd: { type: 'string', description: 'workspace-relative working directory (default root)' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' }
        },
        required: ['executable']
    },
    readOnly: false,
    needsApproval: true,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw inputError('input must be an object with executable');
        }
        const owner = ctx && typeof ctx.owner === 'string' && ctx.owner ? ctx.owner : null;
        if (!owner) {
            throw inputError('authenticated owner is required in the execution context');
        }
        const sessionId = input.sessionId !== undefined && input.sessionId !== null
            ? input.sessionId
            : (ctx && ctx.sessionId) || null;
        const data = await commandService.execute({
            workspaceId: input.workspaceId === undefined ? null : input.workspaceId,
            sessionId,
            owner,
            executable: input.executable,
            args: input.args,
            cwd: input.cwd === undefined ? null : input.cwd,
            timeoutMs: input.timeoutMs === undefined ? null : input.timeoutMs,
            env: input.env,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['command_execute'] };
    }
});

module.exports = { commandExecute };
