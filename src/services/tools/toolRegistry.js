// Registry for Tool implementations (gmail / github / calendar / ...).
// Extension point, not a feature: callers validate requested tool names
// here so unknown tools fail fast with TOOL_NOT_FOUND instead of reaching
// a runtime. The registry never imports concrete tools (calculator, gmail,
// ...) — dependency inversion is preserved; tools register themselves.
//
// P2-A execution boundary (execute()):
// - unknown tool            -> TOOL_NOT_FOUND (status 400, no retry)
// - already-aborted signal  -> ABORTED (never wrapped)
// - abort during execution  -> ABORTED (never wrapped)
// - timeout                 -> TIMEOUT (never wrapped)
// - input mismatch / tool
//   validation (status 400) -> rethrown as-is (no retry)
// - any other tool failure  -> TOOL_EXECUTION_ERROR (status 500 unless the
//   tool already set one)
const { defineTool, toMetadata, validateToolInput, createExecutionContext, isAbortError, isTimeoutError } = require('./tool');

const tools = new Map(); // name -> frozen tool

function register(toolDef) {
    const tool = toolDef && typeof toolDef.execute === 'function' && Object.isFrozen(toolDef)
        ? toolDef
        : defineTool(toolDef);
    if (tools.has(tool.name)) {
        throw Object.assign(new Error(`tool already registered: ${tool.name}`), { status: 409, code: 'TOOL_ALREADY_REGISTERED' });
    }
    tools.set(tool.name, tool);
    return tool;
}

function get(name) {
    return tools.get(name) || null;
}

function has(name) {
    return tools.has(name);
}

// Stable discovery metadata. Returns fresh copies on every call so callers
// can never mutate registry-internal state. Never exposes execute().
function list() {
    return Array.from(tools.values()).map((t) => toMetadata(t));
}

// Single-tool metadata (copy), or null when unknown.
function describe(name) {
    const tool = get(name);
    return tool ? toMetadata(tool) : null;
}

// Throws 400 listing every unknown name. Empty input is valid (no tools).
function validateAll(names) {
    const list = names === undefined || names === null ? [] : names;
    if (!Array.isArray(list)) throw Object.assign(new Error('tools must be an array of names'), { status: 400 });
    const unknown = list.filter((n) => typeof n !== 'string' || !tools.has(n));
    if (unknown.length) {
        throw Object.assign(new Error(`unknown tools: ${unknown.join(', ')}`), { status: 400, code: 'TOOL_NOT_FOUND' });
    }
    return list.slice();
}

function abortError() {
    return Object.assign(new Error('aborted'), { code: 'ABORTED' });
}

function timeoutError(ms) {
    return Object.assign(new Error(`tool execution timed out after ${ms}ms`), { code: 'TIMEOUT' });
}

async function execute(name, input, context) {
    const tool = get(name);
    if (!tool) throw Object.assign(new Error(`unknown tool: ${name}`), { code: 'TOOL_NOT_FOUND', status: 400 });
    // Per-execution context: always a fresh object, never shared mutable state.
    const ctx = createExecutionContext(context || {});
    if (ctx.signal && ctx.signal.aborted) throw abortError();
    // Consistent input validation at the boundary (status 400).
    validateToolInput(tool, input);

    const timeoutMs = ctx.timeoutMs;
    let timer = null;
    let onAbort = null;

    const abortPromise = new Promise((_, reject) => {
        if (!ctx.signal) return;
        onAbort = () => reject(abortError());
        ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeoutPromise = timeoutMs
        ? new Promise((_, reject) => {
            timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
            if (timer.unref) timer.unref();
        })
        : null;

    const runPromise = (async () => tool.execute(input, ctx))();
    // Avoid unhandled rejection if abort/timeout wins the race.
    runPromise.catch(() => {});

    try {
        const racers = timeoutPromise ? [runPromise, abortPromise, timeoutPromise] : [runPromise, abortPromise];
        const result = ctx.signal || timeoutPromise
            ? await Promise.race(racers)
            : await runPromise;
        if (ctx.signal && ctx.signal.aborted) throw abortError();
        return result;
    } catch (e) {
        // Preserve boundary semantics: ABORTED / TIMEOUT / 400 pass through.
        if (isAbortError(e)) {
            const err = e.code === 'ABORTED' ? e : abortError();
            if (!err.code) err.code = 'ABORTED';
            throw err;
        }
        if (isTimeoutError(e)) throw e;
        if (e && e.status === 400) throw e;
        if (e && e.code === 'TOOL_NOT_FOUND') throw e;
        throw Object.assign(new Error((e && e.message) || 'tool execution failed'), {
            code: 'TOOL_EXECUTION_ERROR',
            status: (e && e.status) || 500,
            cause: e
        });
    } finally {
        if (timer) clearTimeout(timer);
        if (ctx.signal && onAbort) {
            try { ctx.signal.removeEventListener('abort', onAbort); } catch {}
        }
    }
}

function _clearForTests() {
    tools.clear();
}

module.exports = { register, get, has, list, describe, validateAll, execute, _clearForTests };
