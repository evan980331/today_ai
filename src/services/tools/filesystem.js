// Filesystem Native Tools (read-only): filesystem.read / filesystem.list.
//
// Built with defineTool() per the P2-A contract. Reads go through the
// sandbox resolver (./filesystem/sandbox.js) and the read-only client
// (./filesystem/client.js): fs/promises only, no child_process, no shell,
// no URLs, no writes of any kind.
//
// The Agent Core never imports this file — tools reach execution only via
// Planner -> ToolRegistry.
const { defineTool } = require('./tool');
const { resolveSandboxPath } = require('../filesystem/sandbox');
const fsClient = require('../filesystem/client');

function inputError(toolName, message) {
    return Object.assign(new Error(`${toolName}: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function signalOf(ctx) {
    return ctx && ctx.signal ? ctx.signal : null;
}

function checkMaxBytes(toolName, value) {
    if (value === undefined || value === null) return fsClient.DEFAULT_MAX_BYTES;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > fsClient.HARD_MAX_BYTES) {
        throw inputError(toolName, `maxBytes must be an integer between 1 and ${fsClient.HARD_MAX_BYTES}`);
    }
    return value;
}

function checkMaxEntries(toolName, value) {
    if (value === undefined || value === null) return 500;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5000) {
        throw inputError(toolName, 'maxEntries must be an integer between 1 and 5000');
    }
    return value;
}

const filesystemRead = defineTool({
    name: 'filesystem.read',
    capabilities: ['filesystem.read'],
    description: 'Read a UTF-8 text file inside the workspace (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'workspace-relative file path' },
            maxBytes: { type: 'number', description: 'max bytes to read (default 65536, hard cap 1048576)' }
        },
        required: ['path']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: the deterministic planner passes the raw prompt string
        // as step input, so a bare string is treated as { path: input }.
        if (typeof input === 'string') input = { path: input };
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw inputError('filesystem.read', 'input must be an object with path');
        }
        if (typeof input.path !== 'string' || !input.path.trim()) {
            throw inputError('filesystem.read', 'path must be a non-empty string');
        }
        const maxBytes = checkMaxBytes('filesystem.read', input.maxBytes);
        const resolved = await resolveSandboxPath(input.path);
        checkAborted(ctx);
        const data = await fsClient.readFile(resolved, { maxBytes, signal: signalOf(ctx) });
        checkAborted(ctx);
        return { result: data, mcpTools: ['filesystem.read'] };
    }
});

const filesystemList = defineTool({
    name: 'filesystem.list',
    capabilities: ['filesystem.read', 'filesystem.list'],
    description: 'List a directory inside the workspace, non-recursive (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'workspace-relative directory (empty or . = root)' },
            maxEntries: { type: 'number', description: 'max entries to return (1-5000, default 500)' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: a bare string is treated as { path: input }.
        if (typeof input === 'string') input = { path: input };
        const obj = input === undefined || input === null ? {} : input;
        if (typeof obj !== 'object' || Array.isArray(obj)) {
            throw inputError('filesystem.list', 'input must be an object');
        }
        if (obj.path !== undefined && obj.path !== null && typeof obj.path !== 'string') {
            throw inputError('filesystem.list', 'path must be a string when provided');
        }
        const maxEntries = checkMaxEntries('filesystem.list', obj.maxEntries);
        const resolved = await resolveSandboxPath(
            typeof obj.path === 'string' && obj.path.trim() ? obj.path : '.'
        );
        checkAborted(ctx);
        const data = await fsClient.listDir(resolved, { signal: signalOf(ctx) });
        checkAborted(ctx);
        const truncated = data.entries.length > maxEntries;
        return {
            result: { path: data.path, entries: data.entries.slice(0, maxEntries), truncated },
            mcpTools: ['filesystem.list']
        };
    }
});

module.exports = { filesystemRead, filesystemList };
