// code_context Native Tool (read-only): build a bounded project context
// for the caller's workspace.
//
// Built with defineTool() per the P2-A contract. Owner/session come ONLY
// from the server-supplied execution context (ctx.owner, ctx.sessionId) —
// never from tool input. Resolution goes through WorkspaceService (owner +
// session scoped, derived rootPath), scanning through codeContextService
// (containment-checked, capped, secret-free). No shell, no writes.
const { defineTool } = require('./tool');
const { WorkspaceService } = require('../workspaceService');
const { buildContext, LIMITS } = require('../codeContextService');

function inputError(message) {
    return Object.assign(new Error(`code_context: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function checkCount(name, value, def, min, max) {
    if (value === undefined || value === null) return def;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw inputError(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

const codeContext = defineTool({
    name: 'code_context',
    capabilities: ['workspace.read', 'code.read'],
    description: 'Build a bounded read-only project context for the current workspace',
    inputSchema: {
        type: 'object',
        properties: {
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            paths: { type: 'array', description: 'prioritized workspace-relative paths' },
            maxFiles: { type: 'number', description: 'max files to include (default 20, max 100)' },
            maxBytesPerFile: { type: 'number', description: 'max bytes per file (default 20000, max 100000)' },
            maxTotalBytes: { type: 'number', description: 'max total content bytes (default 200000, max 1000000)' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = input === undefined || input === null ? {} : input;
        if (typeof obj !== 'object' || Array.isArray(obj)) {
            throw inputError('input must be an object');
        }
        const owner = ctx && typeof ctx.owner === 'string' && ctx.owner ? ctx.owner : null;
        if (!owner) {
            throw inputError('authenticated owner is required in the execution context');
        }
        const sessionId = obj.sessionId !== undefined && obj.sessionId !== null ? obj.sessionId : (ctx && ctx.sessionId) || null;
        if (typeof sessionId !== 'string' || !sessionId) {
            throw inputError('sessionId is required (input or execution context)');
        }
        if (obj.paths !== undefined && obj.paths !== null && !Array.isArray(obj.paths)) {
            throw inputError('paths must be an array of strings');
        }
        const maxFiles = checkCount('maxFiles', obj.maxFiles, LIMITS.maxFiles, 1, 100);
        const maxBytesPerFile = checkCount('maxBytesPerFile', obj.maxBytesPerFile, LIMITS.maxBytesPerFile, 1, 100000);
        const maxTotalBytes = checkCount('maxTotalBytes', obj.maxTotalBytes, LIMITS.maxTotalBytes, 1, 1000000);

        const svc = WorkspaceService.default();
        let ws;
        if (obj.workspaceId !== undefined && obj.workspaceId !== null) {
            if (typeof obj.workspaceId !== 'string' || !obj.workspaceId) {
                throw inputError('workspaceId must be a non-empty string');
            }
            ws = await svc.getById(obj.workspaceId, owner);
        } else {
            ws = await svc.getCurrent(sessionId, owner);
        }
        checkAborted(ctx);
        const built = await buildContext(ws.rootPath, {
            paths: obj.paths === undefined ? null : obj.paths,
            maxFiles, maxBytesPerFile, maxTotalBytes,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return {
            result: {
                workspace: {
                    workspaceId: ws.workspaceId,
                    sessionId: ws.sessionId,
                    status: ws.status
                },
                repository: ws.repository === undefined ? null : ws.repository,
                ...built
            },
            mcpTools: ['code_context']
        };
    }
});

module.exports = { codeContext };
