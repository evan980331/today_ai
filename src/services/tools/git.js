// P3-5 Git native tools: fixed-shape git operations inside the caller's
// workspace. No free-form command: inputs are strict allowlists
// ({ workspaceId?, sessionId?, timeoutMs? } plus op-specific fields).
// Owner/session come ONLY from the server-supplied execution context.
// Read-only tools (status/diff/log/branch) need no approval; add/commit
// require approval via the existing ToolRegistry permission gate.
const { defineTool } = require('./tool');
const gitService = require('../gitService');

function inputError(tool, message) {
    return Object.assign(new Error(`${tool}: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function ownerOf(tool, ctx) {
    const owner = ctx && typeof ctx.owner === 'string' && ctx.owner ? ctx.owner : null;
    if (!owner) throw inputError(tool, 'authenticated owner is required in the execution context');
    return owner;
}

function sessionOf(obj, ctx) {
    if (obj.sessionId !== undefined && obj.sessionId !== null) return obj.sessionId;
    return (ctx && ctx.sessionId) || null;
}

function timeoutOf(tool, obj) {
    if (obj.timeoutMs === undefined || obj.timeoutMs === null) return null;
    if (typeof obj.timeoutMs !== 'number') throw inputError(tool, 'timeoutMs must be a number');
    return obj.timeoutMs;
}

// Reject every field outside the op's allowlist: no command / args /
// cwd / rootPath / env / executable, ever.
function checkFields(tool, obj, allowed) {
    const set = new Set(allowed);
    for (const k of Object.keys(obj)) {
        if (!set.has(k)) throw inputError(tool, `field "${k}" is not allowed`);
    }
}

function checkObject(tool, input) {
    const obj = input === undefined || input === null ? {} : input;
    if (typeof obj !== 'object' || Array.isArray(obj)) throw inputError(tool, 'input must be an object');
    return obj;
}

const BASE_FIELDS = ['workspaceId', 'sessionId', 'timeoutMs'];

const gitStatus = defineTool({
    name: 'git_status',
    capabilities: ['git.status'],
    description: 'Show working tree status for the current workspace (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('git_status', input);
        checkFields('git_status', obj, BASE_FIELDS);
        const data = await gitService.status({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId: sessionOf(obj, ctx),
            owner: ownerOf('git_status', ctx),
            timeoutMs: timeoutOf('git_status', obj),
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['git_status'] };
    }
});

const gitDiff = defineTool({
    name: 'git_diff',
    capabilities: ['git.diff'],
    description: 'Show working tree diff for the current workspace (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            paths: { type: 'array', description: 'optional workspace-relative paths to limit the diff' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('git_diff', input);
        checkFields('git_diff', obj, [...BASE_FIELDS, 'paths']);
        const data = await gitService.diff({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId: sessionOf(obj, ctx),
            owner: ownerOf('git_diff', ctx),
            paths: obj.paths === undefined ? null : obj.paths,
            timeoutMs: timeoutOf('git_diff', obj),
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['git_diff'] };
    }
});

const gitLog = defineTool({
    name: 'git_log',
    capabilities: ['git.log'],
    description: 'Show recent commit history for the current workspace (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            limit: { type: 'number', description: 'max commits to show, 1-50 (default 10)' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('git_log', input);
        checkFields('git_log', obj, [...BASE_FIELDS, 'limit']);
        const data = await gitService.log({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId: sessionOf(obj, ctx),
            owner: ownerOf('git_log', ctx),
            limit: obj.limit === undefined ? null : obj.limit,
            timeoutMs: timeoutOf('git_log', obj),
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['git_log'] };
    }
});

const gitBranch = defineTool({
    name: 'git_branch',
    capabilities: ['git.branch'],
    description: 'Show the current branch of the workspace repository (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('git_branch', input);
        checkFields('git_branch', obj, BASE_FIELDS);
        const data = await gitService.branch({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId: sessionOf(obj, ctx),
            owner: ownerOf('git_branch', ctx),
            timeoutMs: timeoutOf('git_branch', obj),
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['git_branch'] };
    }
});

const gitAdd = defineTool({
    name: 'git_add',
    capabilities: ['git.add'],
    description: 'Stage workspace-relative files for commit (needs approval; never stages the whole workspace)',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            paths: { type: 'array', description: 'non-empty workspace-relative file paths (no ".", globs, or absolute paths)' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' }
        },
        required: ['paths']
    },
    readOnly: false,
    needsApproval: true,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('git_add', input);
        checkFields('git_add', obj, [...BASE_FIELDS, 'paths']);
        const data = await gitService.add({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId: sessionOf(obj, ctx),
            owner: ownerOf('git_add', ctx),
            paths: obj.paths === undefined ? null : obj.paths,
            timeoutMs: timeoutOf('git_add', obj),
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['git_add'] };
    }
});

const gitCommit = defineTool({
    name: 'git_commit',
    capabilities: ['git.commit'],
    description: 'Commit staged changes with a short message (needs approval)',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            message: { type: 'string', description: 'single-line commit message, max 200 chars' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' }
        },
        required: ['message']
    },
    readOnly: false,
    needsApproval: true,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('git_commit', input);
        checkFields('git_commit', obj, [...BASE_FIELDS, 'message']);
        const data = await gitService.commit({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId: sessionOf(obj, ctx),
            owner: ownerOf('git_commit', ctx),
            message: obj.message === undefined ? null : obj.message,
            timeoutMs: timeoutOf('git_commit', obj),
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['git_commit'] };
    }
});

module.exports = { gitStatus, gitDiff, gitLog, gitBranch, gitAdd, gitCommit };
