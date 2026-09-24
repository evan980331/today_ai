// Tool interface for future Gmail / GitHub / Calendar integrations.
//
// A Tool is a plain object (frozen by defineTool):
//   { name, description, execute }
// where execute(input, context) is async and returns a JSON-serializable
// value. Tools never touch OpenCode, child processes, or worker internals;
// they run inside the Vercel-safe backend layer. No Gmail/GitHub/Calendar
// implementations ship in this round — only the contract.
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function defineTool(def) {
    if (!def || typeof def !== 'object') {
        throw Object.assign(new Error('tool definition must be an object'), { status: 400 });
    }
    const { name, description, execute, inputSchema, readOnly, needsApproval } = def;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw Object.assign(new Error('tool name must match /^[a-z][a-z0-9_-]{0,63}$/'), { status: 400 });
    }
    if (typeof description !== 'string' || !description.trim() || description.length > 500) {
        throw Object.assign(new Error('tool description must be a non-empty string (max 500)'), { status: 400 });
    }
    if (typeof execute !== 'function') {
        throw Object.assign(new Error(`tool "${name}" must provide execute(input, context)`), { status: 400 });
    }
    const tool = {
        name,
        description: description.trim(),
        execute,
        inputSchema: inputSchema || null,
        readOnly: !!readOnly,
        needsApproval: !!needsApproval
    };
    return Object.freeze(tool);
}

module.exports = { defineTool, NAME_RE };
