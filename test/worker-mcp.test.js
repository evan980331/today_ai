// Worker MCP config regression tests.
// cwd must stay workspacePath; secrets only in process env, never in files.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(os.tmpdir(), `today-ai-worker-mcp-test-${Date.now()}-${process.pid}`);
const OLD_ROOT = process.env.WORKSPACE_ROOT;
process.env.WORKSPACE_ROOT = ROOT;

const workerSvc = require('../src/services/agentWorker');
const ws = require('../src/services/workspace');
const mcpCfg = require('../src/services/workerMcpConfig');

class FakeProc extends EventEmitter {
    constructor() {
        super();
        this.exitCode = null;
        this.signals = [];
    }
    kill(sig = 'SIGTERM') {
        this.signals.push(sig);
        setTimeout(() => { this.exitCode = 0; this.emit('exit', 0); }, 10);
        return true;
    }
}

afterEach(async () => {
    workerSvc._clearForTests();
});

describe('Worker MCP config', () => {
    it('createWorkspace writes opencode.json with github/google-calendar/gmail', async () => {
        const dir = await ws.createWorkspace('mcp-ws-1');
        const cfgPath = path.join(dir, 'opencode.json');
        assert.ok(fs.existsSync(cfgPath), 'workspace must contain opencode.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.ok(cfg.mcp && typeof cfg.mcp === 'object');
        for (const name of ['github', 'google-calendar', 'gmail']) {
            assert.ok(cfg.mcp[name], `mcp.${name} must exist`);
        }
        await ws.removeWorkspace('mcp-ws-1');
    });

    it('createWorker workspace has opencode.json without real secrets', async () => {
        const w = await workerSvc.createWorker({ workspaceId: 'mcp-w-1' });
        try {
            const cfgPath = path.join(w.workspacePath, 'opencode.json');
            assert.ok(fs.existsSync(cfgPath));
            const text = fs.readFileSync(cfgPath, 'utf8');
            const cfg = JSON.parse(text);
            assert.ok(cfg.mcp.github && cfg.mcp['google-calendar'] && cfg.mcp.gmail);
            for (const v of mcpCfg.MCP_CREDENTIAL_VARS) {
                const val = process.env[v];
                if (val && val.trim() && !val.includes('your_')) {
                    assert.ok(!text.includes(val.trim()), `config must not contain ${v} value`);
                }
            }
            assert.ok(!/(ghp_[A-Za-z0-9]{10,}|ya29\.[\w-]{10,})/.test(text), 'no real token shapes in config');
        } finally {
            await workerSvc.cleanupWorker(w.workerId);
        }
    });

    it('spawn cwd stays workspacePath and creds only in process env', async () => {
        const { OpenCodeClient } = require('../src/services/agentClient');
        const origHealth = OpenCodeClient.prototype.health;
        OpenCodeClient.prototype.health = async () => ({ available: true, transport: 'server', mode: 'test', status: 200 });
        const w = await workerSvc.createWorker({ workspaceId: 'mcp-w-2' });
        let captured = null;
        const spawnFn = (args, opts) => {
            captured = { args, opts };
            const p = new FakeProc();
            return p;
        };
        try {
            await workerSvc.startWorker(w.workerId, { spawnFn, timeoutMs: 8000 });
            assert.equal(captured.opts.cwd, w.workspacePath, 'cwd must stay workspacePath');
            assert.ok(captured.opts.env.OPENCODE_SERVER_USERNAME, 'basic auth username preserved');
            assert.ok(captured.opts.env.OPENCODE_SERVER_PASSWORD, 'basic auth password preserved');
            // MCP creds flow via env inheritance only; config file has placeholders.
            const text = fs.readFileSync(path.join(w.workspacePath, 'opencode.json'), 'utf8');
            assert.ok(text.includes('{env:'), 'config must reference env placeholders');
        } finally {
            OpenCodeClient.prototype.health = origHealth;
            await workerSvc.cleanupWorker(w.workerId).catch(() => {});
        }
    });

    it('does not leak credentials via warnings or config', async () => {
        const prev = {
            GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
            GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
            GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN
        };
        process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_testsecretvalue1234567890';
        process.env.GOOGLE_CLIENT_ID = 'cid-test-123';
        process.env.GOOGLE_CLIENT_SECRET = 'csec-test-123';
        process.env.GOOGLE_REFRESH_TOKEN = 'rt-test-123';
        const logs = [];
        const origWarn = console.warn;
        console.warn = (...a) => { logs.push(a.join(' ')); };
        try {
            const st = mcpCfg.warnMissingMcpCredentials();
            assert.equal(st.missing.length, 0);
            // Force missing path
            delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
            const st2 = mcpCfg.warnMissingMcpCredentials();
            assert.ok(st2.missing.includes('GITHUB_PERSONAL_ACCESS_TOKEN'));
            const out = logs.join('\n');
            assert.ok(!out.includes('ghp_testsecretvalue'), 'warning must not print secret values');
            assert.ok(!out.includes('csec-test-123'), 'warning must not print secret values');
        } finally {
            console.warn = origWarn;
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    });
});
