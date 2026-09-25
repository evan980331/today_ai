// Tool interface for future Gmail / GitHub / Calendar integrations.
//
// A Tool is a plain object (frozen by defineTool):
//   { name, description, inputSchema, readOnly, needsApproval, capabilities, execute }
// capabilities is planner-selection metadata only (string[], default []):
// it never replaces Permission and never executes anything.
// where execute(input, context) is async and returns a JSON-serializable
// value. Tools never touch OpenCode, child processes, or worker internals;
// they run inside the Vercel-safe backend layer. No Gmail/GitHub/Calendar
// implementations ship in this round — only the contract.
//
// P2-A notes:
// - defineTool validates eagerly so invalid definitions fail at
//   registration/creation time, never at first execution.
// - inputSchema is kept as metadata (opaque object or null). Only a minimal
//   structural check is enforced here (see validateToolInput); full JSON
//   Schema validation is a future extension point.
// - Execution context is created per run via createExecutionContext().
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

function toolError(status, message, extra) {
    return Object.assign(new Error(message), { status }, extra);
}

function defineTool(def) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
        throw toolError(400, 'tool definition must be an object');
    }
    const { name, description, execute, inputSchema, readOnly, needsApproval, capabilities } = def;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw toolError(400, 'tool name must match /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/ (namespaced tools use dots, e.g. gmail.search)');
    }
    if (typeof description !== 'string' || !description.trim() || description.length > 500) {
        throw toolError(400, 'tool description must be a non-empty string (max 500)');
    }
    if (typeof execute !== 'function') {
        throw toolError(400, `tool "${name}" must provide execute(input, context)`);
    }
    // inputSchema: optional metadata. When provided it must be a plain
    // object (e.g. { type: 'string', ... }); null/undefined means "no
    // declared schema". Arrays are rejected to keep the extension point clean.
    let schema = null;
    if (inputSchema !== undefined && inputSchema !== null) {
        if (typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
            throw toolError(400, `tool "${name}" inputSchema must be an object or null`);
        }
        schema = inputSchema;
    }
    if (readOnly !== undefined && typeof readOnly !== 'boolean') {
        throw toolError(400, `tool "${name}" readOnly must be a boolean`);
    }
    if (needsApproval !== undefined && typeof needsApproval !== 'boolean') {
        throw toolError(400, `tool "${name}" needsApproval must be a boolean`);
    }
    // capabilities: planner-selection metadata only, string[] default [].
    // Defensive copy + frozen so external code can never mutate the inside.
    let caps = [];
    if (capabilities !== undefined && capabilities !== null) {
        if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string')) {
            throw toolError(400, `tool "${name}" capabilities must be an array of strings`);
        }
        caps = capabilities.slice();
    }
    const tool = {
        name,
        description: description.trim(),
        execute,
        inputSchema: schema,
        readOnly: readOnly === undefined ? false : readOnly,
        needsApproval: needsApproval === undefined ? false : needsApproval,
        capabilities: Object.freeze(caps)
    };
    return Object.freeze(tool);
}

// Stable metadata representation for planners / Agent Core.
// Never exposes the live tool instance (in particular never execute()).
function toMetadata(tool) {
    if (!tool || typeof tool !== 'object') return null;
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema === undefined
            ? null
            : (tool.inputSchema && typeof tool.inputSchema === 'object'
                ? JSON.parse(JSON.stringify(tool.inputSchema))
                : tool.inputSchema),
        readOnly: !!tool.readOnly,
        needsApproval: !!tool.needsApproval,
        capabilities: Array.isArray(tool.capabilities) ? tool.capabilities.slice() : []
    };
}

// Minimal input validation at the tool boundary.
// - No declared schema (null) -> no check; tool validates its own input.
// - { type: 'string' } -> input must be a string (emptiness is the tool's
//   own decision, e.g. calculator rejects empty with status 400).
// - Any other schema shape -> treated as opaque metadata for now (no false
//   rejections); full JSON-Schema support is a future extension point.
// Throws status 400 with code TOOL_INVALID_INPUT on mismatch.
function validateToolInput(tool, input) {
    const schema = tool && tool.inputSchema;
    if (schema === null || schema === undefined) return;
    if (typeof schema === 'object' && schema.type === 'string') {
        if (typeof input !== 'string') {
            throw toolError(400, `tool "${tool.name}" expects a string input`, { code: 'TOOL_INVALID_INPUT' });
        }
    }
}

// Execution context contract (per execution — never shared across runs).
// Fields:
//   taskId, sessionId : string|null routing identifiers
//   signal            : AbortSignal|null
//   timeoutMs         : number|null (execution budget; enforced by registry)
//   logger            : { info,warn,error }|null logging hook (optional)
//   approval          : { status } stub contract only; full approval system
//                       is out of scope for P2-A (always 'not_required').
function createExecutionContext(fields = {}) {
    const src = fields && typeof fields === 'object' ? fields : {};
    // Accept task/step nesting from Agent Core callers.
    const taskId = src.taskId !== undefined ? src.taskId
        : (src.task && src.task.id !== undefined ? src.task.id : null);
    const sessionId = src.sessionId !== undefined ? src.sessionId
        : (src.task && src.task.sessionId !== undefined ? src.task.sessionId : null);
    const signal = src.signal !== undefined ? src.signal
        : (src.step !== undefined ? undefined : null);
    const ctx = {
        taskId: typeof taskId === 'string' ? taskId : (taskId === null || taskId === undefined ? null : String(taskId)),
        sessionId: typeof sessionId === 'string' ? sessionId : (sessionId === null || sessionId === undefined ? null : String(sessionId)),
        signal: signal === undefined ? null : signal,
        timeoutMs: typeof src.timeoutMs === 'number' && Number.isFinite(src.timeoutMs) && src.timeoutMs > 0
            ? Math.floor(src.timeoutMs)
            : null,
        logger: src.logger !== undefined ? src.logger : null,
        approval: src.approval !== undefined ? src.approval : { status: 'not_required' }
    };
    return ctx;
}

function isAbortError(err) {
    return !!err && (err.code === 'ABORTED' || err.name === 'AbortError');
}

function isTimeoutError(err) {
    return !!err && err.code === 'TIMEOUT';
}

module.exports = {
    defineTool,
    NAME_RE,
    toMetadata,
    validateToolInput,
    createExecutionContext,
    isAbortError,
    isTimeoutError
};
