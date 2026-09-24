// Agent Orchestrator: User task -> tool/runtime selection -> execution.
//
// Layering (Vercel-safe):
//   routes -> agentOrchestrator -> runtime (opencodeRuntime by default)
//                                -> tools/toolRegistry (validation only)
// The orchestrator never imports OpenCode HTTP, child processes, sessions
// stores, or any runtime-specific API. Runtimes are swappable via
// registerRuntime(); tools are validated against the registry (empty in
// production this round — extension point, not a feature).
//
// Task lifecycle: queued -> running -> completed | failed | aborted | timeout.
// Executions stay synchronous from the caller's perspective (no queue yet);
// the model never assumes HTTP must wait — callers stream or poll.
const crypto = require('crypto');
const { validateAll: validateTools } = require('./tools/toolRegistry');
const opencodeRuntime = require('./opencodeRuntime');
const agentCore = require('../agent/core');

const runtimes = new Map([['opencode', opencodeRuntime]]);
const tasks = new Map(); // id -> task record
const controllers = new Map(); // taskId -> AbortController (in-flight)

const STATUSES = ['queued', 'running', 'completed', 'failed', 'aborted', 'timeout'];

function taskError(status, message) {
    const err = new Error(message);
    err.code = 'TASK_INVALID';
    err.status = status;
    return err;
}

function registerRuntime(name, impl) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
        throw taskError(400, 'runtime name must match /^[a-z][a-z0-9_-]{0,63}$/');
    }
    for (const fn of ['execute', 'executeStream', 'abort', 'health']) {
        if (!impl || typeof impl[fn] !== 'function') {
            throw taskError(400, `runtime "${name}" must implement ${fn}()`);
        }
    }
    if (runtimes.has(name)) throw taskError(409, `runtime already registered: ${name}`);
    runtimes.set(name, impl);
    return impl;
}

function unregisterRuntime(name) {
    return runtimes.delete(name);
}

function selectRuntime(task) {
    const name = (task && task.runtime) || 'opencode';
    const runtime = runtimes.get(name);
    if (!runtime) throw taskError(400, `unknown runtime: ${name}`);
    return runtime;
}

function publicTask(task) {
    return {
        id: task.id,
        sessionId: task.sessionId,
        owner: task.owner,
        runtime: task.runtime,
        tools: task.tools.slice(),
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        result: task.result || null,
        error: task.error || null
    };
}

function createTask({ prompt = null, sessionId, owner = 'unknown', runtime = 'opencode', tools = [] } = {}) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw taskError(400, 'task requires sessionId');
    }
    if (prompt !== null && prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim())) {
        throw taskError(400, 'task prompt must be a non-empty string');
    }
    if (!runtimes.has(runtime)) throw taskError(400, `unknown runtime: ${runtime}`);
    const toolNames = validateTools(tools);
    const now = Date.now();
    const task = {
        id: crypto.randomUUID(),
        sessionId,
        owner,
        prompt: prompt ? prompt.trim() : null,
        runtime,
        tools: toolNames,
        status: 'queued',
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null
    };
    tasks.set(task.id, task);
    return publicTask(task);
}

function getTask(id) {
    const task = tasks.get(id);
    return task ? publicTask(task) : null;
}

function setStatus(task, status, extra) {
    task.status = status;
    task.finishedAt = Date.now();
    if (extra && extra.result !== undefined) task.result = extra.result;
    if (extra && extra.error !== undefined) task.error = extra.error;
}

async function runTask(id, { signal = null, timeoutMs = 600000 } = {}) {
    const task = tasks.get(id);
    if (!task) throw taskError(404, `unknown task: ${id}`);
    if (task.status !== 'queued') throw taskError(409, `task already ${task.status}`);
    const runtime = selectRuntime(task);
    const controller = new AbortController();
    controllers.set(id, controller);
    const onExternalAbort = () => { try { controller.abort(); } catch {} };
    if (signal) {
        if (signal.aborted) {
            controllers.delete(id);
            setStatus(task, 'aborted', { error: 'aborted' });
            const err = new Error('aborted');
            err.code = 'ABORTED';
            throw err;
        }
        signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    task.status = 'running';
    task.startedAt = Date.now();
    try {
        if (!task.prompt) throw taskError(400, 'task has no prompt to run');
        // Phase 1-A: use AgentCore when tools are requested, otherwise direct runtime (keeps existing P0 tests green)
        let out;
        if (task.tools && task.tools.length > 0) {
            out = await agentCore.run(task, { signal: controller.signal, timeoutMs });
        } else {
            const runtime = selectRuntime(task);
            out = await runtime.execute({
                prompt: task.prompt,
                workspaceId: task.sessionId,
                sessionId: task.sessionId,
                tools: task.tools,
                signal: controller.signal,
                timeoutMs
            });
        }
        const result = typeof out === 'string' ? { result: out, mcpTools: [] } : out;
        setStatus(task, 'completed', { result });
        return result;
    } catch (err) {
        const code = err && err.code;
        const status = code === 'ABORTED' ? 'aborted' : code === 'TIMEOUT' ? 'timeout' : 'failed';
        setStatus(task, status, { error: (err && err.message ? err.message : 'failed').slice(0, 500) });
        throw err;
    } finally {
        if (signal) signal.removeEventListener('abort', onExternalAbort);
        controllers.delete(id);
    }
}

async function streamTask(id, { signal = null, timeoutMs = 600000, onEvent = null } = {}) {
    const task = tasks.get(id);
    if (!task) throw taskError(404, `unknown task: ${id}`);
    if (task.status !== 'queued') throw taskError(409, `task already ${task.status}`);
    if (!task.prompt) throw taskError(400, 'task has no prompt to run');
    const runtime = selectRuntime(task);
    const controller = new AbortController();
    controllers.set(id, controller);
    const onExternalAbort = () => { try { controller.abort(); } catch {} };
    if (signal) {
        if (signal.aborted) {
            controllers.delete(id);
            setStatus(task, 'aborted', { error: 'aborted' });
            const err = new Error('aborted');
            err.code = 'ABORTED';
            throw err;
        }
        signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    task.status = 'running';
    task.startedAt = Date.now();
    try {
        if (!task.prompt) throw taskError(400, 'task has no prompt to run');
        let out;
        if (task.tools && task.tools.length > 0) {
            out = await agentCore.run(task, { signal: controller.signal, timeoutMs, onEvent });
        } else {
            const runtime = selectRuntime(task);
            out = await runtime.executeStream({
                prompt: task.prompt,
                workspaceId: task.sessionId,
                sessionId: task.sessionId,
                tools: task.tools,
                signal: controller.signal,
                timeoutMs,
                onEvent
            });
        }
        const result = typeof out === 'string' ? { result: out, mcpTools: [] } : out;
        setStatus(task, 'completed', { result });
        return result;
    } catch (err) {
        const code = err && err.code;
        const status = code === 'ABORTED' ? 'aborted' : code === 'TIMEOUT' ? 'timeout' : 'failed';
        setStatus(task, status, { error: (err && err.message ? err.message : 'failed').slice(0, 500) });
        throw err;
    } finally {
        if (signal) signal.removeEventListener('abort', onExternalAbort);
        controllers.delete(id);
    }
}

function abortTask(id) {
    const controller = controllers.get(id);
    if (!controller) return { ok: false, reason: 'no in-flight execution' };
    try { controller.abort(); } catch {}
    return { ok: true };
}

function _clearForTests() {
    tasks.clear();
    controllers.clear();
}

module.exports = {
    STATUSES,
    createTask,
    getTask,
    runTask,
    streamTask,
    abortTask,
    selectRuntime,
    registerRuntime,
    unregisterRuntime,
    _clearForTests
};
