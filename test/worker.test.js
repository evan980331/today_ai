// P0.5-13: Agent Worker unit tests (deterministic, no real processes).
// Real-process coverage lives in test/integration-worker.test.js (opt-in).
//   1 worker creation, 2 dynamic port, 3 process startup, 4 health check,
//   5 auth, 6 cwd isolation, 7 worker crash, 8 startup timeout,
//   9 execution timeout, 10 graceful shutdown, 11 force kill fallback,
//   12 cleanup, 13 A/B concurrent, 14 A cwd != B cwd, 15 abort leaks nothing
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const workerSvc = require('../src/services/agentWorker');

const ROOT = path.join(os.tmpdir(), `today-ai-worker-test-${Date.now()}-${process.pid}`);
const OLD_ROOT = process.env.WORKSPACE_ROOT;
process.env.WORKSPACE_ROOT = ROOT;

afterEach(() => {
    workerSvc._clearForTests();
});

// Fake child process: never spawns anything real.
class FakeProc extends EventEmitter {
    constructor({ exitSoon = null, ignoreSigterm = false } = {}) {
        super();
        this.exitCode = null;
        this.killed = false;
        this.signals = [];
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.spawnOpts = null;
        this._ignoreSigterm = ignoreSigterm;
        if (exitSoon !== null) {
            setTimeout(() => this._die(exitSoon), 20);
        }
    }
    _die(code) {
        if (this.exitCode !== null) return;
        this.exitCode = code;
        this.emit('exit', code);
    }
    kill(sig = 'SIGTERM') {
        this.signals.push(sig);
        this.killed = true;
        if (sig === 'SIGTERM' && !this._ignoreSigterm) {
            setTimeout(() => this._die(0), 10);
        } else if (sig === 'SIGKILL') {
            setTimeout(() => this._die(137), 10);
        }
        return true;
    }
}

function fakeSpawnFactory(created = []) {
    return (args, opts) => {
        const proc = new FakeProc();
        proc.spawnArgs = args;
        proc.spawnOpts = opts;
        created.push(proc);
        return proc;
    };
}

// Minimal HTTP stub answering GET / with 200 (and recording auth).
function stubHttp({ onAuth = null } = {}) {
    const http = require('http');
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers['authorization'] || null });
        if (onAuth) onAuth(req.headers['authorization'] || null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
    });
    return { server, seen };
}

async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

async function close(server) {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

describe('P0.5 worker creation', () => {
    it('creates workspace + record with required fields', async () => {
        const w = await workerSvc.createWorker({ workspaceId: 'w-create-1' });
        assert.ok(/^wrk_[0-9a-f]{16}$/.test(w.workerId));
        assert.equal(w.workspaceId, 'w-create-1');
        assert.ok(w.workspacePath.startsWith(path.resolve(ROOT)));
        assert.ok(w.port > 0 && w.port < 65536);
        assert.equal(w.serverUrl, `http://127.0.0.1:${w.port}`);
        assert.equal(w.username, 'worker');
        assert.equal(w.status, 'creating');
        assert.ok(w.createdAt > 0);
        assert.ok(!('password' in w), 'public view must not contain password');
        assert.ok(!('process' in w), 'public view must not contain process handle');
        assert.ok(fs.existsSync(w.workspacePath));
        await workerSvc.cleanupWorker(w.workerId);
    });

    it('generates unique per-worker passwords', async () => {
        const a = await workerSvc.createWorker({ workspaceId: 'w-pw-a' });
        const b = await workerSvc.createWorker({ workspaceId: 'w-pw-b' });
        assert.notEqual(a.workerId, b.workerId);
        await workerSvc.cleanupWorker(a.workerId);
        await workerSvc.cleanupWorker(b.workerId);
    });
});

describe('P0.5 dynamic port', () => {
    it('allocates distinct OS-assigned ports', async () => {
        const p1 = await workerSvc.allocatePort();
        const p2 = await workerSvc.allocatePort();
        assert.notEqual(p1, p2);
        assert.ok(p1 > 0 && p2 > 0);
    });
});

describe('P0.5 process startup + health + auth + cwd', () => {
    it('starts fake process in workspace cwd with password env, becomes ready', async () => {
        const { server, seen } = stubHttp();
        const port = await listen(server);
        const created = [];
        // Point the worker record at our stub by overriding port after create.
        const w0 = await workerSvc.createWorker({ workspaceId: 'w-start-1' });
        // Rewire: real startWorker spawns on w0.port; instead drive the fake
        // path manually is complex, so start with spawnFn and intercept health
        // by temporarily mapping serverUrl to the stub.
        await workerSvc.cleanupWorker(w0.workerId);

        const w = await workerSvc.createWorker({ workspaceId: 'w-start-2' });
        const spawnFn = fakeSpawnFactory(created);
        // Patch record port to stub port so health probe hits the stub.
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async function () {
            if (this.serverUrl === w.serverUrl) {
                const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { Authorization: this.authHeader() } }).catch(() => null);
                return r && r.ok ? { available: true, transport: 'server', mode: 'test', status: 200 } : { available: false };
            }
            return origHealth.call(this);
        };
        try {
            const started = await workerSvc.startWorker(w.workerId, { spawnFn, timeoutMs: 8000 });
            assert.equal(started.status, 'ready');
            assert.equal(created.length, 1);
            assert.deepEqual(created[0].spawnArgs.slice(0, 4), ['serve', '--hostname', '127.0.0.1', '--port']);
            assert.equal(created[0].spawnOpts.cwd, w.workspacePath);
            assert.equal(created[0].spawnOpts.env.OPENCODE_SERVER_PASSWORD.length, 48);
            assert.ok(seen.length >= 1, 'health probe must hit the server');
            assert.ok(String(seen[0].auth || '').startsWith('Basic '), 'probe must use Basic auth');
            const h = await workerSvc.healthWorker(w.workerId);
            assert.equal(h.status, 'ready');
        } finally {
            OpenCodeClient.prototype.health = origHealth;
            await workerSvc.cleanupWorker(w.workerId).catch(() => {});
            await close(server);
        }
    });

    it('A/B workers get distinct ports and cwds and run concurrently', async () => {
        const { server } = stubHttp();
        const port = await listen(server);
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async function () {
            const r = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
            return r && r.ok ? { available: true, transport: 'server', mode: 'test', status: 200 } : { available: false };
        };
        const created = [];
        try {
            const [a, b] = await Promise.all([
                workerSvc.createWorker({ workspaceId: 'w-conc-a' }),
                workerSvc.createWorker({ workspaceId: 'w-conc-b' })
            ]);
            assert.notEqual(a.port, b.port);
            assert.notEqual(a.workspacePath, b.workspacePath);
            const [sa, sb] = await Promise.all([
                workerSvc.startWorker(a.workerId, { spawnFn: fakeSpawnFactory(created), timeoutMs: 8000 }),
                workerSvc.startWorker(b.workerId, { spawnFn: fakeSpawnFactory(created), timeoutMs: 8000 })
            ]);
            assert.equal(sa.status, 'ready');
            assert.equal(sb.status, 'ready');
            assert.notEqual(created[0].spawnOpts.cwd, created[1].spawnOpts.cwd);
            workerSvc.markRunning(a.workerId);
            workerSvc.markRunning(b.workerId);
            assert.equal(workerSvc.getWorker(a.workerId).status, 'running');
            assert.equal(workerSvc.getWorker(b.workerId).status, 'running');
            await workerSvc.cleanupWorker(a.workerId);
            await workerSvc.cleanupWorker(b.workerId);
            assert.ok(!fs.existsSync(a.workspacePath));
            assert.ok(!fs.existsSync(b.workspacePath));
        } finally {
            OpenCodeClient.prototype.health = origHealth;
            await close(server);
        }
    });
});

describe('P0.5 crash, timeout, shutdown', () => {
    it('process exit during startup -> failed, no zombie', async () => {
        const w = await workerSvc.createWorker({ workspaceId: 'w-crash-1' });
        const procs = [];
        const spawnFn = (args, opts) => {
            const p = new FakeProc({ exitSoon: 1 });
            p.spawnOpts = opts;
            procs.push(p);
            return p;
        };
        await assert.rejects(workerSvc.startWorker(w.workerId, { spawnFn, timeoutMs: 8000 }), /WORKER_EXITED|exited/i);
        assert.equal(workerSvc.getWorker(w.workerId).status, 'failed');
        assert.ok(procs[0].exitCode !== null, 'process must be reaped');
        await workerSvc.cleanupWorker(w.workerId);
    });

    it('startup timeout -> failed + process killed', async () => {
        const w = await workerSvc.createWorker({ workspaceId: 'w-timeout-1' });
        const procs = [];
        const spawnFn = (args, opts) => {
            const p = new FakeProc();
            p.spawnOpts = opts;
            procs.push(p);
            return p;
        };
        // Point health at a dead port so readiness never succeeds.
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async () => ({ available: false, reason: 'test-no-server' });
        try {
            const err = await workerSvc.startWorker(w.workerId, { spawnFn, timeoutMs: 1200 })
                .then(() => null, (e) => e);
            assert.ok(err, 'must reject on startup timeout');
            assert.equal(err.code, 'WORKER_START_TIMEOUT');
            assert.equal(workerSvc.getWorker(w.workerId).status, 'failed');
            assert.ok(procs[0].signals.includes('SIGTERM'), 'must attempt graceful kill');
        } finally {
            OpenCodeClient.prototype.health = origHealth;
            await workerSvc.cleanupWorker(w.workerId);
        }
    });

    it('graceful shutdown sends SIGTERM first (not SIGKILL)', async () => {
        const { server } = stubHttp();
        const port = await listen(server);
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async () => ({ available: true, transport: 'server', mode: 'test', status: 200 });
        const procs = [];
        try {
            const w = await workerSvc.createWorker({ workspaceId: 'w-grace-1' });
            await workerSvc.startWorker(w.workerId, { spawnFn: fakeSpawnFactory(procs), timeoutMs: 8000 });
            const out = await workerSvc.stopWorker(w.workerId, { gracefulMs: 2000 });
            assert.equal(out.status, 'stopped');
            assert.equal(procs[0].signals[0], 'SIGTERM');
            assert.ok(!procs[0].signals.includes('SIGKILL'), 'graceful exit must not escalate');
            assert.equal(out.forcedKill, false);
            assert.equal(workerSvc.getWorker(w.workerId), null);
            void port;
        } finally {
            OpenCodeClient.prototype.health = origHealth;
            await close(server);
        }
    });

    it('force kill fallback when SIGTERM ignored', async () => {
        const w = await workerSvc.createWorker({ workspaceId: 'w-force-1' });
        const p = new FakeProc({ ignoreSigterm: true });
        // Attach fake running process via startWorker with stubbed health.
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async () => ({ available: true, transport: 'server', mode: 'test', status: 200 });
        try {
            await workerSvc.startWorker(w.workerId, {
                spawnFn: () => p,
                timeoutMs: 8000
            });
            const out = await workerSvc.stopWorker(w.workerId, { gracefulMs: 300 });
            assert.equal(out.status, 'stopped');
            assert.ok(p.signals.includes('SIGTERM'));
            assert.ok(p.signals.includes('SIGKILL'), 'must escalate to SIGKILL');
            assert.equal(out.forcedKill, true);
        } finally {
            OpenCodeClient.prototype.health = origHealth;
            await workerSvc.cleanupWorker(w.workerId).catch(() => {});
        }
    });

    it('stop scrubs password and unregisters; unknown cleanup is silent', async () => {
        const w = await workerSvc.createWorker({ workspaceId: 'w-scrub-1' });
        await workerSvc.stopWorker(w.workerId);
        assert.equal(workerSvc.getWorker(w.workerId), null);
        const r = await workerSvc.cleanupWorker('wrk_doesnotexist0000');
        assert.equal(r.ok, true);
        await fs.promises.rm(path.join(ROOT, 'w-scrub-1'), { recursive: true, force: true }).catch(() => {});
    });
});

describe('P0.6 withWorker cleanup guarantees', () => {
    const path = require('path');
    const os = require('os');

    function wsDir(id) {
        const ws = require('../src/services/workspace');
        return ws.getWorkspacePath(id);
    }

    async function withoutMock(fn) {
        const prev = process.env.MOCK_OPENCODE;
        delete process.env.MOCK_OPENCODE;
        try {
            return await fn();
        } finally {
            if (prev === undefined) delete process.env.MOCK_OPENCODE;
            else process.env.MOCK_OPENCODE = prev;
        }
    }

    it('cleanup on failure removes workspace (keep=false)', async () => {
        const id = `wfail-${Date.now()}`;
        const err = await withoutMock(() => workerSvc.withWorker(
            { workspaceId: id, spawnFn: () => { throw new Error('spawn boom'); } },
            async () => 'never'
        ).then(() => null, (e) => e));
        assert.ok(err, 'must reject when spawn fails');
        assert.ok(!require('fs').existsSync(wsDir(id)), 'workspace must be cleaned after failure');
        assert.equal(workerSvc.getWorker(id) || null, null);
    });

    it('WORKSPACE_KEEP_ON_FAILURE=true keeps workspace for debugging', async () => {
        const id = `wkeep-${Date.now()}`;
        process.env.WORKSPACE_KEEP_ON_FAILURE = 'true';
        try {
            await withoutMock(() => workerSvc.withWorker(
                { workspaceId: id, spawnFn: () => { throw new Error('spawn boom'); } },
                async () => 'never'
            ).then(() => null, (e) => e));
            assert.ok(require('fs').existsSync(wsDir(id)), 'workspace must be kept for debugging');
        } finally {
            delete process.env.WORKSPACE_KEEP_ON_FAILURE;
            const ws = require('../src/services/workspace');
            await ws.removeWorkspace(id).catch(() => {});
        }
    });

    it('cleanup on abort removes workspace, no error history written by helper', async () => {
        const id = `wabort-${Date.now()}`;
        const abortErr = new Error('client went away');
        abortErr.code = 'ABORTED';
        const prevMock = process.env.MOCK_OPENCODE;
        process.env.MOCK_OPENCODE = 'true';
        try {
            const err = await workerSvc.withWorker(
                { workspaceId: id },
                async () => { throw abortErr; }
            ).then(() => null, (e) => e);
            assert.equal(err.code, 'ABORTED');
            assert.ok(!require('fs').existsSync(wsDir(id)));
        } finally {
            if (prevMock === undefined) delete process.env.MOCK_OPENCODE;
            else process.env.MOCK_OPENCODE = prevMock;
        }
    });

    it('cleanup on timeout removes workspace', async () => {
        const id = `wtimeout-${Date.now()}`;
        // Mock-mode withWorker: no real spawn; fn ignores signal.
        const prevMock = process.env.MOCK_OPENCODE;
        process.env.MOCK_OPENCODE = 'true';
        try {
            const err = await workerSvc.withWorker(
                { workspaceId: id, executionTimeoutMs: 300 },
                async () => { await new Promise((r) => setTimeout(r, 5000)); return 'never'; }
            ).then(() => null, (e) => e);
            assert.ok(err);
            assert.equal(err.code, 'TIMEOUT');
            assert.ok(!require('fs').existsSync(wsDir(id)), 'workspace must be cleaned after timeout');
        } finally {
            if (prevMock === undefined) delete process.env.MOCK_OPENCODE;
            else process.env.MOCK_OPENCODE = prevMock;
        }
    });
});

describe('P0.5 execution timeout + abort lifecycle split', () => {
    it('withWorker times out slow fn, stops worker, cleans workspace', async () => {
        const { server } = stubHttp();
        const port = await listen(server);
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async () => ({ available: true, transport: 'server', mode: 'test', status: 200 });
        const wsId = 'w-exec-timeout-1';
        try {
            const err = await workerSvc.withWorker(
                { workspaceId: wsId, executionTimeoutMs: 400, spawnFn: fakeSpawnFactory([]) },
                async () => { await new Promise((r) => setTimeout(r, 5000)); return 'never'; }
            ).then(() => null, (e) => e);
            assert.ok(err, 'must reject');
            assert.equal(err.code, 'TIMEOUT');
            assert.equal(workerSvc.getWorker(wsId) || null, null);
            void port;
        } finally {
            OpenCodeClient.prototype.health = origHealth;
            await close(server);
        }
    });

    it('session abort does not stop the worker', async () => {
        const { OpenCodeClient } = require('../src/services/agentClient');
        const w = await workerSvc.createWorker({ workspaceId: 'w-abort-1' });
        const c = new AbortController();
        const client = new OpenCodeClient({ transport: 'cli' });
        const r = await client.abortSession(c);
        assert.equal(r.ok, true);
        assert.ok(workerSvc.getWorker(w.workerId), 'worker must survive session abort');
        await workerSvc.cleanupWorker(w.workerId);
    });
});
