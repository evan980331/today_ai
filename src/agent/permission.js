// Permission / Approval boundary (P2-F).
//
// Deterministic backend-only gate between ToolRegistry and tool execution.
// No UI, no persistence, no global state, no LLM decisions.
//
// Resolution (deny by default — only an explicit 'approved' allows):
//   needsApproval=false                    -> not_required, execute
//   needsApproval=true, approval missing/
//     pending / not_required               -> PERMISSION_REQUIRED (no retry)
//   needsApproval=true, approval rejected  -> PERMISSION_DENIED (no retry)
//   needsApproval=true, unrecognized status-> APPROVAL_INVALID (no retry)
//
// All permission errors carry status 400 so they pass the ToolRegistry
// boundary verbatim and are never retried by Agent Core. Messages are
// generic: no input echo, no credentials, no filesystem paths.
function permissionError(code, message) {
    return Object.assign(new Error(message), { status: 400, code });
}

function checkApproval(tool, ctx) {
    if (!tool || typeof tool !== 'object') {
        throw permissionError('PERMISSION_REQUIRED', 'tool approval could not be verified');
    }
    if (!tool.needsApproval) return 'not_required';
    const a = ctx && typeof ctx === 'object' ? ctx.approval : undefined;
    const status = a && typeof a.status === 'string' ? a.status : 'pending';
    if (status === 'approved') return 'approved';
    if (status === 'rejected') {
        throw permissionError('PERMISSION_DENIED', 'tool execution was rejected');
    }
    if (status === 'pending' || status === 'not_required') {
        throw permissionError('PERMISSION_REQUIRED', 'tool execution requires approval');
    }
    throw permissionError('APPROVAL_INVALID', 'tool approval status is not recognized');
}

module.exports = { checkApproval };
