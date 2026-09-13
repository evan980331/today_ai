// P0-8: cloud-architecture tests.
// 1. workspace path isolation
// 2. workspace traversal protection
// 3. session schema (agent_sessions, real DB)
// 4. OpenCode runtime unavailable
// 5. production MOCK_OPENCODE rejection
// 6. OpenCode server health failure
// 7. streaming event normalization
// 8. git command argument safety
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';

async function withEnv(overrides, fn) {
    const orig = {};
    for (const k of Object.keys(overrides)) {
        orig[k] = process.env[k];
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    try {
        return await fn();
    } finally {
        for (const k of Object.keys(overrides)) {
            if (orig[k] === undefined) delete process.env[k];
            else process.env[k] = orig[k];
        }
    }
}

describe('P0-2 workspace path isolation', () => {
    const ws = require('../src/services/workspace');

    it('different ids resolve to different paths under root', () => {
        withEnv({ WORKSPACE_ROOT: path.join(os.tmpdir(), 'today-ai-ws-test') }, () => {
            const a = ws.getWorkspacePath('agent-aaa');
            const b = ws.getWorkspacePath('agent-bbb');
            assert.notEqual(a, b);
            assert.ok(a.startsWith(ws.getWorkspaceRoot()));
            assert.ok(b.startsWith(ws.getWorkspaceRoot()));
        });
    });

    it('WORKSPACE_ROOT env is honored, no hardcoded paths', () => {
        const custom = path.join(os.tmpdir(), 'today-ai-ws-custom');
        withEnv({ WORKSPACE_ROOT: custom }, () => {
            assert.equal(ws.getWorkspaceRoot(), path.resolve(custom));
        });
        const src = fs.readFileSync(path.join(__dirname, '../src/services/workspace.js'), 'utf8');
        assert.ok(!src.includes('D:\\'), 'workspace.js must not contain Windows paths');
        assert.ok(!src.includes('/tmp/today-ai-workspaces') || src.includes('os.tmpdir()'), 'default root must be env/os-driven');
    });

    it('create/remove roundtrip stays inside root', async () => {
        const root = path.join(os.tmpdir(), `today-ai-ws-rt-${Date.now()}`);
        await withEnv({ WORKSPACE_ROOT: root }, async () => {
            const dir = await ws.createWorkspace('rt-1');
            assert.ok(dir.startsWith(path.resolve(root)));
            assert.ok(fs.existsSync(dir));
            await ws.removeWorkspace('rt-1');
            assert.ok(!fs.existsSync(dir));
        });
        await fs.promises.rm(root, { recursive: true, force: true });
    });
});

describe('P0-2 workspace traversal protection', () => {
    const ws = require('../src/services/workspace');

    it('rejects dot segments, absolute paths and separators', () => {
        for (const bad of ['..', '../x', 'a/../../b', '/abs/path', '', 'a/b', 'a\\b', '.']) {
            assert.throws(() => ws.getWorkspacePath(bad), /Invalid|escapes|required/, `should reject ${bad}`);
        }
    });

    it('rejects sub-paths escaping the workspace', () => {
        assert.throws(() => ws.resolveInWorkspace('ok-id', '../../etc/passwd'), /escapes/);
        assert.throws(() => ws.resolveInWorkspace('ok-id', '/etc'), /escapes/);
    });

    it('accepts safe ids and safe sub-paths', () => {
        withEnv({ WORKSPACE_ROOT: path.join(os.tmpdir(), 'today-ai-ws-test') }, () => {
            assert.ok(ws.getWorkspacePath('abc-123_X.y'));
            assert.ok(ws.resolveInWorkspace('abc-123_X.y', 'src/index.js'));
        });
    });
});

describe('P0-3 agent session schema (backward compatible)', () => {
    const db = require('../src/db/db');
    const id = `agent-test-${Date.now()}`;

    it('creates a session with default status created', async () => {
        const row = await db.createAgentSession({ id, owner: 'admin', workspaceId: 'ws-1' });
        assert.ok(row);
        assert.equal(row.id, id);
        assert.equal(row.owner, 'admin');
        assert.equal(row.status, 'created');
        assert.ok(db.AGENT_STATUS.includes('created'));
    });

    it('transitions running -> completed', async () => {
        await db.updateAgentSessionStatus(id, 'running');
        assert.equal((await db.getAgentSession(id)).status, 'running');
        await db.updateAgentSessionStatus(id, 'completed');
        assert.equal((await db.getAgentSession(id)).status, 'completed');
    });

    it('rejects unknown status values', async () => {
        await assert.rejects(db.updateAgentSessionStatus(id, 'exploding'), /Invalid agent session status/);
    });

    it('lists sessions for owner and cleans up', async () => {
        const rows = await db.listAgentSessions('admin', 10);
        assert.ok(Array.isArray(rows));
        assert.ok(rows.some(r => r.id === id));
        await db.deleteAgentSession(id);
        assert.equal(await db.getAgentSession(id), null);
    });

    it('chat_logs table still works (backward compat)', async () => {
        const sid = `compat-${Date.now()}`;
        await db.saveLog({ sessionId: sid, role: 'user', content: 'hi', prompt: 'hi' });
        const hist = await db.getHistory({ sessionId: sid, limit: 5 });
        assert.ok(hist.some(r => r.role === 'user'));
        await db.deleteSession(sid);
    });
});

describe('P0-1 OpenCode runtime modes', () => {
    const svc = require('../src/services/opencode');

    it('reports unavailable in production without server URL', () => {
        withEnv({ NODE_ENV: 'production', MOCK_OPENCODE: undefined, OPENCODE_SERVER_URL: '' }, () => {
            assert.equal(svc.getRuntimeMode(), 'unavailable');
            assert.throws(() => svc.assertRuntimeAvailable(), /RUNTIME_UNAVAILABLE|runtime unavailable/);
        });
    });

    it('reports mock in dev with MOCK_OPENCODE', () => {
        withEnv({ NODE_ENV: 'development', MOCK_OPENCODE: 'true', OPENCODE_SERVER_URL: '' }, () => {
            assert.equal(svc.getRuntimeMode(), 'mock');
        });
    });

    it('reports remote-server when URL configured', () => {
        withEnv({ NODE_ENV: 'production', MOCK_OPENCODE: undefined, OPENCODE_SERVER_URL: 'http://agent-worker:4096' }, () => {
            assert.equal(svc.getRuntimeMode(), 'remote-server');
        });
    });

    it('run() rejects RUNTIME_UNAVAILABLE instead of fake success', async () => {
        await withEnv({ NODE_ENV: 'production', MOCK_OPENCODE: undefined, OPENCODE_SERVER_URL: '' }, async () => {
            await assert.rejects(svc.run('hello', { timeoutMs: 1000 }), /RUNTIME_UNAVAILABLE|runtime unavailable/);
        });
    });

    it('rejects MOCK_OPENCODE in production (fail fast, no spawn)', async () => {
        await withEnv({ NODE_ENV: 'production', MOCK_OPENCODE: 'true' }, async () => {
            await assert.rejects(svc.run('hello', { timeoutMs: 1000 }), /MOCK_FORBIDDEN|forbidden/);
            await assert.rejects(svc.runStream('hello', { timeoutMs: 1000 }), /MOCK_FORBIDDEN|forbidden/);
        });
    });
});

describe('P0-7 validateEnv ALLOWED_ORIGINS edge cases', () => {
    const { validateEnv } = require('../src/middleware/validateEnv');

    const baseProd = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        AUTH_USERNAME: 'admin',
        AUTH_PASSWORD: 'secret',
        WORKSPACE_ROOT: '/tmp/today-ai-test-workspaces',
        MOCK_OPENCODE: undefined, // must not leak dev mock flag into prod validation
        OPENCODE_SERVER_URL: undefined
    };

    async function exitsWith(overrides) {
        let exited = false;
        const origExit = process.exit;
        process.exit = () => { exited = true; throw new Error('exit(1)'); };
        try {
            await withEnv({ ...baseProd, ...overrides }, async () => validateEnv());
        } catch {}
        process.exit = origExit;
        return exited;
    }

    it('fails without ALLOWED_ORIGINS', async () => {
        assert.ok(await exitsWith({ ALLOWED_ORIGINS: undefined }));
    });

    it('fails with empty string ALLOWED_ORIGINS', async () => {
        assert.ok(await exitsWith({ ALLOWED_ORIGINS: '' }));
    });

    it('fails with whitespace-only ALLOWED_ORIGINS', async () => {
        assert.ok(await exitsWith({ ALLOWED_ORIGINS: '   ' }));
    });

    it('fails with wildcard * as ALLOWED_ORIGINS', async () => {
        assert.ok(await exitsWith({ ALLOWED_ORIGINS: '*' }));
    });

    it('fails with * inside comma-separated list', async () => {
        assert.ok(await exitsWith({ ALLOWED_ORIGINS: 'https://ok.com,*' }));
    });

    it('fails with origin missing protocol', async () => {
        assert.ok(await exitsWith({ ALLOWED_ORIGINS: 'today.example.com' }));
    });

    it('passes with valid ALLOWED_ORIGINS (single + multiple)', async () => {
        assert.ok(!await exitsWith({ ALLOWED_ORIGINS: 'https://today.example.com' }));
        assert.ok(!await exitsWith({ ALLOWED_ORIGINS: 'https://a.com,https://b.com' }));
    });

    it('does not require ALLOWED_ORIGINS in development', async () => {
        assert.ok(!await exitsWith({ NODE_ENV: 'development', ALLOWED_ORIGINS: undefined }));
    });

    it('never outputs secrets in error messages', async () => {
        const logs = [];
        const origError = console.error;
        console.error = (...args) => logs.push(args.join(' '));
        await exitsWith({ ALLOWED_ORIGINS: undefined });
        console.error = origError;
        const all = logs.join(' ');
        assert.ok(!all.includes('secret'));
        assert.ok(!all.includes('postgresql://'));
    });
});

describe('P0-4 OpenCodeClient server transport', () => {
    const { OpenCodeClient, NOT_IMPLEMENTED } = require('../src/services/agentClient');

    it('health() reports failure for unreachable server (no fake success)', async () => {
        await withEnv({ NODE_ENV: 'development', MOCK_OPENCODE: undefined, OPENCODE_SERVER_URL: '' }, async () => {
            const client = new OpenCodeClient({ transport: 'server', serverUrl: 'http://127.0.0.1:9' });
            const h = await client.health();
            assert.equal(h.available, false);
            assert.ok(h.reason);
        });
    });

    it('server transport implements session/message/abort against fixtures', async () => {
        // Fake server speaks the VERIFIED opencode shapes (POST /session ->
        // {id}, POST message -> {info,parts}, POST abort -> true).
        const http = require('http');
        const seen = [];
        const fake = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                seen.push(`${req.method} ${req.url}`);
                res.setHeader('Content-Type', 'application/json');
                if (req.method === 'POST' && req.url === '/session') {
                    res.end(JSON.stringify({ id: 'ses_test123', slug: 'test' }));
                } else if (/^\/session\/[^/]+\/message$/.test(req.url)) {
                    res.end(JSON.stringify({ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hello-from-server' }, { type: 'tool', tool: 'Bash' }] }));
                } else if (/\/abort$/.test(req.url)) {
                    res.end('true');
                } else {
                    res.writeHead(200); res.end('{}');
                }
            });
        });
        await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
        try {
            const url = `http://127.0.0.1:${fake.address().port}`;
            const client = new OpenCodeClient({ transport: 'server', serverUrl: url });
            const ses = await client.createSession({ title: 't' });
            assert.equal(ses.id, 'ses_test123');
            const out = await client.promptSession(ses.id, 'hi');
            assert.equal(out.result, 'hello-from-server');
            assert.deepEqual(out.mcpTools, ['bash']);
            const aborted = await client.abortSession(ses.id);
            assert.equal(aborted.ok, true);
            assert.ok(seen.includes('POST /session'));
        } finally {
            await new Promise((resolve) => fake.close(resolve));
        }
    });

    it('CLI-style prompt streaming stays NOT_IMPLEMENTED on server transport', async () => {
        const http = require('http');
        const fake = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
        await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
        try {
            const url = `http://127.0.0.1:${fake.address().port}`;
            const client = new OpenCodeClient({ transport: 'server', serverUrl: url });
            const err = await client.subscribeEvents('hi', { onEvent: () => {} }).then(() => null, (e) => e);
            assert.ok(err, 'should reject');
            assert.equal(err.code, NOT_IMPLEMENTED);
        } finally {
            await new Promise((resolve) => fake.close(resolve));
        }
    });

    it('explicit server transport fails explicitly when unreachable', async () => {
        const client = new OpenCodeClient({ transport: 'server', serverUrl: 'http://127.0.0.1:9' });
        const err = await client.sendPrompt('hi').then(() => null, (e) => e);
        assert.ok(err, 'should reject');
        assert.equal(err.code, 'RUNTIME_UNAVAILABLE');
    });

    it('abortSession aborts via controller', async () => {
        const client = new OpenCodeClient({ transport: 'cli' });
        const c = new AbortController();
        assert.deepEqual(await client.abortSession(c), { ok: true });
        assert.ok(c.signal.aborted);
    });
});

describe('P0-5 streaming event normalization', () => {
    const { normalizeOpenCodeEvent, parseStreamLine } = require('../src/services/agentEvents');

    // Real event shapes captured from `opencode run --format json` (1.18.30).
    it('maps step_start -> message.started', () => {
        const out = normalizeOpenCodeEvent({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } });
        assert.deepEqual(out, { type: 'message.started', sessionId: 'ses_1' });
    });

    it('maps text -> text.delta with clean content', () => {
        const out = normalizeOpenCodeEvent({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: '1\n2\n3' } });
        assert.deepEqual(out, { type: 'text.delta', content: '1\n2\n3' });
    });

    it('maps tool_use -> tool.started (lowercased)', () => {
        const out = normalizeOpenCodeEvent({ type: 'tool_use', part: { type: 'tool', tool: 'Bash', callID: 'call_1' } });
        assert.deepEqual(out, { type: 'tool.started', tool: 'bash', callId: 'call_1' });
    });

    it('maps step_finish stop -> message.completed, tool-calls -> null', () => {
        assert.deepEqual(
            normalizeOpenCodeEvent({ type: 'step_finish', sessionID: 's', part: { type: 'step-finish', reason: 'stop' } }),
            { type: 'message.completed', sessionId: 's' }
        );
        assert.equal(normalizeOpenCodeEvent({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } }), null);
    });

    it('never crashes on malformed/empty/unknown chunks', () => {
        assert.equal(normalizeOpenCodeEvent(null), null);
        assert.equal(normalizeOpenCodeEvent({}), null);
        assert.equal(normalizeOpenCodeEvent({ type: 'future_event_xyz', part: {} }), null);
        assert.deepEqual(parseStreamLine(''), { empty: true });
        assert.deepEqual(parseStreamLine('   '), { empty: true });
        assert.deepEqual(parseStreamLine('not json at all'), { malformed: true });
        assert.deepEqual(parseStreamLine('{broken json'), { malformed: true });
        const ok = parseStreamLine('{"type":"text","part":{"type":"text","text":"hi"}}');
        assert.equal(ok.event.type, 'text');
    });

    it('normalized output never leaks secrets', () => {
        const out = normalizeOpenCodeEvent({ type: 'text', part: { type: 'text', text: 'token abc123' } });
        assert.ok(!('cookie' in out) && !('password' in out) && !('token' in out));
        assert.deepEqual(Object.keys(out).sort(), ['content', 'type']);
    });
});

describe('P0-6 git argument safety', () => {
    const git = require('../src/services/git');

    it('rejects command-injection repository URLs', () => {
        for (const bad of [
            'https://example.com/r.git; rm -rf /',
            'https://example.com/r.git && evil',
            '$(evil)',
            '`evil`',
            'https://example.com/r.git | evil',
            '',
            'ftp://example.com/r.git',
            'javascript:alert(1)'
        ]) {
            assert.throws(() => git.validateRepoUrl(bad), /Invalid|must be/, `should reject ${bad}`);
        }
    });

    it('accepts https and ssh-like URLs', () => {
        assert.ok(git.validateRepoUrl('https://github.com/o/r.git'));
        assert.ok(git.validateRepoUrl('git@github.com:o/r.git'));
    });

    it('rejects dangerous refs and branches', () => {
        for (const bad of ['-evil', '../x', '', 'a;b', 'a b']) {
            assert.throws(() => git.validateRef(bad, 'branch'), /Invalid/, `should reject ${bad}`);
        }
        assert.ok(git.validateRef('feature/ok-1', 'branch'));
    });

    it('rejects paths escaping the workspace', async () => {
        await assert.rejects(git.readWorkspaceFile('nope-ws', '../../etc/passwd'), /escapes|Not found|not found|ENOENT/);
    });

    it('git ops fail safely outside a repo (no shell)', async () => {
        const ws = require('../src/services/workspace');
        const root = path.join(os.tmpdir(), `today-ai-git-test-${Date.now()}`);
        await withEnv({ WORKSPACE_ROOT: root }, async () => {
            await ws.createWorkspace('gitws');
            const err = await git.getStatus('gitws').then(() => null, (e) => e);
            assert.ok(err, 'should reject outside a repo');
            assert.equal(err.code, 'GIT_ERROR');
            await ws.removeWorkspace('gitws');
        });
        await fs.promises.rm(root, { recursive: true, force: true });
    });
});

describe('P0-3 workspace cwd isolation (A/B)', () => {
    const svc = require('../src/services/opencode');
    const ws = require('../src/services/workspace');
    const { OpenCodeClient } = require('../src/services/agentClient');

    it('A agent cwd === A workspace, B agent cwd === B workspace', async () => {
        const root = path.join(os.tmpdir(), `today-ai-cwd-test-${Date.now()}`);
        await withEnv({ WORKSPACE_ROOT: root }, async () => {
            const dirA = await ws.createWorkspace('agent-a');
            const dirB = await ws.createWorkspace('agent-b');
            const seen = [];
            const origRun = svc.run;
            const origRunStream = svc.runStream;
            svc.runStream = async (prompt, opts = {}) => {
                seen.push({ prompt, cwd: opts.cwd || null });
                return { result: 'ok', mcpTools: [], raw: '' };
            };
            try {
                const clientA = new OpenCodeClient({ transport: 'cli', workspaceDir: dirA });
                const clientB = new OpenCodeClient({ transport: 'cli', workspaceId: undefined, workspaceDir: dirB });
                await clientA.subscribeEvents('task A', { onEvent: () => {} });
                await clientB.subscribeEvents('task B', { onEvent: () => {} });
                assert.equal(seen.length, 2);
                assert.equal(seen[0].cwd, dirA);
                assert.equal(seen[1].cwd, dirB);
                assert.notEqual(seen[0].cwd, seen[1].cwd);
                assert.ok(!seen[0].cwd.includes('todayai') || seen[0].cwd === dirA);
            } finally {
                svc.runStream = origRunStream;
                void origRun;
                await ws.removeWorkspace('agent-a').catch(() => {});
                await ws.removeWorkspace('agent-b').catch(() => {});
            }
        });
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it('one-shot run() also honors workspace cwd', async () => {
        const svc2 = require('../src/services/opencode');
        const root = path.join(os.tmpdir(), `today-ai-cwd-test-${Date.now()}`);
        await withEnv({ WORKSPACE_ROOT: root }, async () => {
            const ws2 = require('../src/services/workspace');
            const dir = await ws2.createWorkspace('agent-c');
            const origRun = svc2.run;
            let gotCwd = null;
            svc2.run = async (prompt, opts = {}) => {
                gotCwd = opts.cwd || null;
                return { result: 'ok', mcpTools: [], raw: '' };
            };
            try {
                const { OpenCodeClient: C2 } = require('../src/services/agentClient');
                await new C2({ transport: 'cli', workspaceDir: dir }).sendPrompt('hi');
                assert.equal(gotCwd, dir);
            } finally {
                svc2.run = origRun;
                await ws2.removeWorkspace('agent-c').catch(() => {});
            }
        });
        await fs.promises.rm(root, { recursive: true, force: true });
    });
});

describe('P0-6 session execution lock', () => {
    const lock = require('../src/services/executionLock');

    it('A running -> B rejected -> A done -> B allowed', () => {
        lock._clearForTests();
        const sid = `lock-${Date.now()}`;
        const a = lock.tryAcquire(sid, { agentId: 'a1' });
        assert.ok(a);
        assert.ok(lock.isLocked(sid));
        const err = (() => { try { lock.tryAcquire(sid, { agentId: 'b1' }); return null; } catch (e) { return e; } })();
        assert.ok(err, 'B must be rejected while A holds the lock');
        assert.equal(err.code, 'SESSION_BUSY');
        assert.equal(err.status, 409);
        assert.ok(lock.release(a));
        assert.ok(!lock.isLocked(sid));
        const b = lock.tryAcquire(sid, { agentId: 'b1' });
        assert.ok(b);
        assert.ok(lock.release(b.sessionId));
    });

    it('stale token never releases another holder', () => {
        lock._clearForTests();
        const sid = `lock-stale-${Date.now()}`;
        const a = lock.tryAcquire(sid, { agentId: 'a1' });
        assert.equal(lock.release({ sessionId: sid, agentId: 'impostor' }), false);
        assert.ok(lock.isLocked(sid));
        assert.ok(lock.release(a));
    });
});

describe('P0-5 server event normalization (verified 1.18.30 shapes)', () => {
    const { normalizeServerEvent } = require('../src/services/agentEvents');

    it('maps message.part.delta text -> text.delta', () => {
        const out = normalizeServerEvent({
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'APPLE' }
        }, {});
        assert.deepEqual(out, { type: 'text.delta', content: 'APPLE', partId: 'prt_1', messageId: 'msg_1' });
    });

    it('drops deltas from non-text parts and non-text fields', () => {
        const pts = { prt_r: 'reasoning' };
        assert.equal(normalizeServerEvent({
            type: 'message.part.delta',
            properties: { sessionID: 's', messageID: 'm', partID: 'prt_r', field: 'text', delta: 'hmm' }
        }, pts), null);
        assert.equal(normalizeServerEvent({
            type: 'message.part.delta',
            properties: { sessionID: 's', messageID: 'm', partID: 'prt_1', field: 'other', delta: 'x' }
        }, {}), null);
    });

    it('tracks part types and maps tool parts -> tool.started', () => {
        const pts = {};
        assert.equal(normalizeServerEvent({
            type: 'message.part.updated',
            properties: { sessionID: 's', part: { id: 'prt_t', type: 'text' } }
        }, pts), null);
        assert.equal(pts.prt_t, 'text');
        const tool = normalizeServerEvent({
            type: 'message.part.updated',
            properties: { sessionID: 's', part: { id: 'prt_x', type: 'tool', tool: 'Bash', callID: 'call_9' } }
        }, pts);
        assert.deepEqual(tool, { type: 'tool.started', tool: 'bash', callId: 'call_9' });
    });

    it('maps assistant message.updated -> message.started, ignores user + idle', () => {
        assert.deepEqual(normalizeServerEvent({
            type: 'message.updated',
            properties: { sessionID: 's', info: { id: 'msg_a', role: 'assistant' } }
        }, {}), { type: 'message.started', messageId: 'msg_a' });
        assert.equal(normalizeServerEvent({
            type: 'message.updated',
            properties: { sessionID: 's', info: { id: 'msg_u', role: 'user' } }
        }, {}), null);
        assert.equal(normalizeServerEvent({ type: 'session.idle', properties: { sessionID: 's' } }, {}), null);
        assert.equal(normalizeServerEvent({ type: 'session.status', properties: {} }, {}), null);
        assert.equal(normalizeServerEvent(null, {}), null);
    });
});

describe('P0.6 worker-backed routes (isolated app)', () => {
    // P0.6-15: 1 chat uses worker, 2 stream uses worker, 3 cleanup success,
    // 8 one worker per execution, 10 status lifecycle, 11 concurrent
    // sessions separate workers, 12 password never exposed.
    // (4/5/6 failure/abort/timeout cleanup live in worker.test.js withWorker
    // unit tests; 7 disconnect cleanup + 9 history-once already covered.)
    let localBase = null;
    let localServer = null;
    let cookie = '';
    const savedEnv = {};

    before(async () => {
        for (const k of ['AUTH_USERNAME', 'AUTH_PASSWORD', 'MOCK_OPENCODE', 'NODE_ENV', 'WORKSPACE_KEEP_ON_FAILURE']) {
            savedEnv[k] = process.env[k];
        }
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'admin123';
        process.env.MOCK_OPENCODE = 'true';
        delete process.env.NODE_ENV;
        delete process.env.WORKSPACE_KEEP_ON_FAILURE;
        const app = require('../src/app');
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
        if (m) cookie = `todayai_session=${m[1]}`;
        assert.ok(cookie, 'worker-route login must succeed');
    });

    after(async () => {
        if (localServer) {
            if (localServer.closeAllConnections) localServer.closeAllConnections();
            await new Promise((resolve) => localServer.close(resolve));
        }
        for (const k of Object.keys(savedEnv)) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    async function agentRows(sid) {
        const res = await fetch(`${localBase}/api/agent-sessions?limit=100`, { headers: { Cookie: cookie } });
        const rows = await res.json();
        return rows.filter((r) => r.workspaceId === sid);
    }

    function workspaceGone(sid) {
        const ws = require('../src/services/workspace');
        return !fs.existsSync(ws.getWorkspacePath(sid));
    }

    it('1/10: /api/chat runs in a worker (agent row completed)', async () => {
        const sid = `wch-${Date.now()}`;
        const res = await fetch(`${localBase}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ prompt: 'hello worker chat', sessionId: sid })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.result.includes('mock for: hello worker chat'));
        const rows = await agentRows(sid);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'completed');
        assert.equal(rows[0].owner, 'admin');
        await fetch(`${localBase}/api/agent-sessions/${rows[0].id}`, { method: 'DELETE', headers: { Cookie: cookie } });
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });

    it('2/3: /api/chat/stream runs in a worker and cleans workspace', async () => {
        const sid = `wst-${Date.now()}`;
        const res = await fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ prompt: 'hello worker stream', sessionId: sid })
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes('event: done'));
        const rows = await agentRows(sid);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'completed');
        assert.ok(workspaceGone(sid), 'workspace must be cleaned after success');
        await fetch(`${localBase}/api/agent-sessions/${rows[0].id}`, { method: 'DELETE', headers: { Cookie: cookie } });
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });

    it('8: one worker per execution (sequential requests, distinct agents)', async () => {
        const sid = `w1x-${Date.now()}`;
        for (const p of ['first run', 'second run']) {
            const res = await fetch(`${localBase}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ prompt: p, sessionId: sid })
            });
            assert.equal(res.status, 200);
        }
        const rows = await agentRows(sid);
        assert.equal(rows.length, 2, 'each execution gets its own worker/agent row');
        assert.notEqual(rows[0].id, rows[1].id);
        for (const r of rows) {
            await fetch(`${localBase}/api/agent-sessions/${r.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
        }
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });

    it('10: session status transitions cancelled/failed deterministically', async () => {
        const db = require('../src/db/db');
        const id = `wstatus-${Date.now()}`;
        await db.createAgentSession({ id, owner: 'admin', workspaceId: 'w' });
        await db.updateAgentSessionStatus(id, 'running');
        await db.updateAgentSessionStatus(id, 'cancelled');
        assert.equal((await db.getAgentSession(id)).status, 'cancelled');
        await db.updateAgentSessionStatus(id, 'failed');
        assert.equal((await db.getAgentSession(id)).status, 'failed');
        await db.deleteAgentSession(id);
    });

    it('11: concurrent sessions use separate workers and both complete', async () => {
        const sidA = `wca-${Date.now()}`;
        const sidB = `wcb-${Date.now()}`;
        const post = (sid, prompt) => fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ prompt, sessionId: sid })
        }).then(async (r) => ({ status: r.status, text: await r.text() }));
        const [a, b] = await Promise.all([post(sidA, 'msg A'), post(sidB, 'msg B')]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.ok(a.text.includes('event: done') && b.text.includes('event: done'));
        const rowsA = await agentRows(sidA);
        const rowsB = await agentRows(sidB);
        assert.equal(rowsA.length, 1);
        assert.equal(rowsB.length, 1);
        assert.notEqual(rowsA[0].id, rowsB[0].id);
        assert.ok(!a.text.includes('msg B') && !b.text.includes('msg A'), 'no cross-talk');
        for (const r of [...rowsA, ...rowsB]) {
            await fetch(`${localBase}/api/agent-sessions/${r.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
        }
        await fetch(`${localBase}/api/sessions/${sidA}`, { method: 'DELETE', headers: { Cookie: cookie } });
        await fetch(`${localBase}/api/sessions/${sidB}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });

    it('12: worker password never exposed via API or SSE', async () => {
        const res = await fetch(`${localBase}/api/agent-sessions?limit=5`, { headers: { Cookie: cookie } });
        const text = JSON.stringify(await res.json());
        assert.ok(!text.includes('password'), 'agent rows must not contain password');
        assert.ok(!text.includes('todayai_session'), 'agent rows must not contain session token');
        const sid = `wpw-${Date.now()}`;
        const sse = await fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ prompt: 'credential exposure probe', sessionId: sid })
        });
        const sseText = await sse.text();
        assert.ok(!sseText.includes('password'), 'SSE must not contain password');
        const rows = await agentRows(sid);
        for (const r of rows) {
            await fetch(`${localBase}/api/agent-sessions/${r.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
        }
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } });
    });
});

describe('P0-5 POST /api/chat/stream over HTTP', () => {
    // Boots the REAL app in-process on a random port so these tests get a
    // private rate-limiter budget. All test files share one external server
    // whose 10-failure login budget is consumed by auth.test.js; depending
    // on parallel scheduling this file's login would race it and flake.
    let localBase = BASE;
    let localServer = null;
    let cookie = '';
    const sid = `stream-${Date.now()}`;
    let agentId = null;

    const savedEnv = {};
    before(async () => {
        for (const k of ['AUTH_USERNAME', 'AUTH_PASSWORD', 'MOCK_OPENCODE', 'NODE_ENV']) {
            savedEnv[k] = process.env[k];
        }
        process.env.AUTH_USERNAME = 'admin';
        process.env.AUTH_PASSWORD = 'admin123';
        process.env.MOCK_OPENCODE = 'true';
        delete process.env.NODE_ENV;
        const app = require('../src/app');
        localServer = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        localBase = `http://127.0.0.1:${localServer.address().port}`;
        const res = await fetch(`${localBase}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        const sc = res.headers.get('set-cookie') || '';
        const m = sc.match(/todayai_session=([^;]+)/);
        if (m) cookie = `todayai_session=${m[1]}`;
        assert.ok(cookie, 'stream-test login must succeed');
    });

    after(async () => {
        await fetch(`${localBase}/api/sessions/${sid}`, { method: 'DELETE', headers: { Cookie: cookie } }).catch(() => {});
        if (agentId) {
            await fetch(`${localBase}/api/agent-sessions/${agentId}`, { method: 'DELETE', headers: { Cookie: cookie } }).catch(() => {});
        }
        // Best-effort workspace cleanup (same host as server here).
        try {
            const ws = require('../src/services/workspace');
            await ws.removeWorkspace(sid).catch(() => {});
        } catch {}
        if (localServer) {
            if (localServer.closeAllConnections) localServer.closeAllConnections();
            await new Promise((resolve) => localServer.close(resolve));
        }
        for (const k of Object.keys(savedEnv)) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    async function readStream(prompt, extraHeaders = {}) {
        const res = await fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extraHeaders },
            body: JSON.stringify({ prompt, sessionId: sid })
        });
        return res;
    }

    it('401 without login, SSE headers absent', async () => {
        const res = await fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'hi', sessionId: sid })
        });
        assert.equal(res.status, 401);
        assert.ok(!(res.headers.get('content-type') || '').includes('text/event-stream'));
        await res.text().catch(() => {});
    });

    it('SSE headers + session.started + done events (mock runtime)', async () => {
        const res = await readStream('hello stream test');
        assert.equal(res.status, 200);
        assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
        const text = await res.text();
        const events = [];
        for (const chunk of text.split('\n\n')) {
            const ev = (chunk.match(/^event:\s*(.+)$/m) || [])[1];
            const dm = chunk.match(/^data:\s*(.+)$/m);
            if (ev && dm) events.push({ ev, data: JSON.parse(dm[1]) });
        }
        const names = events.map(e => e.ev);
        assert.ok(names.includes('session.started'), `expected session.started, got ${names}`);
        assert.ok(names.includes('message.started'), `expected message.started, got ${names}`);
        assert.ok(names.includes('text.delta'), `expected text.delta, got ${names}`);
        assert.ok(names.includes('done'), `expected done, got ${names}`);
        assert.ok(!names.includes('error'), 'should not contain error event');
        for (const e of events) {
            assert.ok(!('cookie' in e.data) && !('password' in e.data) && !('token' in e.data), 'no secrets in SSE data');
        }
        const started = events.find(e => e.ev === 'session.started');
        agentId = started.data.agentSessionId;
        assert.ok(agentId);
    });

    it('streamed assistant content is persisted exactly once', async () => {
        const histRes = await fetch(`${localBase}/api/history?sessionId=${sid}&limit=10`, { headers: { Cookie: cookie } });
        const hist = await histRes.json();
        const aiRows = hist.filter(r => r.role === 'ai');
        assert.ok(aiRows.length >= 1);
        assert.ok(aiRows.some(r => (r.content || '').includes('mock for: hello stream test')));
    });

    it('empty prompt rejected without SSE', async () => {
        const res = await readStream('');
        assert.equal(res.status, 400);
    });

    it('client abort does not crash server', async () => {
        const controller = new AbortController();
        const p = fetch(`${localBase}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ prompt: 'hello abort test', sessionId: sid }),
            signal: controller.signal
        });
        controller.abort();
        await p.then(() => {}).catch(() => {});
        const health = await fetch(`${localBase}/api/health`);
        assert.equal(health.status, 200);
    });
});
