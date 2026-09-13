// Vercel cold-start boundary: WORKSPACE_ROOT is Worker-only.
// Vercel API must not require WORKSPACE_ROOT; Worker still may use it via workspace.js fallback.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

async function withEnv(overrides, fn) {
    const orig = {};
    for (const k of Object.keys(overrides)) {
        orig[k] = process.env[k];
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    try { return await fn(); }
    finally {
        for (const k of Object.keys(overrides)) {
            if (orig[k] === undefined) delete process.env[k];
            else process.env[k] = orig[k];
        }
    }
}

function exitsWith(fn) {
    let exited = false;
    const origExit = process.exit;
    process.exit = () => { exited = true; throw new Error('exit(1)'); };
    try { fn(); } catch {}
    process.exit = origExit;
    return exited;
}

const baseProd = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    AUTH_USERNAME: 'admin',
    AUTH_PASSWORD: 'secret',
    ALLOWED_ORIGINS: 'https://today.example.com',
    WORKSPACE_ROOT: undefined,
    MOCK_OPENCODE: undefined,
    OPENCODE_SERVER_URL: undefined,
    WORKER_URL: undefined,
    WORKER_SHARED_SECRET: undefined,
};

describe('validateEnv WORKSPACE_ROOT is optional on Vercel API', () => {
    const { validateEnv } = require('../src/middleware/validateEnv');

    it('production without WORKSPACE_ROOT does NOT exit', async () => {
        assert.equal(await withEnv({ ...baseProd, WORKSPACE_ROOT: undefined }, () => exitsWith(() => validateEnv())), false);
        assert.equal(await withEnv({ ...baseProd, WORKSPACE_ROOT: '' }, () => exitsWith(() => validateEnv())), false);
        assert.equal(await withEnv({ ...baseProd, WORKSPACE_ROOT: '   ' }, () => exitsWith(() => validateEnv())), false);
    });

    it('production without DATABASE_URL still fails', async () => {
        assert.equal(await withEnv({ ...baseProd, DATABASE_URL: undefined }, () => exitsWith(() => validateEnv())), true);
    });

    it('production without AUTH_USERNAME/AUTH_PASSWORD does NOT fail (now DB-backed), ALLOWED_ORIGINS still fails', async () => {
        assert.equal(await withEnv({ ...baseProd, AUTH_USERNAME: undefined }, () => exitsWith(() => validateEnv())), false);
        assert.equal(await withEnv({ ...baseProd, AUTH_PASSWORD: undefined }, () => exitsWith(() => validateEnv())), false);
        assert.equal(await withEnv({ ...baseProd, ALLOWED_ORIGINS: undefined }, () => exitsWith(() => validateEnv())), true);
    });

    it('production ALLOWED_ORIGINS invalid still fails (format validation intact)', async () => {
        assert.equal(await withEnv({ ...baseProd, ALLOWED_ORIGINS: '*' }, () => exitsWith(() => validateEnv())), true);
        assert.equal(await withEnv({ ...baseProd, ALLOWED_ORIGINS: 'today.example.com' }, () => exitsWith(() => validateEnv())), true);
        assert.equal(await withEnv({ ...baseProd, ALLOWED_ORIGINS: '   ' }, () => exitsWith(() => validateEnv())), true);
    });

    it('MOCK_OPENCODE=true in production still fails', async () => {
        assert.equal(await withEnv({ ...baseProd, MOCK_OPENCODE: 'true' }, () => exitsWith(() => validateEnv())), true);
    });

    it('WORKER_URL / WORKER_SHARED_SECRET half-configured in production still fails', async () => {
        assert.equal(await withEnv({ ...baseProd, WORKER_URL: 'https://worker.example.com', WORKER_SHARED_SECRET: undefined }, () => exitsWith(() => validateEnv())), true);
        assert.equal(await withEnv({ ...baseProd, WORKER_URL: undefined, WORKER_SHARED_SECRET: 'secret' }, () => exitsWith(() => validateEnv())), true);
        // both set => pass (assuming other required present)
        assert.equal(await withEnv({ ...baseProd, WORKER_URL: 'https://worker.example.com', WORKER_SHARED_SECRET: 'secret', OPENCODE_SERVER_URL: 'https://worker.example.com' }, () => exitsWith(() => validateEnv())), false);
        // both unset => pass
        assert.equal(await withEnv({ ...baseProd, WORKER_URL: undefined, WORKER_SHARED_SECRET: undefined }, () => exitsWith(() => validateEnv())), false);
    });
});

describe('workspace.js production fallback without WORKSPACE_ROOT', () => {
    const ws = require('../src/services/workspace');

    it('production without WORKSPACE_ROOT falls back to os.tmpdir()/today-ai-workspaces', async () => {
        await withEnv({ WORKSPACE_ROOT: undefined, NODE_ENV: 'production' }, () => {
            const root = ws.getWorkspaceRoot();
            assert.equal(root, path.join(os.tmpdir(), 'today-ai-workspaces'));
            // still resolves workspace paths under fallback
            const p = ws.getWorkspacePath('agent-abc');
            assert.ok(p.startsWith(root));
        });
    });

    it('Worker can still use explicit WORKSPACE_ROOT when set', async () => {
        const custom = path.join(os.tmpdir(), `today-ai-ws-worker-${Date.now()}`);
        await withEnv({ WORKSPACE_ROOT: custom, NODE_ENV: 'production' }, () => {
            assert.equal(ws.getWorkspaceRoot(), path.resolve(custom));
            assert.ok(ws.getWorkspacePath('worker-1').startsWith(path.resolve(custom)));
        });
    });
});
