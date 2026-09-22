// P0.7-7: RemoteWorkerClient — Today AI API -> Agent Worker over HTTP.
//
// Worker API contract (implemented by src/routes/workers.js, served by
// src/workerServer.js on the worker host):
//   POST   /workers                 { workspaceId? } -> worker public view
//   GET    /workers/:id             -> worker public view
//   POST   /workers/:id/execute     { prompt, sessionId? } -> { result, mcpTools }
//   POST   /workers/:id/abort       -> { ok }
//   DELETE /workers/:id             -> { ok }
//
// Auth: shared secret in `X-Worker-Auth` header (NOT Bearer — this stack
// has no bearer convention; Basic is reserved for OpenCode Server).
// Compared server-side with constant-time comparison. The secret never
// appears in responses, logs, or error messages.
const DEFAULT_TIMEOUT_MS = parseInt(process.env.WORKER_REQUEST_TIMEOUT_MS, 10) || 15000;

function workerError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

class RemoteWorkerClient {
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl || process.env.WORKER_URL || '').replace(/\/+$/, '');
        this.secret = opts.secret || process.env.WORKER_SHARED_SECRET || '';
        this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
        if (!this.baseUrl) throw workerError('WORKER_BAD_ARG', 'RemoteWorkerClient requires baseUrl (WORKER_URL)');
        if (!this.secret) throw workerError('WORKER_BAD_ARG', 'RemoteWorkerClient requires secret (WORKER_SHARED_SECRET)');
    }

    headers(extra = {}) {
        return { 'Content-Type': 'application/json', 'X-Worker-Auth': this.secret, ...extra };
    }

    async request(path, { method = 'GET', body = null, signal = null, timeoutMs = null } = {}) {
        const ctrl = new AbortController();
        let timedOut = false;
        const limit = timeoutMs || this.timeoutMs;
        const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, limit);
        if (timer.unref) timer.unref();
        const onCallerAbort = () => ctrl.abort();
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                throw workerError('ABORTED', 'worker request aborted by client');
            }
            signal.addEventListener('abort', onCallerAbort, { once: true });
        }
        try {
            const res = await fetch(this.baseUrl + path, {
                method,
                headers: this.headers(),
                body: body === null ? undefined : JSON.stringify(body),
                signal: ctrl.signal
            });
            const text = await res.text().catch(() => '');
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = null; }
            if (res.status === 401 || res.status === 403) {
                throw workerError('WORKER_AUTH', 'Worker rejected credentials');
            }
            if (res.status === 404) throw workerError('WORKER_NOT_FOUND', 'Unknown worker');
            if (res.status === 409) {
                throw workerError('WORKER_BUSY', (data && data.error) || 'Worker busy');
            }
            if (res.status === 429) throw workerError('WORKER_RATE_LIMITED', 'Worker rate limited');
            if (res.status >= 500) {
                const msg = (data && data.error) || `Worker error (${res.status})`;
                throw workerError('WORKER_ERROR', String(msg).slice(0, 300));
            }
            if (res.status >= 300 || !data) {
                throw workerError('WORKER_ERROR', `Worker unexpected status (${res.status})`);
            }
            return data;
        } catch (e) {
            if (e && (e.code === 'ABORTED' || e.code === 'WORKER_AUTH' || e.code === 'WORKER_NOT_FOUND' ||
                e.code === 'WORKER_BUSY' || e.code === 'WORKER_RATE_LIMITED' || e.code === 'WORKER_ERROR')) {
                throw e;
            }
            if (timedOut || (e && e.name === 'AbortError')) {
                if (signal && signal.aborted) throw workerError('ABORTED', 'worker request aborted by client');
                throw workerError('TIMEOUT', `Worker request timed out after ${limit}ms`);
            }
            throw workerError('WORKER_UNREACHABLE', 'Agent Worker unreachable');
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onCallerAbort);
        }
    }

    // RemoteWorkerProvider shape (mirrors workerProvider.js interface).
    async create(opts = {}) {
        return this.request('/workers', { method: 'POST', body: { workspaceId: opts.workspaceId || undefined }, timeoutMs: opts.timeoutMs });
    }

    async get(workerId) {
        return this.request(`/workers/${encodeURIComponent(workerId)}`, { timeoutMs: 10000 });
    }

    async execute(workerId, { prompt, sessionId = null, signal = null, timeoutMs = 600000 } = {}) {
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            throw workerError('WORKER_BAD_ARG', 'execute requires a non-empty prompt');
        }
        return this.request(`/workers/${encodeURIComponent(workerId)}/execute`, {
            method: 'POST',
            body: { prompt: prompt.slice(0, 8000), sessionId },
            signal,
            timeoutMs
        });
    }

    async abort(workerId) {
        return this.request(`/workers/${encodeURIComponent(workerId)}/abort`, { method: 'POST', timeoutMs: 10000 });
    }

    async destroy(workerId) {
        return this.request(`/workers/${encodeURIComponent(workerId)}`, { method: 'DELETE', timeoutMs: 15000 });
    }

    // Streaming execution over `POST /workers/:id/execute/stream` (SSE).
    // onEvent receives { kind: 'upstream', data } per raw OpenCode event;
    // resolves { result, mcpTools } on `done`; rejects mapped errors on
    // `error`, client abort (ABORTED), timeout (TIMEOUT), or a stream that
    // ends without a terminal event (WORKER_ERROR). Malformed frames are
    // skipped, never fatal.
    async executeStream(workerId, { prompt, sessionId = null, signal = null, timeoutMs = 600000, onEvent = null } = {}) {
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            throw workerError('WORKER_BAD_ARG', 'executeStream requires a non-empty prompt');
        }
        if (!workerId || typeof workerId !== 'string') {
            throw workerError('WORKER_BAD_ARG', 'executeStream requires a worker id');
        }
        const ctrl = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
        if (timer.unref) timer.unref();
        const onCallerAbort = () => { try { require('../utils/workerDebugLog').log('remoteWorker', 'caller-abort', { workerId }); } catch {}; console.warn(`[remoteWorker] caller signal abort -> ctrl abort workerId=${workerId}`); ctrl.abort(); };
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                console.warn(`[remoteWorker] signal already aborted at entry workerId=${workerId}`);
                throw workerError('ABORTED', 'worker stream aborted by client');
            }
            signal.addEventListener('abort', onCallerAbort, { once: true });
        }
        try { require('../utils/workerDebugLog').log('remoteWorker', 'fetch-start', { workerId, path: `/workers/${workerId}/execute/stream` }); } catch {}
        console.warn(`[remoteWorker] fetch POST ${this.baseUrl}/workers/${workerId}/execute/stream`);
        try {
            const res = await fetch(`${this.baseUrl}/workers/${encodeURIComponent(workerId)}/execute/stream`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ prompt: prompt.slice(0, 8000), sessionId }),
                signal: ctrl.signal
            });
            if (res.status === 401 || res.status === 403) {
                throw workerError('WORKER_AUTH', 'Worker rejected credentials');
            }
            if (res.status === 404) throw workerError('WORKER_NOT_FOUND', 'Unknown worker');
            if (res.status === 409) throw workerError('WORKER_BUSY', 'Worker busy');
            if (res.status === 429) throw workerError('WORKER_RATE_LIMITED', 'Worker rate limited');
            if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
                const text = await res.text().catch(() => '');
                let msg = `Worker unexpected status (${res.status})`;
                try {
                    const data = text ? JSON.parse(text) : null;
                    if (data && data.error) msg = String(data.error).slice(0, 300);
                } catch {}
                throw workerError('WORKER_ERROR', msg);
            }
            if (!res.body || typeof res.body.getReader !== 'function') {
                throw workerError('WORKER_ERROR', 'Worker stream has no readable body');
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const frames = buf.split('\n\n');
                buf = frames.pop();
                for (const frame of frames) {
                    const outcome = this._handleStreamFrame(frame, onEvent);
                    if (outcome) return outcome;
                }
            }
            buf += decoder.decode();
            for (const frame of buf.split('\n\n')) {
                const outcome = this._handleStreamFrame(frame, onEvent);
                if (outcome) return outcome;
            }
            throw workerError('WORKER_ERROR', 'Worker stream ended without terminal event');
        } catch (e) {
            try { require('../utils/workerDebugLog').log('remoteWorker', 'executeStream-catch', { workerId, code: e && e.code || null, name: e && e.name || null, timedOut, signalAborted: !!(signal && signal.aborted), msg: (e && e.message || '').slice(0,200) }); } catch {}
            console.warn(`[remoteWorker] executeStream catch code=${e && e.code} name=${e && e.name} timedOut=${timedOut} signalAborted=${signal && signal.aborted} msg=${(e && e.message || '').slice(0,120)}`);
            if (e && (e.code === 'ABORTED' || e.code === 'WORKER_AUTH' || e.code === 'WORKER_NOT_FOUND' ||
                e.code === 'WORKER_BUSY' || e.code === 'WORKER_RATE_LIMITED' || e.code === 'WORKER_ERROR' ||
                e.code === 'TIMEOUT')) {
                throw e;
            }
            if (timedOut || (e && e.name === 'AbortError')) {
                if (signal && signal.aborted) throw workerError('ABORTED', 'worker stream aborted by client');
                throw workerError('TIMEOUT', `Worker stream timed out after ${timeoutMs}ms`);
            }
            throw workerError('WORKER_UNREACHABLE', 'Agent Worker unreachable');
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onCallerAbort);
        }
    }

    // Returns { result, mcpTools } on done, { error } terminal object on
    // error event, or null to continue. Never throws on malformed frames.
    _handleStreamFrame(frame, onEvent) {
        let ev = null;
        let dataRaw = '';
        for (const line of String(frame).split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
        }
        if (!ev || !dataRaw) return null;
        let data;
        try {
            data = JSON.parse(dataRaw);
        } catch {
            return null;
        }
        if (ev === 'upstream') {
            if (typeof onEvent === 'function') {
                try { onEvent({ kind: 'upstream', data }); } catch {}
            }
            return null;
        }
        if (ev === 'done') {
            return {
                result: (data && typeof data.result === 'string') ? data.result : '',
                mcpTools: (data && Array.isArray(data.mcpTools)) ? data.mcpTools : []
            };
        }
        if (ev === 'error') {
            const message = (data && typeof data.message === 'string' && data.message) || 'Worker execution failed';
            const status = data && data.status;
            if (/abort/i.test(message)) throw workerError('ABORTED', 'worker stream aborted');
            if (status === 504) throw workerError('TIMEOUT', message.slice(0, 300));
            if (status === 503) throw workerError('WORKER_UNREACHABLE', message.slice(0, 300));
            throw workerError('WORKER_ERROR', message.slice(0, 300));
        }
        return null;
    }
}

module.exports = { RemoteWorkerClient };
