// OpenCode as ONE agent runtime (not Today AI itself).
//
// Implements the runtime interface consumed by agentOrchestrator:
//   { name, execute, executeStream, abort, health }
// All OpenCode specifics (CLI `--format json`, server sessions, workspace
// cwd, event normalization) live here — never in routes, orchestrator,
// tools, or frontend. A future runtime replaces this module, not callers.
const { withWorker } = require('./agentWorker');
const { useRemoteWorker, executePrompt } = require('./workerProvider');
const { normalizeOpenCodeEvent, normalizeServerEvent } = require('./agentEvents');
const opencodeService = require('./opencode');

function runtimeError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function accumulate(norm, state) {
    if (norm.type === 'text.delta' && norm.content) state.fullText += norm.content;
    if (norm.type === 'tool.started' && norm.tool) state.tools.add(norm.tool);
}

async function execute({ prompt, workspaceId = null, sessionId = null, signal = null, timeoutMs = 600000 } = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw Object.assign(new Error('prompt is required'), { status: 400 });
    }
    if (signal && signal.aborted) throw runtimeError('ABORTED', 'aborted');
    // One-shot delegates to the provider (local withWorker / remote worker);
    // mock mode is honored inside the provider chain.
    return executePrompt({ prompt: prompt.trim(), workspaceId, sessionId, signal, timeoutMs });
}

async function executeStream({ prompt, workspaceId = null, sessionId = null, signal = null, timeoutMs = 600000, onEvent = null } = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw Object.assign(new Error('prompt is required'), { status: 400 });
    }
    if (signal && signal.aborted) throw runtimeError('ABORTED', 'aborted');
    const emit = (norm) => {
        if (typeof onEvent === 'function' && norm) {
            try { onEvent(norm); } catch {}
        }
    };
    if (useRemoteWorker()) {
        return streamViaRemote({ prompt: prompt.trim(), workspaceId, sessionId, signal, timeoutMs, emit });
    }
    if (process.env.NODE_ENV === 'production') {
        const hasUrl = !!(process.env.WORKER_URL && process.env.WORKER_URL.trim());
        const hasSecret = !!(process.env.WORKER_SHARED_SECRET && process.env.WORKER_SHARED_SECRET.trim());
        const msg = (hasUrl || hasSecret)
            ? 'Remote Worker misconfigured: WORKER_URL and WORKER_SHARED_SECRET must both be set'
            : 'Remote Worker is not configured';
        throw runtimeError('RUNTIME_UNAVAILABLE', msg);
    }
    return streamViaLocal({ prompt: prompt.trim(), workspaceId, sessionId, signal, emit });
}

async function streamViaLocal({ prompt, workspaceId, sessionId, signal, emit }) {
    const state = { fullText: '', tools: new Set() };
    const out = await withWorker({ workspaceId, signal }, async (client, worker, runSignal) => {
        const transport = await client.resolveTransport();
        if (transport === 'server') {
            return streamLocalServer(client, runSignal, { prompt, sessionId, state, emit });
        }
        return streamLocalCli(client, worker, runSignal, { prompt, state, emit });
    });
    return out;
}

async function streamLocalCli(client, worker, signal, { prompt, state, emit }) {
    const runRes = await client.subscribeEvents(prompt, {
        signal,
        cwd: worker && worker.workspacePath,
        onEvent: (raw) => {
            const norm = normalizeOpenCodeEvent(raw);
            if (!norm) return;
            accumulate(norm, state);
            emit(norm);
        }
    });
    // Authoritative full result preferred so history matches non-streaming.
    const result = typeof runRes === 'string' ? runRes : (runRes.result || state.fullText);
    const tools = typeof runRes === 'string' ? [] : (Array.isArray(runRes.mcpTools) && runRes.mcpTools.length ? runRes.mcpTools : Array.from(state.tools));
    return { result, mcpTools: tools };
}

async function streamLocalServer(client, signal, { prompt, sessionId, state, emit }) {
    const partTypes = {};
    const opSes = await client.createSession({ title: prompt.slice(0, 80) });
    emit({ type: 'message.started', sessionId: sessionId || null, opencodeSessionId: opSes.id });
    const evDone = client.subscribeSessionEvents(opSes.id, {
        signal,
        onRawEvent: (raw) => {
            if (raw && raw.type === 'session.idle' && raw.properties && raw.properties.sessionID === opSes.id) return;
            const norm = normalizeServerEvent(raw, partTypes);
            if (!norm) return;
            accumulate(norm, state);
            emit(norm);
        }
    });
    const msgP = client.promptSession(opSes.id, prompt, { signal });
    const [, msgRes] = await Promise.all([evDone, msgP]);
    const result = (msgRes && msgRes.result) || state.fullText;
    const tools = (msgRes && Array.isArray(msgRes.mcpTools) && msgRes.mcpTools.length) ? msgRes.mcpTools : Array.from(state.tools);
    return { result, mcpTools: tools };
}

async function streamViaRemote({ prompt, workspaceId, sessionId, signal, timeoutMs, emit }) {
    const { RemoteWorkerClient } = require('./remoteWorker');
    const rc = new RemoteWorkerClient({});
    console.warn(`[opencodeRuntime] streamViaRemote create worker workspaceId=${workspaceId || 'null'}`);
    const w = await rc.create({ workspaceId });
    console.warn(`[opencodeRuntime] worker created id=${w.workerId}`);
    const partTypes = {};
    const state = { fullText: '', tools: new Set() };
    const workerTimeoutMs = parseInt(process.env.WORKER_REQUEST_TIMEOUT_MS, 10) || timeoutMs || 600000;
    let abortSrc = null;
    const onSignalAbort = () => { abortSrc = 'signal-abort'; console.warn(`[opencodeRuntime] signal abort fired`); };
    if (signal) signal.addEventListener('abort', onSignalAbort, { once: true });
    try {
        console.warn(`[opencodeRuntime] executeStream start workerId=${w.workerId}`);
        const out = await rc.executeStream(w.workerId, {
            prompt,
            sessionId,
            signal,
            timeoutMs: workerTimeoutMs,
            onEvent: (ev) => {
                if (!ev || ev.kind !== 'upstream') return;
                const raw = ev.data;
                if (raw && raw.type === 'session.idle') return;
                const norm = normalizeServerEvent(raw, partTypes);
                if (!norm) return;
                accumulate(norm, state);
                emit(norm);
            }
        });
        console.warn(`[opencodeRuntime] executeStream done resultLen=${(out && out.result || '').length}`);
        const result = (out && out.result) || state.fullText;
        const tools = (out && Array.isArray(out.mcpTools) && out.mcpTools.length) ? out.mcpTools : Array.from(state.tools);
        return { result, mcpTools: tools };
    } catch (e) {
        console.warn(`[opencodeRuntime] executeStream error code=${e && e.code} msg=${(e && e.message || '').slice(0,120)} abortSrc=${abortSrc} signalAborted=${signal && signal.aborted}`);
        throw e;
    } finally {
        if (signal) signal.removeEventListener('abort', onSignalAbort);
        console.warn(`[opencodeRuntime] destroy worker ${w.workerId}`);
        await rc.destroy(w.workerId).catch(() => {});
    }
}

function abort(target) {
    if (target && typeof target.abort === 'function') {
        try { target.abort(); } catch {}
        return { ok: true };
    }
    return { ok: false, reason: 'no abort controller for this execution' };
}

async function health() {
    // Remote Worker first: in production without OPENCODE_SERVER_URL the
    // local runtime is 'unavailable', but that must never shadow a
    // configured remote worker.
    if (useRemoteWorker()) {
        // Reachability probe without creating workers: lightweight GET.
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 8000);
            if (t && t.unref) t.unref();
            const headers = {};
            const secret = process.env.WORKER_SHARED_SECRET || '';
            if (secret) headers['X-Worker-Auth'] = secret;
            const res = await fetch(`${process.env.WORKER_URL.replace(/\/+$/, '')}/health`, { headers, signal: controller.signal }).catch(() => null);
            clearTimeout(t);
            if (res && res.ok) return { available: true, runtime: 'opencode', mode: 'remote-worker' };
            return { available: false, runtime: 'opencode', mode: 'remote-worker', reason: 'worker health unreachable' };
        } catch (e) {
            return { available: false, runtime: 'opencode', mode: 'remote-worker', reason: e.message };
        }
    }
    const mode = opencodeService.getRuntimeMode();
    if (mode === 'mock') return { available: true, runtime: 'opencode', mode };
    if (mode === 'unavailable') {
        return { available: false, runtime: 'opencode', mode, reason: opencodeService.getRuntimeDetail().reason };
    }
    return { available: true, runtime: 'opencode', mode };
}

function describe() {
    // Synchronous, side-effect-free mode readout for /api/health.
    // Never probes the network (unlike health() in remote mode).
    // Shape stays compatible with the previous runtime detail payload.
    if (useRemoteWorker()) {
        return { runtime: 'opencode', mode: 'remote', reason: 'remote worker' };
    }
    try {
        const detail = opencodeService.getRuntimeDetail();
        return { runtime: 'opencode', mode: detail.mode, reason: detail.reason || null };
    } catch {
        return { runtime: 'opencode', mode: 'unknown', reason: null };
    }
}

module.exports = {
    name: 'opencode',
    execute,
    executeStream,
    abort,
    health,
    describe,
    // Shared default prompt timeout (ms). Routes use this instead of
    // reaching into OpenCode internals.
    DEFAULT_TIMEOUT_MS: opencodeService.MCP_TIMEOUT_MS
};
