// P0.7: provider + remote worker + worker-side API tests.
// All deterministic (fake processes / fixture HTTP). No real spawn, no
// real OpenCode. Real end-to-end lives in integration-cloud-worker (opt-in).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const aw = require('../src/services/agentWorker');
const { LocalProcessWorkerProvider } = require('../src/services/workerProvider');
const { RemoteWorkerClient } = require('../src/services/remoteWorker');

const savedEnv = {};
function setEnv(patch) {
    for (const k of Object.keys(patch)) {
        if (!(k in savedEnv)) savedEnv[k] = process.env[k];
        if (patch[k] === undefined) delete process.env[k];
        else process.env[k] = patch[k];
    }
}
function restoreEnv() {
    for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
        delete savedEnv[k];
    }
}

afterEach(() => {
    aw._clearForTests();
    restoreEnv();
});

describe('P0.7 provider interface (local)', () => {
    it('create/execute/abort/destroy lifecycle', async () => {
        setEnv({ MOCK_OPENCODE: 'true', NODE_ENV: undefined });
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async () => ({ available: true, transport: 'server', mode: 'test', status: 200 });
        const { EventEmitter } = require('events');
        const fakeSpawn = () => {
            const p = new EventEmitter();
            p.exitCode = null;
            p.killed = false;
            p.stdout = new EventEmitter();
            p.stderr = new EventEmitter();
            p.kill = () => { p.killed = true; setTimeout(() => { p.exitCode = 0; p.emit('exit', 0); }, 5); return true; };
            return p;
        };
        const provider = new LocalProcessWorkerProvider({ spawnFn: fakeSpawn });
        try {
            const w = await provider.create({ workspaceId: `prov-${Date.now()}` });
            assert.equal(w.status, 'ready');
            const out = await provider.execute(w.workerId, async (client) => {
                assert.ok(client);
                return 'exec-ok';
            });
            assert.equal(out, 'exec-ok');
            assert.equal((await provider.abort(w.workerId)).ok, false);
            const destroyed = await provider.destroy(w.workerId);
            assert.equal(destroyed.ok, true);
            assert.equal(aw.getWorker(w.workerId), null);
        } finally {
            OpenCodeClient.prototype.health = origHealth;
        }
    });

    it('concurrent execute on same worker -> 409, abort wakes waiter', async () => {
        setEnv({ MOCK_OPENCODE: 'true', NODE_ENV: undefined });
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async () => ({ available: true, transport: 'server', mode: 'test', status: 200 });
        const { EventEmitter } = require('events');
        const fakeSpawn = () => {
            const p = new EventEmitter();
            p.exitCode = null;
            p.stdout = new EventEmitter();
            p.stderr = new EventEmitter();
            p.kill = () => { setTimeout(() => { p.exitCode = 0; p.emit('exit', 0); }, 5); return true; };
            return p;
        };
        const provider = new LocalProcessWorkerProvider({ spawnFn: fakeSpawn });
        try {
            const w = await provider.create({ workspaceId: `prov-busy-${Date.now()}` });
            let releaseGate;
            const gate = new Promise((r) => { releaseGate = r; });
            const first = provider.execute(w.workerId, async () => { await gate; return 'first'; });
            const second = provider.execute(w.workerId, async () => 'second').then(() => null, (e) => e);
            const err = await second;
            assert.ok(err, 'second execute must be rejected');
            assert.equal(err.code, 'WORKER_BUSY');
            assert.equal(err.status, 409);
            releaseGate();
            assert.equal(await first, 'first');
            const aborted = await provider.abort(w.workerId);
            assert.equal(aborted.ok, false);
            await provider.destroy(w.workerId);
        } finally {
            OpenCodeClient.prototype.health = origHealth;
        }
    });

    it('destroy unknown worker succeeds silently', async () => {
        const provider = new LocalProcessWorkerProvider({});
        const r = await provider.destroy('wrk_nope0000000000');
        assert.equal(r.ok, true);
    });
});

describe('P0.7 remote client contract', () => {
    async function fixture(handler) {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let parsed = null;
                try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
                handler(req, res, parsed);
            });
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        return server;
    }
    async function shut(server) {
        if (server.closeAllConnections) server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
    function json(res, code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    }

    it('full flow: create/execute/abort/destroy with auth header', async () => {
        const seenAuth = [];
        const server = await fixture((req, res, body) => {
            seenAuth.push(req.headers['x-worker-auth'] || null);
            if (req.method === 'POST' && req.url === '/workers') return json(res, 201, { workerId: 'wrk_fixture0001', status: 'ready' });
            if (req.method === 'POST' && req.url === '/workers/wrk_fixture0001/execute') {
                assert.equal(body.prompt, 'hi fixture');
                return json(res, 200, { result: 'fixture-ok', mcpTools: [] });
            }
            if (req.method === 'POST' && req.url === '/workers/wrk_fixture0001/abort') return json(res, 200, { ok: true });
            if (req.method === 'DELETE' && req.url === '/workers/wrk_fixture0001') return json(res, 200, { ok: true });
            return json(res, 404, { error: 'Unknown worker' });
        });
        try {
            const url = `http://127.0.0.1:${server.address().port}`;
            const c = new RemoteWorkerClient({ baseUrl: url, secret: 's3cr3t' });
            const w = await c.create({});
            assert.equal(w.workerId, 'wrk_fixture0001');
            const out = await c.execute(w.workerId, { prompt: 'hi fixture' });
            assert.equal(out.result, 'fixture-ok');
            assert.deepEqual(await c.abort(w.workerId), { ok: true });
            assert.deepEqual(await c.destroy(w.workerId), { ok: true });
            assert.ok(seenAuth.every((a) => a === 's3cr3t'), 'every request carries the secret, nothing else');
            assert.ok(!JSON.stringify(seenAuth).includes('wrong'));
        } finally {
            await shut(server);
        }
    });

    it('maps 401/404/409/timeout/unreachable distinctly, secret never leaks', async () => {
        const server = await fixture((req, res) => {
            if (req.url === '/t401') return json(res, 401, { error: 'nope' });
            if (req.url === '/t404') return json(res, 404, { error: 'Unknown worker' });
            if (req.url === '/t409') return json(res, 409, { error: 'busy' });
            if (req.url === '/tslow') return; // hang -> client timeout
            return json(res, 500, { error: 'boom' });
        });
        try {
            const url = `http://127.0.0.1:${server.address().port}`;
            const c = new RemoteWorkerClient({ baseUrl: url, secret: 's3cr3t', timeoutMs: 800 });
            const e401 = await c.request('/t401').then(() => null, (e) => e);
            assert.equal(e401.code, 'WORKER_AUTH');
            const e404 = await c.request('/t404').then(() => null, (e) => e);
            assert.equal(e404.code, 'WORKER_NOT_FOUND');
            const e409 = await c.request('/t409').then(() => null, (e) => e);
            assert.equal(e409.code, 'WORKER_BUSY');
            const e500 = await c.request('/nope').then(() => null, (e) => e);
            assert.equal(e500.code, 'WORKER_ERROR');
            const eTimeout = await c.request('/tslow').then(() => null, (e) => e);
            assert.equal(eTimeout.code, 'TIMEOUT');
            const eGone = await new RemoteWorkerClient({ baseUrl: 'http://127.0.0.1:9', secret: 's3cr3t', timeoutMs: 800 })
                .request('/x').then(() => null, (e) => e);
            assert.equal(eGone.code, 'WORKER_UNREACHABLE');
            for (const e of [e401, e404, e409, e500, eTimeout, eGone]) {
                assert.ok(!String(e.message).includes('s3cr3t'), 'secret must never appear in errors');
            }
        } finally {
            await shut(server);
        }
    });

    it('rejects empty prompt and missing config loudly', async () => {
        const c = new RemoteWorkerClient({ baseUrl: 'http://127.0.0.1:9', secret: 's' });
        const e = await c.execute('wrk_x', { prompt: '   ' }).then(() => null, (er) => er);
        assert.equal(e.code, 'WORKER_BAD_ARG');
        assert.throws(() => new RemoteWorkerClient({ baseUrl: '', secret: 's' }), /baseUrl/);
        assert.throws(() => new RemoteWorkerClient({ baseUrl: 'http://x', secret: '' }), /secret/);
    });
});

describe('P0.7 worker-side API routes', () => {
    const express = require('express');
    let app;
    const SECRET = 'test-worker-secret';

    beforeEach(() => {
        setEnv({ WORKER_SHARED_SECRET: SECRET, MOCK_OPENCODE: 'true', NODE_ENV: undefined });
        delete require.cache[require.resolve('../src/routes/workers.js')];
        app = express();
        app.use(express.json());
        app.use('/', require('../src/routes/workers.js'));
    });

    afterEach(() => {
        aw._clearForTests();
        restoreEnv();
    });

    function start() {
        return new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
    }
    async function stop(s) {
        if (s.closeAllConnections) s.closeAllConnections();
        await new Promise((r) => s.close(r));
    }
    function stubAgentWorker() {
        const orig = {};
        for (const k of ['createWorker', 'startWorker', 'getWorker', 'cleanupWorker', 'workerClient', 'markRunning', 'markIdle']) {
            orig[k] = aw[k];
        }
        const store = new Map();
        aw.createWorker = async ({ workspaceId }) => {
            if ((aw.getWorkerLimits().maxWorkers || Infinity) <= store.size) {
                const e = new Error('worker limit reached (1)');
                e.code = 'WORKER_LIMIT';
                throw e;
            }
            const id = workspaceId ? `wrk_${workspaceId}` : `wrk_stub${store.size}`;
            const rec = { workerId: id, workspaceId: workspaceId || id, status: 'ready', createdAt: 1, startedAt: 1, stoppedAt: null, lastError: null, password: 'SHOULD-NEVER-SHOW', process: { pid: 99999 }, port: 1, serverUrl: 'http://x', username: 'worker' };
            store.set(id, rec);
            return { ...rec };
        };
        aw.startWorker = async () => ({});
        aw.getWorker = (id) => {
            const r = store.get(id);
            return r ? { ...r, password: undefined, process: undefined } : null;
        };
        aw.cleanupWorker = async (id) => { store.delete(id); return { ok: true, workerId: id }; };
        aw.markRunning = () => ({});
        aw.markIdle = () => ({});
        aw.workerClient = () => ({
            createSession: async () => ({ id: 'ses_stub' }),
            promptSession: async () => ({ result: 'stub-result', mcpTools: ['stub_tool'] })
        });
        return { orig, store };
    }
    function restoreAgentWorker(orig) {
        for (const k of Object.keys(orig)) aw[k] = orig[k];
    }

    it('401 without secret, 401 with wrong secret (constant-time)', async () => {
        const { orig } = stubAgentWorker();
        const s = await start();
        try {
            const base = `http://127.0.0.1:${s.address().port}`;
            let r = await fetch(`${base}/workers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.equal(r.status, 401);
            r = await fetch(`${base}/workers`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Worker-Auth': 'wrong' }, body: '{}' });
            assert.equal(r.status, 401);
        } finally {
            restoreAgentWorker(orig);
            await stop(s);
        }
    });

    it('POST /workers validates input and hides internals', async () => {
        const { orig } = stubAgentWorker();
        const s = await start();
        try {
            const base = `http://127.0.0.1:${s.address().port}`;
            const H = { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET };
            let r = await fetch(`${base}/workers`, { method: 'POST', headers: H, body: JSON.stringify({ workspaceId: '../evil' }) });
            assert.equal(r.status, 400);
            r = await fetch(`${base}/workers`, { method: 'POST', headers: H, body: JSON.stringify({ cwd: '/etc' }) });
            assert.equal(r.status, 400);
            r = await fetch(`${base}/workers`, { method: 'POST', headers: H, body: JSON.stringify({ workspaceId: 'ok-ws-1' }) });
            assert.equal(r.status, 201);
            const body = await r.json();
            assert.ok(body.workerId);
            assert.equal(body.status, 'ready');
            assert.ok(!('password' in body) && !('process' in body) && !('port' in body) && !('serverUrl' in body) && !('workspacePath' in body));
            r = await fetch(`${base}/workers/${body.workerId}`, { headers: { 'X-Worker-Auth': SECRET } });
            assert.equal(r.status, 200);
            r = await fetch(`${base}/workers/wrk_missing000`, { headers: { 'X-Worker-Auth': SECRET } });
            assert.equal(r.status, 404);
        } finally {
            restoreAgentWorker(orig);
            await stop(s);
        }
    });

    it('execute validates prompt, runs, maps upstream errors; busy -> 409', async () => {
        const { orig, store } = stubAgentWorker();
        const s = await start();
        try {
            const base = `http://127.0.0.1:${s.address().port}`;
            const H = { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET };
            let r = await fetch(`${base}/workers`, { method: 'POST', headers: H, body: JSON.stringify({ workspaceId: 'ok-exec-1' }) });
            const { workerId } = await r.json();
            r = await fetch(`${base}/workers/${workerId}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: '' }) });
            assert.equal(r.status, 400);
            r = await fetch(`${base}/workers/${workerId}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'do it', cwd: '/tmp' }) });
            assert.equal(r.status, 400);
            r = await fetch(`${base}/workers/${workerId}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'do it' }) });
            assert.equal(r.status, 200);
            const out = await r.json();
            assert.equal(out.result, 'stub-result');
            assert.deepEqual(out.mcpTools, ['stub_tool']);
            const routes = require('../src/routes/workers.js');
            routes._inflight.set(workerId, new AbortController());
            try {
                r = await fetch(`${base}/workers/${workerId}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'again' }) });
                assert.equal(r.status, 409);
            } finally {
                routes._inflight.delete(workerId);
            }
            void store;
        } finally {
            restoreAgentWorker(orig);
            await stop(s);
        }
    });

    it('abort/delete lifecycle + unknown ids', async () => {
        const { orig } = stubAgentWorker();
        const s = await start();
        try {
            const base = `http://127.0.0.1:${s.address().port}`;
            const H = { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET };
            let r = await fetch(`${base}/workers`, { method: 'POST', headers: H, body: JSON.stringify({ workspaceId: 'ok-ab-1' }) });
            const { workerId } = await r.json();
            r = await fetch(`${base}/workers/${workerId}/abort`, { method: 'POST', headers: H });
            assert.equal(r.status, 200);
            assert.equal((await r.json()).ok, false);
            r = await fetch(`${base}/workers/wrk_missing000/abort`, { method: 'POST', headers: H });
            assert.equal(r.status, 404);
            r = await fetch(`${base}/workers/${workerId}`, { method: 'DELETE', headers: H });
            assert.equal(r.status, 200);
            assert.equal((await r.json()).ok, true);
            r = await fetch(`${base}/workers/${workerId}`, { headers: { 'X-Worker-Auth': SECRET } });
            assert.equal(r.status, 404);
        } finally {
            restoreAgentWorker(orig);
            await stop(s);
        }
    });
});

describe('P0.8-4 remote worker config validation', () => {
    const { validateEnv } = require('../src/middleware/validateEnv');

    const baseProd = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        AUTH_USERNAME: 'admin',
        AUTH_PASSWORD: 'secret',
        WORKSPACE_ROOT: '/tmp/today-ai-test-workspaces',
        ALLOWED_ORIGINS: 'https://today.example.com',
        MOCK_OPENCODE: undefined,
        OPENCODE_SERVER_URL: undefined
    };

    async function exitsWith(overrides) {
        let exited = false;
        const origExit = process.exit;
        process.exit = () => { exited = true; throw new Error('exit(1)'); };
        const orig = {};
        const merged = { ...baseProd, ...overrides };
        try {
            for (const k of Object.keys(merged)) {
                orig[k] = process.env[k];
                if (merged[k] === undefined) delete process.env[k];
                else process.env[k] = merged[k];
            }
            validateEnv();
        } catch {}
        process.exit = origExit;
        for (const k of Object.keys(merged)) {
            if (orig[k] === undefined) delete process.env[k];
            else process.env[k] = orig[k];
        }
        return exited;
    }

    it('production fails on URL-without-secret', async () => {
        assert.ok(await exitsWith({ WORKER_URL: 'https://worker.example.com', WORKER_SHARED_SECRET: undefined }));
    });

    it('production fails on secret-without-URL', async () => {
        assert.ok(await exitsWith({ WORKER_URL: undefined, WORKER_SHARED_SECRET: 's3cr3t' }));
    });

    it('production passes with both set or both absent', async () => {
        assert.ok(!await exitsWith({ WORKER_URL: 'https://worker.example.com', WORKER_SHARED_SECRET: 's3cr3t' }));
        assert.ok(!await exitsWith({ WORKER_URL: undefined, WORKER_SHARED_SECRET: undefined }));
    });

    it('development keeps local fallback on half configuration', async () => {
        assert.ok(!await exitsWith({ NODE_ENV: 'development', WORKER_URL: 'https://worker.example.com', WORKER_SHARED_SECRET: undefined }));
    });
});

describe('P0.7 resource limits + symlink-safe resolve', () => {
    it('getWorkerLimits parses env, size limit marked unenforced', async () => {
        const prevMax = process.env.MAX_WORKERS;
        const prevSize = process.env.MAX_WORKSPACE_SIZE_MB;
        try {
            delete process.env.MAX_WORKERS;
            delete process.env.MAX_WORKSPACE_SIZE_MB;
            assert.deepEqual(aw.getWorkerLimits(), { maxWorkers: null, maxWorkspaceSizeMb: null, enforced: { maxWorkers: true, maxWorkspaceSizeMb: false } });
            process.env.MAX_WORKERS = '3';
            process.env.MAX_WORKSPACE_SIZE_MB = '512';
            assert.deepEqual(aw.getWorkerLimits(), { maxWorkers: 3, maxWorkspaceSizeMb: 512, enforced: { maxWorkers: true, maxWorkspaceSizeMb: false } });
            process.env.MAX_WORKERS = 'abc';
            assert.equal(aw.getWorkerLimits().maxWorkers, null);
        } finally {
            if (prevMax === undefined) delete process.env.MAX_WORKERS; else process.env.MAX_WORKERS = prevMax;
            if (prevSize === undefined) delete process.env.MAX_WORKSPACE_SIZE_MB; else process.env.MAX_WORKSPACE_SIZE_MB = prevSize;
        }
    });

    it('MAX_WORKERS enforced on create', async () => {
        const prev = process.env.MAX_WORKERS;
        const prevRoot = process.env.WORKSPACE_ROOT;
        const root = require('path').join(require('os').tmpdir(), `today-ai-maxw-${Date.now()}`);
        process.env.MAX_WORKERS = '1';
        process.env.WORKSPACE_ROOT = root;
        let first = null;
        try {
            first = await aw.createWorker({ workspaceId: 'maxw-1' });
            const err = await aw.createWorker({ workspaceId: 'maxw-2' }).then(() => null, (e) => e);
            assert.ok(err, 'second worker must be rejected');
            assert.equal(err.code, 'WORKER_LIMIT');
        } finally {
            if (first) await aw.cleanupWorker(first.workerId).catch(() => {});
            if (prev === undefined) delete process.env.MAX_WORKERS; else process.env.MAX_WORKERS = prev;
            if (prevRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = prevRoot;
            await require('fs').promises.rm(root, { recursive: true, force: true }).catch(() => {});
        }
    });

    it('resolveRealInWorkspace resolves files, rejects missing/escape', async () => {
        const ws = require('../src/services/workspace');
        const prevRoot = process.env.WORKSPACE_ROOT;
        const root = require('path').join(require('os').tmpdir(), `today-ai-real-${Date.now()}`);
        process.env.WORKSPACE_ROOT = root;
        try {
            await ws.createWorkspace('realws');
            require('fs').writeFileSync(require('path').join(root, 'realws', 'a.txt'), 'hi');
            const p = await ws.resolveRealInWorkspace('realws', 'a.txt');
            assert.ok(p.endsWith('a.txt'));
            await assert.rejects(ws.resolveRealInWorkspace('realws', 'missing.txt'), /does not exist/);
            await assert.rejects(ws.resolveRealInWorkspace('realws', '../../etc'), /escapes|does not exist/);
        } finally {
            if (prevRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = prevRoot;
            await require('fs').promises.rm(root, { recursive: true, force: true }).catch(() => {});
        }
    });
});

describe('P0.9 provider contract audit (WORKER_URL / WORKER_SHARED_SECRET)', () => {
    const { useRemoteWorker } = require('../src/services/workerProvider');

    it('matrix: both/neither/one-side', () => {
        const prevUrl = process.env.WORKER_URL;
        const prevSecret = process.env.WORKER_SHARED_SECRET;
        try {
            process.env.WORKER_URL = 'https://worker.example.com';
            process.env.WORKER_SHARED_SECRET = 's3cr3t';
            assert.equal(useRemoteWorker(), true, 'both configured -> remote');
            delete process.env.WORKER_URL;
            delete process.env.WORKER_SHARED_SECRET;
            assert.equal(useRemoteWorker(), false, 'neither configured -> local');
            process.env.WORKER_URL = 'https://worker.example.com';
            assert.equal(useRemoteWorker(), false, 'URL only -> local (prod startup must fail, see validateEnv)');
            delete process.env.WORKER_URL;
            process.env.WORKER_SHARED_SECRET = 's3cr3t';
            assert.equal(useRemoteWorker(), false, 'secret only -> local (prod startup must fail, see validateEnv)');
        } finally {
            if (prevUrl === undefined) delete process.env.WORKER_URL; else process.env.WORKER_URL = prevUrl;
            if (prevSecret === undefined) delete process.env.WORKER_SHARED_SECRET; else process.env.WORKER_SHARED_SECRET = prevSecret;
        }
    });

    it('production half-configuration fails startup (both directions)', async () => {
        const { validateEnv } = require('../src/middleware/validateEnv');
        const base = {
            NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://t:t@localhost/t',
            AUTH_USERNAME: 'u',
            AUTH_PASSWORD: 'p',
            WORKSPACE_ROOT: '/tmp/x',
            ALLOWED_ORIGINS: 'https://x.example.com',
            MOCK_OPENCODE: undefined,
            OPENCODE_SERVER_URL: undefined
        };
        async function exitsWith(overrides) {
            let exited = false;
            const oe = process.exit;
            process.exit = () => { exited = true; throw new Error('exit'); };
            const saved = {};
            const merged = { ...base, ...overrides };
            try {
                for (const k of Object.keys(merged)) {
                    saved[k] = process.env[k];
                    if (merged[k] === undefined) delete process.env[k];
                    else process.env[k] = merged[k];
                }
                validateEnv();
            } catch (err) {
                void err;
            }
            process.exit = oe;
            for (const k of Object.keys(saved)) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
            return exited;
        }
        assert.ok(await exitsWith({ WORKER_URL: 'https://w.example.com', WORKER_SHARED_SECRET: undefined }), 'URL only must fail');
        assert.ok(await exitsWith({ WORKER_URL: undefined, WORKER_SHARED_SECRET: 's' }), 'secret only must fail');
        assert.ok(!await exitsWith({ WORKER_URL: 'https://w.example.com', WORKER_SHARED_SECRET: 's' }), 'both must pass');
        assert.ok(!await exitsWith({ WORKER_URL: undefined, WORKER_SHARED_SECRET: undefined }), 'neither must pass');
    });
});

describe('P0.9 worker execute/stream endpoint', () => {
    const express = require('express');
    const SECRET = 'test-stream-secret';
    let app;

    function buildApp() {
        delete require.cache[require.resolve('../src/routes/workers.js')];
        const fresh = express();
        fresh.use(express.json());
        fresh.use('/', require('../src/routes/workers.js'));
        return fresh;
    }

    function start(target) {
        return new Promise((resolve) => {
            const s = target.listen(0, '127.0.0.1', () => resolve(s));
        });
    }

    async function stop(s) {
        if (s.closeAllConnections) s.closeAllConnections();
        await new Promise((r) => s.close(r));
    }

    function stubStreamingWorker() {
        const orig = {};
        const keys = ['createWorker', 'startWorker', 'getWorker', 'cleanupWorker', 'workerClient', 'markRunning', 'markIdle'];
        for (const k of keys) orig[k] = aw[k];
        const store = new Map();
        aw.createWorker = async ({ workspaceId }) => {
            const id = `wrk_${workspaceId || 'stream'}`;
            store.set(id, { workerId: id, workspaceId: workspaceId || id, status: 'ready' });
            return { workerId: id };
        };
        aw.startWorker = async () => ({});
        aw.getWorker = (id) => store.get(id) || null;
        aw.cleanupWorker = async (id) => { store.delete(id); return { ok: true, workerId: id }; };
        aw.markRunning = () => ({});
        aw.markIdle = () => ({});
        aw.workerClient = () => ({
            createSession: async () => ({ id: 'ses_stub' }),
            subscribeSessionEvents: async (sid, opts) => {
                const cb = opts && opts.onRawEvent;
                if (typeof cb === 'function') {
                    cb({ type: 'message.part.delta', properties: { sessionID: sid, messageID: 'm', partID: 'p1', field: 'text', delta: 'hello ' } });
                    cb({ type: 'message.part.delta', properties: { sessionID: sid, messageID: 'm', partID: 'p1', field: 'text', delta: 'world' } });
                    cb({ type: 'session.idle', properties: { sessionID: sid } });
                }
                if (opts && opts.signal && opts.signal.aborted) {
                    const e = new Error('aborted');
                    e.code = 'ABORTED';
                    throw e;
                }
                return { ended: 'idle' };
            },
            promptSession: async () => ({ result: 'hello world', mcpTools: ['bash'] })
        });
        return orig;
    }

    function restoreAgentWorker(orig) {
        for (const k of Object.keys(orig)) aw[k] = orig[k];
    }

    async function createWorker(base, body) {
        const H = { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET };
        const r = await fetch(`${base}/workers`, { method: 'POST', headers: H, body: JSON.stringify(body) });
        assert.equal(r.status, 201);
        return (await r.json()).workerId;
    }

    it('streams upstream frames then done (no secrets anywhere)', async () => {
        const prevSecret = process.env.WORKER_SHARED_SECRET;
        process.env.WORKER_SHARED_SECRET = SECRET;
        const orig = stubStreamingWorker();
        app = buildApp();
        const s = await start(app);
        try {
            const base = `http://127.0.0.1:${s.address().port}`;
            const id = await createWorker(base, { workspaceId: 'ok-stream-1' });
            const r = await fetch(`${base}/workers/${id}/execute/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET },
                body: JSON.stringify({ prompt: 'do it' })
            });
            assert.equal(r.status, 200);
            assert.ok((r.headers.get('content-type') || '').includes('text/event-stream'));
            const text = await r.text();
            assert.ok(text.includes('event: upstream'), 'must forward raw upstream frames');
            assert.ok(text.includes('hello '), 'upstream delta content must pass through');
            assert.ok(text.includes('event: done'), 'must terminate with done');
            assert.ok(text.includes('hello world'), 'done must carry authoritative result');
            assert.ok(!text.includes('password') && !text.includes('99999'), 'no secrets/PID leak');
        } finally {
            restoreAgentWorker(orig);
            await stop(s);
            if (prevSecret === undefined) delete process.env.WORKER_SHARED_SECRET;
            else process.env.WORKER_SHARED_SECRET = prevSecret;
            aw._clearForTests();
        }
    });

    it('rejects bad input, unknown worker, busy worker, missing auth', async () => {
        const prevSecret = process.env.WORKER_SHARED_SECRET;
        process.env.WORKER_SHARED_SECRET = SECRET;
        const orig = stubStreamingWorker();
        app = buildApp();
        const s = await start(app);
        try {
            const base = `http://127.0.0.1:${s.address().port}`;
            const H = { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET };
            let r = await fetch(`${base}/workers/wrk_missing000/execute/stream`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'x' }) });
            assert.equal(r.status, 404);
            await r.text().catch(() => {});
            const id = await createWorker(base, { workspaceId: 'ok-stream-2' });
            const badBodies = [{ prompt: '' }, { prompt: 'x', cwd: '/tmp' }, { prompt: 'x', port: 1234 }, { prompt: 'x', command: 'rm' }];
            for (const b of badBodies) {
                r = await fetch(`${base}/workers/${id}/execute/stream`, { method: 'POST', headers: H, body: JSON.stringify(b) });
                assert.equal(r.status, 400, `must reject ${JSON.stringify(b)}`);
                await r.text().catch(() => {});
            }
            const routes = require('../src/routes/workers.js');
            routes._inflight.set(id, new AbortController());
            try {
                r = await fetch(`${base}/workers/${id}/execute/stream`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'x' }) });
                assert.equal(r.status, 409);
                await r.text().catch(() => {});
            } finally {
                routes._inflight.delete(id);
            }
            r = await fetch(`${base}/workers/${id}/execute/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
            assert.equal(r.status, 401);
            await r.text().catch(() => {});
        } finally {
            restoreAgentWorker(orig);
            await stop(s);
            if (prevSecret === undefined) delete process.env.WORKER_SHARED_SECRET;
            else process.env.WORKER_SHARED_SECRET = prevSecret;
            aw._clearForTests();
        }
    });

    it('worker error surfaces as error event, never raw stack', async () => {
        const prevSecret = process.env.WORKER_SHARED_SECRET;
        process.env.WORKER_SHARED_SECRET = SECRET;
        const orig = stubStreamingWorker();
        aw.workerClient = () => ({
            createSession: async () => ({ id: 'ses_err' }),
            subscribeSessionEvents: async () => {
                const e = new Error('upstream boom');
                e.code = 'UPSTREAM_ERROR';
                throw e;
            },
            promptSession: async () => ({ result: '', mcpTools: [] })
        });
        app = buildApp();
        const s = await start(app);
        try {
            const base = `http://127.0.0.1:${s.address().port}`;
            const id = await createWorker(base, { workspaceId: 'ok-stream-3' });
            const r = await fetch(`${base}/workers/${id}/execute/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET },
                body: JSON.stringify({ prompt: 'do it' })
            });
            assert.equal(r.status, 200);
            const text = await r.text();
            assert.ok(text.includes('event: error'), 'must send error event');
            assert.ok(!text.includes('event: done'), 'must not send done after error');
        } finally {
            restoreAgentWorker(orig);
            await stop(s);
            if (prevSecret === undefined) delete process.env.WORKER_SHARED_SECRET;
            else process.env.WORKER_SHARED_SECRET = prevSecret;
            aw._clearForTests();
        }
    });
});

describe('P0.9 RemoteWorkerClient.executeStream', () => {
    const http = require('http');

    function sseServer(handler) {
        return http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => handler(req, res, body));
        });
    }

    async function listen(server) {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        return `http://127.0.0.1:${server.address().port}`;
    }

    async function shut(server) {
        if (server.closeAllConnections) server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }

    function sseFrame(ev, data) {
        return `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    it('success: forwards upstream, resolves done, skips garbage', async () => {
        const seenAuth = [];
        const server = sseServer((req, res) => {
            seenAuth.push(req.headers['x-worker-auth']);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(sseFrame('upstream', { type: 'message.part.delta', properties: { field: 'text', delta: 'a' } }));
            res.write('garbage-no-event-prefix\n\n');
            res.write(sseFrame('upstream', { type: 'message.part.delta', properties: { field: 'text', delta: 'b' } }));
            res.write(sseFrame('done', { result: 'ab', mcpTools: ['x'] }));
            res.end();
        });
        const url = await listen(server);
        try {
            const c = new RemoteWorkerClient({ baseUrl: url, secret: 's3' });
            const got = [];
            const out = await c.executeStream('wrk_1', { prompt: 'hi', onEvent: (e) => got.push(e) });
            assert.deepEqual(out, { result: 'ab', mcpTools: ['x'] });
            assert.equal(got.length, 2, 'malformed frame skipped, two upstream delivered');
            assert.deepEqual(got[0], { kind: 'upstream', data: { type: 'message.part.delta', properties: { field: 'text', delta: 'a' } } });
            assert.ok(seenAuth.every((a) => a === 's3'));
        } finally {
            await shut(server);
        }
    });

    it('error event maps message/status; end without done fails', async () => {
        async function withServer(handler, fn) {
            const s2 = sseServer(handler);
            const u2 = await listen(s2);
            try {
                return await fn(new RemoteWorkerClient({ baseUrl: u2, secret: 's3' }));
            } finally {
                await shut(s2);
            }
        }
        const e500 = await withServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(sseFrame('error', { message: 'kaboom', status: 500 }));
            res.end();
        }, (c) => c.executeStream('w', { prompt: 'x' }).then(() => null, (e) => e));
        assert.equal(e500.code, 'WORKER_ERROR');
        const e504 = await withServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(sseFrame('error', { message: 'slow', status: 504 }));
            res.end();
        }, (c) => c.executeStream('w', { prompt: 'x' }).then(() => null, (e) => e));
        assert.equal(e504.code, 'TIMEOUT');
        const eEnd = await withServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end();
        }, (c) => c.executeStream('w', { prompt: 'x' }).then(() => null, (e) => e));
        assert.equal(eEnd.code, 'WORKER_ERROR');
        const eAuth = await withServer((req, res) => {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end('{}');
        }, (c) => c.executeStream('w', { prompt: 'x' }).then(() => null, (e) => e));
        assert.equal(eAuth.code, 'WORKER_AUTH');
        const eHtml = await withServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html></html>');
        }, (c) => c.executeStream('w', { prompt: 'x' }).then(() => null, (e) => e));
        assert.equal(eHtml.code, 'WORKER_ERROR');
    });

    it('timeout, abort, unreachable and bad args', async () => {
        const hanging = sseServer(() => {});
        const hangUrl = await listen(hanging);
        try {
            const c = new RemoteWorkerClient({ baseUrl: hangUrl, secret: 's3' });
            const eTimeout = await c.executeStream('w', { prompt: 'x', timeoutMs: 300 }).then(() => null, (e) => e);
            assert.equal(eTimeout.code, 'TIMEOUT');
            const controller = new AbortController();
            const p = c.executeStream('w', { prompt: 'x', signal: controller.signal, timeoutMs: 10000 }).then(() => null, (e) => e);
            controller.abort();
            assert.equal((await p).code, 'ABORTED');
            const eGone = await new RemoteWorkerClient({ baseUrl: 'http://127.0.0.1:9', secret: 's3', timeoutMs: 500 })
                .executeStream('w', { prompt: 'x' }).then(() => null, (e) => e);
            assert.equal(eGone.code, 'WORKER_UNREACHABLE');
            const eBad = await c.executeStream('w', { prompt: '' }).then(() => null, (e) => e);
            assert.equal(eBad.code, 'WORKER_BAD_ARG');
        } finally {
            await shut(hanging);
        }
    });
});

describe('P0.9 Today AI remote stream branch (fixture worker)', () => {
    const http = require('http');
    let app;
    let localBase = null;
    let localServer = null;
    let cookie = '';
    const savedEnv = {};
    const calls = { destroy: 0, abort: 0, create: 0 };
    let fixtureMode = 'ok';

    function fixture() {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const send = (code, obj) => {
                    res.writeHead(code, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(obj));
                };
                if (req.headers['x-worker-auth'] !== 'fixture-secret') return send(401, { error: 'Unauthorized' });
                if (req.method === 'POST' && req.url === '/workers') {
                    calls.create += 1;
                    return send(201, { workerId: 'wrk_fixture9', status: 'ready' });
                }
                if (req.method === 'DELETE' && req.url === '/workers/wrk_fixture9') {
                    calls.destroy += 1;
                    return send(200, { ok: true });
                }
                if (req.method === 'POST' && req.url === '/workers/wrk_fixture9/abort') {
                    calls.abort += 1;
                    return send(200, { ok: true });
                }
                if (req.method === 'POST' && req.url === '/workers/wrk_fixture9/execute/stream') {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    if (fixtureMode === 'ok') {
                        res.write('event: upstream\ndata: {"type":"message.part.delta","properties":{"sessionID":"s","messageID":"m","partID":"p","field":"text","delta":"hello "}}\n\n');
                        res.write('event: upstream\ndata: {"type":"message.part.delta","properties":{"sessionID":"s","messageID":"m","partID":"p","field":"text","delta":"remote"}}\n\n');
                        res.write('event: done\ndata: {"result":"hello remote","mcpTools":["github_x"]}\n\n');
                        return res.end();
                    }
                    if (fixtureMode === 'error') {
                        res.write('event: error\ndata: {"message":"worker blew up","status":500}\n\n');
                        return res.end();
                    }
                    return;
                }
                return send(404, { error: 'Unknown worker' });
            });
        });
        return server;
    }

    let fixtureServer = null;
    let fixtureBase = null;

    beforeEach(async () => {
        for (const k of ['AUTH_USERNAME', 'AUTH_PASSWORD', 'MOCK_OPENCODE', 'NODE_ENV', 'WORKER_URL', 'WORKER_SHARED_SECRET', 'WORKER_REQUEST_TIMEOUT_MS']) {
            savedEnv[k] = process.env[k];
        }
        fixtureServer = fixture();
        await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
        fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'admin123';
        process.env.MOCK_OPENCODE = 'true';
        delete process.env.NODE_ENV;
        process.env.WORKER_URL = fixtureBase;
        process.env.WORKER_SHARED_SECRET = 'fixture-secret';
        delete process.env.WORKER_REQUEST_TIMEOUT_MS;
        delete require.cache[require.resolve('../src/app')];
        app = require('../src/app');
        localServer = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        localBase = `http://127.0.0.1:${localServer.address().port}`;
        const res = await fetch(`${localBase}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        const m = (res.headers.get('set-cookie') || '').match(/todayai_session=([^;]+)/);
        cookie = m ? `todayai_session=${m[1]}` : '';
        assert.ok(cookie, 'login must succeed');
        calls.create = 0;
        calls.destroy = 0;
        calls.abort = 0;
        fixtureMode = 'ok';
    });

    afterEach(async () => {
        if (localServer) {
            if (localServer.closeAllConnections) localServer.closeAllConnections();
            await new Promise((r) => localServer.close(r));
            localServer = null;
        }
        if (fixtureServer) {
            if (fixtureServer.closeAllConnections) fixtureServer.closeAllConnections();
            await new Promise((r) => fixtureServer.close(r));
            fixtureServer = null;
        }
        delete require.cache[require.resolve('../src/app')];
        for (const k of Object.keys(savedEnv)) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
            delete savedEnv[k];
        }
    });

    async function postStream(sid, prompt) {
        const res = await fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ prompt, sessionId: sid })
        });
        return res;
    }

    async function waitForDestroy() {
        for (let i = 0; i < 50; i++) {
            if (calls.destroy === 1) return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return calls.destroy === 1;
    }

    function parseEvents(text) {
        const out = [];
        for (const chunk of String(text).split('\n\n')) {
            const ev = (chunk.match(/^event:\s*(.+)$/m) || [])[1];
            const dm = chunk.match(/^data:\s*(.+)$/m);
            if (ev && dm) out.push({ ev, data: JSON.parse(dm[1]) });
        }
        return out;
    }

    it('remote stream emits identical platform events + destroys worker', async () => {
        const sid = `rstream-${Date.now()}`;
        const res = await postStream(sid, 'hello remote branch');
        assert.equal(res.status, 200);
        assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
        const events = parseEvents(await res.text());
        const names = events.map((e) => e.ev);
        for (const need of ['session.started', 'text.delta', 'message.completed', 'done']) {
            assert.ok(names.includes(need), `missing ${need}, got ${names}`);
        }
        assert.ok(!names.includes('error'));
        const deltas = events.filter((e) => e.ev === 'text.delta').map((e) => e.data.content).join('');
        assert.equal(deltas, 'hello remote');
        const done = events.find((e) => e.ev === 'done');
        assert.equal(done.data.sessionId, sid);
        const flat = JSON.stringify(events);
        assert.ok(!flat.includes('wrk_fixture9'), 'workerId must not leak to browser');
        assert.ok(!flat.includes('127.0.0.1:'), 'worker URL must not leak to browser');
        assert.ok(!flat.includes('fixture-secret'), 'secret must not leak');
        assert.ok(!flat.includes('todayai_session'), 'no session token in events');
        assert.equal(calls.create, 1, 'exactly one remote worker created');
        // Destroy runs after the SSE response ends; poll briefly.
        let destroyed = false;
        for (let i = 0; i < 50 && !destroyed; i++) {
            destroyed = calls.destroy === 1;
            if (!destroyed) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(destroyed, 'remote worker destroyed afterwards');
        const hist = await (await fetch(`${localBase}/api/history?sessionId=${sid}&limit=10`, { headers: { Cookie: cookie } })).json();
        const aiRows = hist.filter((r) => r.role === 'ai');
        assert.equal(aiRows.length, 1, 'history written exactly once');
        assert.ok(aiRows[0].content.includes('hello remote'));
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });

    it('remote worker error maps to error event + failed + cleanup', async () => {
        fixtureMode = 'error';
        const sid = `rstream-err-${Date.now()}`;
        const res = await postStream(sid, 'boom please');
        assert.equal(res.status, 200);
        const events = parseEvents(await res.text());
        const errEv = events.find((e) => e.ev === 'error');
        assert.ok(errEv, 'must send error event');
        assert.ok(!events.some((e) => e.ev === 'done'), 'must not send done');
        assert.ok(await waitForDestroy(), 'worker destroyed even on failure');
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });

    it('remote timeout aborts + cleans up + timeout event', async () => {
        fixtureMode = 'hang';
        process.env.WORKER_REQUEST_TIMEOUT_MS = '800';
        const sid = `rstream-to-${Date.now()}`;
        const res = await postStream(sid, 'hang please');
        assert.equal(res.status, 200);
        const events = parseEvents(await res.text());
        const errEv = events.find((e) => e.ev === 'error');
        assert.ok(errEv, 'must send error event on timeout');
        assert.ok(/timeout|TIMEOUT|timed out/i.test(errEv.data.message), `timeout message expected, got ${errEv.data.message}`);
        assert.ok(await waitForDestroy(), 'worker destroyed after timeout');
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });

    it('client disconnect aborts remote execution and destroys worker', async () => {
        fixtureMode = 'hang';
        process.env.WORKER_REQUEST_TIMEOUT_MS = '30000';
        const sid = `rstream-ab-${Date.now()}`;
        const controller = new AbortController();
        const p = fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ prompt: 'abort me', sessionId: sid }),
            signal: controller.signal
        });
        await new Promise((r) => setTimeout(r, 400));
        controller.abort();
        await p.then(() => {}).catch(() => {});
        assert.ok(await waitForDestroy(), 'remote worker must be destroyed after disconnect');
        const health = await fetch(`${localBase}/api/health`);
        assert.equal(health.status, 200);
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });
});
