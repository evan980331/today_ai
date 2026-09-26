// P3-7 Change Proposal native tools: agents propose file changes as
// reviewable unified diffs; only change_apply writes, gated by approval.
//
// change_propose / change_get : readOnly, no approval (proposal creation
//   is side-effect free).
// change_apply : needsApproval:true, capability change.apply. Acts ONLY on
//   the stored proposal snapshot — input is { proposalId }, never paths
//   or contents — so an approval can only ever mean "this exact proposal".
// change_reject : no approval (safe state transition on own proposal).
//
// Owner/session come ONLY from the server execution context; the workspace
// root always comes from WorkspaceService. No command/cwd/env inputs.
const { defineTool } = require('./tool');
const proposalService = require('../changeProposalService');

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

function checkObject(tool, input) {
    const obj = input === undefined || input === null ? {} : input;
    if (typeof obj !== 'object' || Array.isArray(obj)) throw inputError(tool, 'input must be an object');
    return obj;
}

function checkFields(tool, obj, allowed) {
    const set = new Set(allowed);
    for (const k of Object.keys(obj)) {
        if (!set.has(k)) throw inputError(tool, `field "${k}" is not allowed`);
    }
}

const BASE_FIELDS = ['workspaceId', 'sessionId', 'timeoutMs'];

const changePropose = defineTool({
    name: 'change_propose',
    capabilities: ['change.propose'],
    description: 'Propose file changes as a reviewable unified diff (read-only, no files are modified)',
    inputSchema: {
        type: 'object',
        properties: {
            workspaceId: { type: 'string', description: 'explicit workspace id (must belong to the caller)' },
            sessionId: { type: 'string', description: 'workspace session (defaults to the execution session)' },
            changes: { type: 'array', description: 'list of { path, content } (content null deletes the file)' },
            timeoutMs: { type: 'number', description: 'timeout 1-120000ms (default 30000)' }
        },
        required: ['changes']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('change_propose', input);
        checkFields('change_propose', obj, [...BASE_FIELDS, 'changes']);
        const data = await proposalService.propose({
            workspaceId: obj.workspaceId === undefined ? null : obj.workspaceId,
            sessionId: sessionOf(obj, ctx),
            owner: ownerOf('change_propose', ctx),
            changes: obj.changes === undefined ? null : obj.changes,
            timeoutMs: obj.timeoutMs === undefined ? null : obj.timeoutMs,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['change_propose'] };
    }
});

const changeGet = defineTool({
    name: 'change_get',
    capabilities: ['change.read'],
    description: 'Read a change proposal with its unified diffs (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            proposalId: { type: 'string', description: 'proposal id from change_propose' }
        },
        required: ['proposalId']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('change_get', input);
        checkFields('change_get', obj, ['proposalId']);
        const data = await proposalService.get({
            proposalId: obj.proposalId,
            owner: ownerOf('change_get', ctx),
            sessionId: (ctx && ctx.sessionId) || null,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['change_get'] };
    }
});

const changeApply = defineTool({
    name: 'change_apply',
    capabilities: ['change.apply'],
    description: 'Apply an approved change proposal by id only (needs approval; never takes paths or contents)',
    inputSchema: {
        type: 'object',
        properties: {
            proposalId: { type: 'string', description: 'proposal id from change_propose' }
        },
        required: ['proposalId']
    },
    readOnly: false,
    needsApproval: true,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('change_apply', input);
        checkFields('change_apply', obj, ['proposalId']);
        const data = await proposalService.applyProposal({
            proposalId: obj.proposalId,
            owner: ownerOf('change_apply', ctx),
            sessionId: (ctx && ctx.sessionId) || null,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['change_apply'] };
    }
});

const changeReject = defineTool({
    name: 'change_reject',
    capabilities: ['change.reject'],
    description: 'Reject a pending change proposal by id (no approval needed)',
    inputSchema: {
        type: 'object',
        properties: {
            proposalId: { type: 'string', description: 'proposal id from change_propose' }
        },
        required: ['proposalId']
    },
    readOnly: false,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = checkObject('change_reject', input);
        checkFields('change_reject', obj, ['proposalId']);
        const data = await proposalService.rejectProposal({
            proposalId: obj.proposalId,
            owner: ownerOf('change_reject', ctx),
            sessionId: (ctx && ctx.sessionId) || null,
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        return { result: data, mcpTools: ['change_reject'] };
    }
});

module.exports = { changePropose, changeGet, changeApply, changeReject };
