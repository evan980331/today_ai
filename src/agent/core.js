// Agent Core — minimal deterministic loop (Phase 1-A, P2-A tool foundation).
// No LLM, single step, tool first, runtime fallback, single retry.
// Core knows only contracts: planner steps, ToolRegistry.execute(), runtime
// interface. It never imports any concrete tool implementation.
const planner = require('./planner');
const { AgentState } = require('./state');
const toolRegistry = require('../services/tools/toolRegistry');

function isRetryable(err) {
    if (!err || typeof err !== 'object') return false;
    // Never retry: planning shape, unknown tool, validation, abort, timeout
    if (err.status === 400) return false;
    if (err.code === 'PLANNING_ERROR' || err.code === 'TOOL_NOT_FOUND' || err.code === 'TASK_INVALID' || err.code === 'ABORTED' || err.code === 'TIMEOUT') return false;
    return true;
}

function toolNotFound(name) {
    return Object.assign(new Error(`unknown tool: ${name}`), { code: 'TOOL_NOT_FOUND', status: 400 });
}

function runtimeNotFound(name) {
    return Object.assign(new Error(`unknown runtime: ${name}`), { code: 'RUNTIME_ERROR', status: 400 });
}

async function run(task, opts = {}) {
    if (!task || typeof task !== 'object' || !task.id) throw Object.assign(new Error('task required'), { status: 400 });
    const state = new AgentState(task.id);
    const steps = planner.plan(task);
    let lastError = null;
    for (const step of steps) {
        state.setStep(step);
        let attempts = 0;
        while (true) {
            try {
                let result;
                if (step.kind === 'tool') {
                    // Core knows only registry contract: execute(name, input, ctx).
                    // Per-run execution context: taskId/sessionId/signal/timeout
                    // plus a logging hook and an approval stub (P2-A contract
                    // only — no approval system). Never shared across runs.
                    const tool = toolRegistry.get(step.name);
                    if (!tool) throw toolNotFound(step.name);
                    const toolCtx = {
                        taskId: task.id || null,
                        sessionId: task.sessionId || null,
                        signal: opts.signal || null,
                        timeoutMs: opts.timeoutMs || null,
                        logger: opts.logger || null,
                        // Approval decision rides the context; default denies
                        // nothing new (existing tools need no approval).
                        approval: opts.approval || { status: 'not_required' }
                    };
                    try {
                        result = await toolRegistry.execute(step.name, step.input, toolCtx);
                    } catch (e) {
                        if (e && (e.code === 'TOOL_NOT_FOUND' || e.code === 'ABORTED' || e.code === 'TIMEOUT' || e.status === 400)) throw e;
                        throw Object.assign(new Error(e.message || 'tool execution failed'), { code: 'TOOL_EXECUTION_ERROR', status: e.status || 500 });
                    }
                    const out = result && typeof result === 'object' && 'result' in result ? result : { result, mcpTools: [step.name] };
                    state.addToolResult(out);
                    state.complete(out);
                    return out;
                } else if (step.kind === 'runtime') {
                    // Core knows only runtime contract (interface.js); default adapter is opencodeRuntime.
                    const opencodeRuntime = require('../services/opencodeRuntime');
                    const known = { opencode: opencodeRuntime };
                    const runtime = known[step.name] || null;
                    if (!runtime) throw runtimeNotFound(step.name);
                    let out;
                    if (opts.onEvent) {
                        out = await runtime.executeStream({
                            prompt: step.input,
                            workspaceId: task.sessionId,
                            sessionId: task.sessionId,
                            signal: opts.signal,
                            timeoutMs: opts.timeoutMs,
                            onEvent: opts.onEvent
                        });
                    } else {
                        out = await runtime.execute({
                            prompt: step.input,
                            workspaceId: task.sessionId,
                            sessionId: task.sessionId,
                            signal: opts.signal,
                            timeoutMs: opts.timeoutMs
                        });
                    }
                    const normalized = typeof out === 'string' ? { result: out, mcpTools: [] } : out;
                    state.addToolResult(normalized);
                    state.complete(normalized);
                    return normalized;
                } else {
                    throw Object.assign(new Error(`unknown step kind: ${step.kind}`), { code: 'PLANNING_ERROR', status: 400 });
                }
            } catch (e) {
                lastError = e;
                if (attempts < 1 && isRetryable(e) && !(opts.signal && opts.signal.aborted)) {
                    attempts += 1;
                    state.incRetry();
                    state.addHistory({ type: 'retry', error: e.message });
                    continue;
                }
                state.fail(e);
                throw e;
            }
        }
    }
    if (lastError) throw lastError;
    throw Object.assign(new Error('no step executed'), { status: 500 });
}

module.exports = { run, isRetryable, toolNotFound, runtimeNotFound };
