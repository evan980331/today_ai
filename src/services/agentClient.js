// OpenCodeClient abstraction.
//
// Transports:
//   cli    - local `opencode` binary via run()/runStream() (structured
//            `--format json` events). Works wherever the binary exists.
//   server - external OpenCode Server over HTTP, verified against opencode
//            1.18.30 (`GET /doc` OpenAPI + live probing):
//              health         GET /
//              createSession  POST /session {title?, agent?}
//              sendPrompt     POST /session/{id}/message {parts:[{type,text}]}
//              subscribeEvents GET /event (SSE, global stream, filtered by
//                             properties.sessionID client-side)
//              abortSession   POST /session/{id}/abort
//            Auth: HTTP Basic (OPENCODE_SERVER_USERNAME/PASSWORD).
//            Every method has timeout + AbortSignal support and maps
//            401/403/404/409/429/5xx/network failures to distinct codes.
const opencodeService = require('./opencode');

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';

function notImplemented(what) {
    const err = new Error(
        `${what} is not implemented for the OpenCode Server transport. ` +
        'Use CLI transport or configure a verified server.'
    );
    err.code = NOT_IMPLEMENTED;
    return err;
}

// Server-side error codes. Passwords are never included in messages.
const ERR_UNREACHABLE = 'UPSTREAM_UNREACHABLE';
const ERR_AUTH = 'UPSTREAM_AUTH';
const ERR_BAD_REQUEST = 'UPSTREAM_BAD_REQUEST';
const ERR_NOT_FOUND = 'UPSTREAM_NOT_FOUND';
const ERR_CONFLICT = 'UPSTREAM_CONFLICT';
const ERR_RATE_LIMITED = 'UPSTREAM_RATE_LIMITED';
const ERR_UPSTREAM = 'UPSTREAM_ERROR';

function upstreamError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

class OpenCodeClient {
    constructor(opts = {}) {
        this.explicitTransport = !!opts.transport;
        this.transport = opts.transport || (opencodeService.isServerUrlConfigured() ? 'server' : 'cli');
        this.serverUrl = (opts.serverUrl || process.env.OPENCODE_SERVER_URL || '').replace(/\/+$/, '');
        this.username = opts.username || process.env.OPENCODE_SERVER_USERNAME || 'opencode';
        this.password = opts.password || process.env.OPENCODE_SERVER_PASSWORD || '';
        this.workspaceDir = opts.workspaceDir || null;
    }

    authHeader() {
        if (!this.password) return null;
        return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    }

    // CLI transport: binary responds to --version. Server: HTTP probe.
    // Unavailable runtime: explicit { available: false }.
    // An explicitly requested server transport is always probed directly
    // (never short-circuited by mock mode) so callers get a real answer.
    async health() {
        if (this.transport === 'server') {
            return this.probeServer();
        }
        const mode = opencodeService.getRuntimeMode();
        if (mode === 'mock') {
            return { available: true, transport: 'mock', mode };
        }
        if (mode === 'unavailable') {
            return { available: false, transport: this.transport, mode, reason: opencodeService.getRuntimeDetail().reason };
        }
        if (mode === 'remote-server') {
            return this.probeServer();
        }
        // CLI transport: verify binary exists. On Windows only the npm
        // shims are on PATH, so use the proven powershell form.
        try {
            const { execFile } = require('child_process');
            const file = process.platform === 'win32' ? 'powershell.exe' : 'opencode';
            const fargs = process.platform === 'win32' ? ['-NoProfile', '-Command', 'opencode --version'] : ['--version'];
            await new Promise((resolve, reject) => {
                execFile(file, fargs, { timeout: 10000, windowsHide: true }, (err, stdout) => {
                    if (err) return reject(err);
                    resolve(stdout);
                });
            });
            return { available: true, transport: 'cli', mode };
        } catch (e) {
            return { available: false, transport: 'cli', mode, reason: `opencode binary not found: ${e.message}` };
        }
    }

    async probeServer() {
        const mode = opencodeService.getRuntimeMode();
        if (!this.serverUrl) {
            return { available: false, transport: 'server', mode, reason: 'OPENCODE_SERVER_URL not configured' };
        }
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 5000);
            const headers = {};
            const auth = this.authHeader();
            if (auth) headers['Authorization'] = auth;
            const res = await fetch(this.serverUrl, { headers, signal: controller.signal }).catch(() => null);
            clearTimeout(t);
            if (!res) return { available: false, transport: 'server', mode, reason: `unreachable: ${this.serverUrl}` };
            const authorized = res.status !== 401 || !!this.password;
            return { available: authorized, transport: 'server', mode, status: res.status, authRequired: res.status === 401 && !this.password };
        } catch (e) {
            return { available: false, transport: 'server', mode, reason: e.message };
        }
    }

    // Resolve the effective transport: 'server' only when a server URL is
    // configured AND reachable. An explicitly requested server transport is
    // honored strictly (unreachable = explicit RUNTIME_UNAVAILABLE). A
    // defaulted server transport falls back to CLI in dev (mirrors run()'s
    // attach-or-spawn behavior) and fails explicitly in production.
    async resolveTransport() {
        if (this.transport === 'cli' || this.transport === 'mock') return 'cli';
        const h = await this.health();
        if (h.available && h.transport === 'server') return 'server';
        if (this.explicitTransport || process.env.NODE_ENV === 'production') {
            throw opencodeService.runtimeUnavailableError(
                `OpenCode Server unreachable at ${this.serverUrl || '(OPENCODE_SERVER_URL not configured)'}`
            );
        }
        return 'cli';
    }

    // Low-level server call with timeout + caller-signal linking.
    // Never rejects with raw fetch errors or password material.
    async serverRequest(path, { method = 'GET', body = null, signal = null, timeoutMs = 15000 } = {}) {
        if (!this.serverUrl) {
            throw upstreamError(ERR_UNREACHABLE, 'OPENCODE_SERVER_URL not configured');
        }
        const ctrl = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
        if (timer.unref) timer.unref();
        const onCallerAbort = () => ctrl.abort();
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                const err = new Error('OpenCode Server request aborted by client');
                err.code = 'ABORTED';
                throw err;
            }
            signal.addEventListener('abort', onCallerAbort, { once: true });
        }
        try {
            const headers = { 'Content-Type': 'application/json' };
            const auth = this.authHeader();
            if (auth) headers['Authorization'] = auth;
            const res = await fetch(this.serverUrl + path, {
                method,
                headers,
                body: body === null ? undefined : JSON.stringify(body),
                signal: ctrl.signal
            });
            const text = await res.text().catch(() => '');
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
            if (res.status === 401) throw upstreamError(ERR_AUTH, 'OpenCode Server rejected credentials (401)');
            if (res.status === 403) throw upstreamError(ERR_AUTH, 'OpenCode Server forbade request (403)');
            if (res.status === 404) {
                const msg = (data && data.data && data.data.message) || (data && data.message) || 'not found';
                throw upstreamError(ERR_NOT_FOUND, `OpenCode Server: ${String(msg).slice(0, 200)}`);
            }
            if (res.status === 409) throw upstreamError(ERR_CONFLICT, 'OpenCode Server conflict (409)');
            if (res.status === 429) throw upstreamError(ERR_RATE_LIMITED, 'OpenCode Server rate limited (429)');
            if (res.status === 400) {
                const msg = (data && data.message) || (data && data.data && data.data.message) || 'bad request';
                throw upstreamError(ERR_BAD_REQUEST, `OpenCode Server: ${String(msg).slice(0, 200)}`);
            }
            if (res.status >= 500) throw upstreamError(ERR_UPSTREAM, `OpenCode Server error (${res.status})`);
            if (res.status >= 300) throw upstreamError(ERR_UPSTREAM, `OpenCode Server unexpected status (${res.status})`);
            return { status: res.status, data };
        } catch (e) {
            if (e && (e.code === ERR_AUTH || e.code === ERR_BAD_REQUEST || e.code === ERR_NOT_FOUND ||
                e.code === ERR_CONFLICT || e.code === ERR_RATE_LIMITED || e.code === ERR_UPSTREAM)) {
                throw e;
            }
            if (e && e.code === 'ABORTED') throw e;
            if (timedOut || (e && e.name === 'AbortError')) {
                if (signal && signal.aborted) {
                    const err = new Error('OpenCode Server request aborted by client');
                    err.code = 'ABORTED';
                    throw err;
                }
                const err = new Error(`OpenCode Server request timed out after ${timeoutMs}ms`);
                err.code = 'TIMEOUT';
                throw err;
            }
            throw upstreamError(ERR_UNREACHABLE, `OpenCode Server unreachable at ${this.serverUrl}`);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onCallerAbort);
        }
    }

    async createSession(opts = {}) {
        const t = await this.resolveTransport();
        if (t === 'cli') {
            // CLI transport is stateless per run; session identity is the
            // Today AI agent-session id managed by the caller.
            return { id: opts.id || null, transport: 'cli' };
        }
        const body = {};
        if (opts.title) body.title = String(opts.title).slice(0, 200);
        if (opts.agent) body.agent = String(opts.agent).slice(0, 64);
        const { data } = await this.serverRequest('/session', {
            method: 'POST', body, signal: opts.signal, timeoutMs: opts.timeoutMs || 15000
        });
        if (!data || typeof data.id !== 'string') {
            throw upstreamError(ERR_UPSTREAM, 'OpenCode Server returned malformed session');
        }
        return { id: data.id, slug: data.slug || null, transport: 'server' };
    }

    // One-shot prompt for both transports.
    // CLI: buffered run(). Server: create is done by caller; this posts the
    // message and blocks until the turn completes (verified behavior).
    async sendPrompt(prompt, opts = {}) {
        const t = await this.resolveTransport();
        if (t === 'cli') {
            return opencodeService.run(prompt, { ...opts, cwd: opts.cwd || this.workspaceDir });
        }
        const session = await this.createSession({ title: String(prompt).slice(0, 80) });
        return this.promptSession(session.id, prompt, opts);
    }

    // Post a user message to an existing server session. Returns the full
    // assistant turn { result, mcpTools }. CLI transport has no server-side
    // sessions: use sendPrompt()/subscribeEvents() instead.
    async promptSession(opencodeSessionId, text, opts = {}) {
        const t = await this.resolveTransport();
        if (t === 'cli') {
            throw notImplemented('promptSession (CLI transport is stateless; use sendPrompt)');
        }
        if (!opencodeSessionId || typeof opencodeSessionId !== 'string') {
            throw upstreamError(ERR_BAD_REQUEST, 'promptSession requires an OpenCode session id');
        }
        const timeoutMs = opts.timeoutMs || opencodeService.MCP_TIMEOUT_MS;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        if (timer.unref) timer.unref();
        const onCallerAbort = () => ctrl.abort();
        if (opts.signal) {
            if (opts.signal.aborted) {
                clearTimeout(timer);
                const err = new Error('promptSession aborted by client');
                err.code = 'ABORTED';
                throw err;
            }
            opts.signal.addEventListener('abort', onCallerAbort, { once: true });
        }
        try {
            const { data } = await this.serverRequest(`/session/${encodeURIComponent(opencodeSessionId)}/message`, {
                method: 'POST',
                body: { parts: [{ type: 'text', text: String(text) }] },
                signal: ctrl.signal,
                timeoutMs: timeoutMs + 5000
            });
            return extractServerMessage(data);
        } catch (e) {
            if (e && e.name === 'AbortError' && !(opts.signal && opts.signal.aborted)) {
                const err = new Error(`OpenCode prompt timed out after ${timeoutMs}ms`);
                err.code = 'TIMEOUT';
                // Best-effort: stop the orphaned server-side turn.
                this.abortSession(opencodeSessionId).catch(() => {});
                throw err;
            }
            throw e;
        } finally {
            clearTimeout(timer);
            if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
        }
    }

    // CLI streaming: onEvent receives raw `--format json` events.
    // Server transport has session-scoped streaming instead: use
    // createSession() + subscribeSessionEvents(). Throws NOT_IMPLEMENTED
    // explicitly rather than faking CLI-style prompt streaming.
    async subscribeEvents(prompt, opts = {}) {
        const t = await this.resolveTransport();
        if (t === 'cli') {
            return opencodeService.runStream(prompt, { ...opts, cwd: opts.cwd || this.workspaceDir });
        }
        throw notImplemented('subscribeEvents (server transport uses subscribeSessionEvents)');
    }

    // Server SSE subscription for one OpenCode session. onRawEvent receives
    // raw /event objects filtered to opencodeSessionId. Resolves with
    // { ended: 'idle' } on session.idle; rejects ABORTED/TIMEOUT/errors.
    // CLI transport: not applicable (single-resolve runStream instead).
    async subscribeSessionEvents(opencodeSessionId, opts = {}) {
        const t = await this.resolveTransport();
        if (t === 'cli') {
            throw notImplemented('subscribeSessionEvents (CLI transport uses subscribeEvents)');
        }
        return this.subscribeServerEvents(opencodeSessionId, opts);
    }

    subscribeServerEvents(opencodeSessionId, { signal = null, onRawEvent = null, timeoutMs = 0 } = {}) {
        if (!opencodeSessionId || typeof opencodeSessionId !== 'string') {
            return Promise.reject(upstreamError(ERR_BAD_REQUEST, 'subscribeEvents requires an OpenCode session id'));
        }
        const headers = { 'Accept': 'text/event-stream' };
        const auth = this.authHeader();
        if (auth) headers['Authorization'] = auth;
        let reader = null;
        let timer = null;
        let settled = false;
        let response = null;

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                if (timer) { clearTimeout(timer); timer = null; }
                if (signal) signal.removeEventListener('abort', onAbort);
                if (reader) reader.cancel().catch(() => {});
            };
            const finishResolve = (v) => { if (settled) return; settled = true; cleanup(); resolve(v); };
            const finishReject = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
            const onAbort = () => {
                try { require('../utils/workerDebugLog').log('agentClient', 'subscribe-abort', { opencodeSessionId }); } catch {}
                console.warn(`[agentClient] subscribeServerEvents abort opencodeSessionId=${opencodeSessionId}`);
                const err = new Error('OpenCode event stream aborted by client');
                err.code = 'ABORTED';
                finishReject(err);
            };
            if (signal) {
                if (signal.aborted) return onAbort();
                signal.addEventListener('abort', onAbort, { once: true });
            }
            if (timeoutMs && timeoutMs > 0) {
                timer = setTimeout(() => {
                    const err = new Error(`OpenCode event stream timed out after ${timeoutMs}ms`);
                    err.code = 'TIMEOUT';
                    finishReject(err);
                }, timeoutMs);
                if (timer.unref) timer.unref();
            }
            const decoder = new TextDecoder();
            let buf = '';
            const pump = async () => {
                try {
                    response = await fetch(this.serverUrl + '/event', { headers, signal: signal || undefined });
                    if (!response.ok) {
                        if (response.status === 401) throw upstreamError(ERR_AUTH, 'OpenCode Server rejected credentials (401)');
                        throw upstreamError(ERR_UPSTREAM, `OpenCode event stream status ${response.status}`);
                    }
                    reader = response.body.getReader();
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buf += decoder.decode(value, { stream: true });
                        const frames = buf.split('\n\n');
                        buf = frames.pop();
                        for (const frame of frames) {
                            const m = frame.match(/^data:\s*([\s\S]+)$/m);
                            if (!m) continue;
                            let obj;
                            try { obj = JSON.parse(m[1]); } catch { continue; }
                            if (!obj || typeof obj.type !== 'string') continue;
                            const props = obj.properties || {};
                            if (props.sessionID && props.sessionID !== opencodeSessionId) continue;
                            if (typeof onRawEvent === 'function') {
                                try { onRawEvent(obj); } catch {}
                            }
                            if (obj.type === 'session.idle' && props.sessionID === opencodeSessionId) {
                                finishResolve({ ended: 'idle', sessionId: opencodeSessionId });
                                return;
                            }
                        }
                    }
                    finishResolve({ ended: 'closed', sessionId: opencodeSessionId });
                } catch (e) {
                    try { require('../utils/workerDebugLog').log('agentClient', 'subscribe-error', { opencodeSessionId, code: e && e.code || null, name: e && e.name || null, msg: (e && e.message || '').slice(0,200) }); } catch {}
                    console.warn(`[agentClient] subscribeServerEvents error opencodeSessionId=${opencodeSessionId} code=${e && e.code} name=${e && e.name} msg=${(e && e.message || '').slice(0,120)}`);
                    if (e && (e.code === 'ABORTED' || e.code === 'TIMEOUT' || e.code === ERR_AUTH || e.code === ERR_UPSTREAM)) {
                        finishReject(e);
                        return;
                    }
                    if (e && e.name === 'AbortError') {
                        if (signal && signal.aborted) return onAbort();
                        finishReject(upstreamError(ERR_UNREACHABLE, `OpenCode Server unreachable at ${this.serverUrl}`));
                        return;
                    }
                    finishReject(upstreamError(ERR_UNREACHABLE, `OpenCode Server unreachable at ${this.serverUrl}`));
                }
            };
            pump();
        });
    }

    // Aborts an in-flight subscribeEvents() via the caller's AbortController
    // (CLI), or aborts a server-side session by id (server transport).
    async abortSession(target) {
        if (target && typeof target.abort === 'function') {
            target.abort();
            return { ok: true };
        }
        if (typeof target === 'string' && target) {
            const t = await this.resolveTransport();
            if (t === 'cli') {
                return { ok: false, reason: 'CLI transport needs an AbortController, not a session id' };
            }
            try {
                await this.serverRequest(`/session/${encodeURIComponent(target)}/abort`, { method: 'POST', timeoutMs: 10000 });
                return { ok: true };
            } catch (e) {
                if (e && e.code === ERR_NOT_FOUND) return { ok: true, alreadyGone: true };
                throw e;
            }
        }
        return { ok: false, reason: 'no abort controller or session id for this session' };
    }
}

// Extract clean { result, mcpTools } from a server message response.
// Never throws on unknown shapes: returns empty result instead.
function extractServerMessage(data) {
    let result = '';
    const tools = new Set();
    const parts = data && Array.isArray(data.parts) ? data.parts : [];
    for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' && typeof p.text === 'string') {
            result += (result ? '' : '') + p.text;
        } else if ((p.type === 'tool' || p.type === 'tool_use') && p.tool) {
            tools.add(String(p.tool).toLowerCase());
        }
    }
    return { result, mcpTools: Array.from(tools), raw: data };
}

module.exports = { OpenCodeClient, NOT_IMPLEMENTED };
