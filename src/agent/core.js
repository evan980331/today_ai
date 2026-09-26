// Agent Core — controlled multi-step loop (P2-I).
// Deterministic planner -> sequential step execution -> final result.
// Hard limit MAX_STEPS: no infinite loops, no autonomous replanning.
// Core knows only contracts: planner steps, ToolRegistry.execute(), runtime
// interface. It never imports any concrete tool implementation.
const planner = require('./planner');
const { AgentState } = require('./state');
const toolRegistry = require('../services/tools/toolRegistry');

// Hard cap on steps per run. Plans longer than this execute the first
// MAX_STEPS steps, mark the rest skipped, and fail MAX_STEPS_EXCEEDED.
const MAX_STEPS = 8;

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

function maxStepsExceeded(remaining) {
    return Object.assign(new Error(`plan exceeds ${MAX_STEPS} steps (${remaining} skipped)`), { code: 'MAX_STEPS_EXCEEDED', status: 400 });
}

function skipRecord(step) {
    return { id: step.id, kind: step.kind, name: step.name, status: 'skipped', result: null, error: null };
}

async function run(task, opts = {}) {
    if (!task || typeof task !== 'object' || !task.id) throw Object.assign(new Error('task required'), { status: 400 });
    const state = new AgentState(task.id);
    // Available tool metadata for planner auto selection. Core never
    // interprets names or implementations — it only forwards metadata.
    // opts.steps carries an explicit multi-step plan when the caller has one.
    const steps = planner.plan(task, { toolMetadata: toolRegistry.list(), steps: opts.steps });
    const records = [];
    const mcpTools = [];
    let lastResult = null;
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        // Hard limit: stop executing, mark this and all later steps skipped.
        if (index >= MAX_STEPS) {
            for (let j = index; j < steps.length; j += 1) {
                const rec = skipRecord(steps[j]);
                records.push(rec);
                state.addStepRecord(rec);
            }
            const err = maxStepsExceeded(steps.length - MAX_STEPS);
            err.steps = records;
            state.fail(err);
            throw err;
        }
        // An external abort between steps stops the whole plan.
        if (opts.signal && opts.signal.aborted) {
            const err = Object.assign(new Error('aborted'), { code: 'ABORTED' });
            for (let j = index; j < steps.length; j += 1) {
                const rec = skipRecord(steps[j]);
                records.push(rec);
                state.addStepRecord(rec);
            }
            err.steps = records;
            state.fail(err);
            throw err;
        }
        state.setStep(step);
        let attempts = 0;
        while (true) {
            try {
                const out = await executeStep(step, task, opts, state);
                const rec = { id: step.id, kind: step.kind, name: step.name, status: 'completed', result: out, error: null };
                records.push(rec);
                state.addStepRecord(rec);
                for (const t of out.mcpTools || []) {
                    if (!mcpTools.includes(t)) mcpTools.push(t);
                }
                lastResult = out.result;
                break;
            } catch (e) {
                // Per-step single retry only — the plan as a whole is never
                // retried, and retry counts never grow with step count.
                if (attempts < 1 && isRetryable(e) && !(opts.signal && opts.signal.aborted)) {
                    attempts += 1;
                    state.incRetry();
                    state.addHistory({ type: 'retry', error: e.message });
                    continue;
                }
                const rec = {
                    id: step.id, kind: step.kind, name: step.name, status: failedStatusOf(e),
                    result: null, error: e && e.message ? e.message : String(e)
                };
                records.push(rec);
                state.addStepRecord(rec);
                for (let j = index + 1; j < steps.length; j += 1) {
                    const skipped = skipRecord(steps[j]);
                    records.push(skipped);
                    state.addStepRecord(skipped);
                }
                if (e && typeof e === 'object') e.steps = records;
                state.fail(e);
                throw e;
            }
        }
    }
    const final = { status: 'completed', steps: records, result: lastResult, mcpTools };
    state.complete(final);
    return final;
}

function failedStatusOf(e) {
    if (!e || typeof e !== 'object') return 'failed';
    if (e.code === 'ABORTED') return 'aborted';
    if (e.code === 'TIMEOUT') return 'timeout';
    return 'failed';
}

async function executeStep(step, task, opts, state) {
    let result;
    if (step.kind === 'tool') {
        // Core knows only registry contract: execute(name, input, ctx).
        // Per-run execution context: taskId/sessionId/signal/timeout
        // plus a logging hook and approval decision. Never shared across runs.
        const tool = toolRegistry.get(step.name);
        if (!tool) throw toolNotFound(step.name);
        const toolCtx = {
            taskId: task.id || null,
            sessionId: task.sessionId || null,
            owner: task.owner || null,
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
        return normalized;
    } else {
        throw Object.assign(new Error(`unknown step kind: ${step.kind}`), { code: 'PLANNING_ERROR', status: 400 });
    }
}

module.exports = { run, isRetryable, toolNotFound, runtimeNotFound, MAX_STEPS };
