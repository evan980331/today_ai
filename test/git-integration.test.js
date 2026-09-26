// P3-5 Git Integration tests.
//
// Functional tests run REAL git inside temporary fixture repositories
// under an isolated WORKSPACE_ROOT — never the real Today AI repo.
// Propagation/isolation unit tests use an injected stub commandService
// and never spawn.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const gitService = require('../src/services/gitService');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p35-test-${Date.now()}-${(n += 1)}`;
const APPROVED = { approval: { status: 'approved' } };
const actx = (extra = {}) => ({ owner: 'alice', ...APPROVED, ...extra });

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

async function writeFixture(root, rel, content) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
}

// Workspace whose root is a real git repo with one baseline commit and
// one dirty (modified + untracked) file afterwards.
async function makeRepo(owner = 'alice') {
    const ws = await WorkspaceService.default().create({ sessionId: sid(), owner });
    git(ws.rootPath, 'init');
    git(ws.rootPath, 'config', 'user.name', 'p35-test');
    git(ws.rootPath, 'config', 'user.email', 'p35-test@example.com');
    await writeFixture(ws.rootPath, 'base.txt', 'baseline\n');
    git(ws.rootPath, 'add', '--', 'base.txt');
    git(ws.rootPath, 'commit', '-m', 'p35 baseline');
    await writeFixture(ws.rootPath, 'base.txt', 'baseline\nmodified\n');
    await writeFixture(ws.rootPath, 'new.txt', 'untracked\n');
    return ws;
}

function stubCmd(impl) {
    const calls = [];
    return {
        calls,
        async execute(args) {
            calls.push(args);
            return impl(args);
        }
    };
}

const okOut = { ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 3 };

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-git-test-'));
    process.env.WORKSPACE_ROOT = ROOT;
    resetSharedMemoryForTests();
});

after(async () => {
    if (SAVED_ROOT === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = SAVED_ROOT;
    if (SAVED_DB_URL !== undefined) process.env.DATABASE_URL = SAVED_DB_URL;
    resetSharedMemoryForTests();
    if (ROOT) await fsp.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    toolRegistry._clearForTests();
});

describe('P3-5 read ops (real fixture repo)', () => {
    it('1 git_status returns branch + entries', async () => {
        const ws = await makeRepo();
        const out = await gitService.status({ workspaceId: ws.workspaceId, owner: 'alice' });
        assert.equal(out.ok, true);
        assert.equal(out.operation, 'status');
        assert.ok(typeof out.branch === 'string' && out.branch.length > 0);
        const paths = out.entries.map((e) => e.path);
        assert.ok(paths.includes('base.txt'));
        assert.ok(paths.includes('new.txt'));
        assert.ok(!JSON.stringify(out).includes(ws.rootPath));
    });
    it('2 git_diff shows the modification', async () => {
        const ws = await makeRepo();
        const out = await gitService.diff({ workspaceId: ws.workspaceId, owner: 'alice' });
        assert.equal(out.ok, true);
        assert.ok(out.diff.includes('modified'));
        assert.ok(out.stdout.includes('base.txt'));
    });
    it('3 git_log shows the baseline commit', async () => {
        const ws = await makeRepo();
        const out = await gitService.log({ workspaceId: ws.workspaceId, owner: 'alice' });
        assert.equal(out.ok, true);
        assert.ok(out.entries.length >= 1);
        assert.ok(out.entries[0].subject.includes('p35 baseline'));
        assert.ok(out.entries[0].hash.length >= 7);
    });
    it('4 git_branch shows the current branch', async () => {
        const ws = await makeRepo();
        const out = await gitService.branch({ workspaceId: ws.workspaceId, owner: 'alice' });
        assert.equal(out.ok, true);
        assert.ok(typeof out.branch === 'string' && out.branch.length > 0);
    });
});

describe('P3-5 write ops (real fixture repo)', () => {
    it('5 git_add stages a relative path', async () => {
        const ws = await makeRepo();
        const added = await gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['new.txt'] });
        assert.equal(added.ok, true);
        assert.deepEqual(added.paths, ['new.txt']);
        const st = await gitService.status({ workspaceId: ws.workspaceId, owner: 'alice' });
        const entry = st.entries.find((e) => e.path === 'new.txt');
        assert.ok(entry && (entry.indexStatus === 'A' || entry.indexStatus === 'M'));
    });
    it('6 git_commit commits staged changes', async () => {
        const ws = await makeRepo();
        await gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['new.txt'] });
        const c = await gitService.commit({ workspaceId: ws.workspaceId, owner: 'alice', message: 'p35 second commit' });
        assert.equal(c.ok, true);
        const lg = await gitService.log({ workspaceId: ws.workspaceId, owner: 'alice' });
        assert.ok(lg.entries.some((e) => e.subject.includes('p35 second commit')));
    });
});

describe('P3-5 security', () => {
    it('7 owner isolation (cross-owner invisible)', async () => {
        const ws = await makeRepo('alice');
        await assert.rejects(() => gitService.status({ workspaceId: ws.workspaceId, owner: 'bob' }));
    });
    it('8 missing owner rejected', async () => {
        const ws = await makeRepo('alice');
        await assert.rejects(() => gitService.status({ workspaceId: ws.workspaceId, owner: '' }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('9 workspace isolation via session scope', async () => {
        const a = await makeRepo('alice');
        const b = await makeRepo('alice');
        assert.notEqual(a.workspaceId, b.workspaceId);
        const out = await gitService.status({ sessionId: a.sessionId, owner: 'alice' });
        assert.equal(out.workspaceId, a.workspaceId);
        assert.notEqual(out.workspaceId, b.workspaceId);
    });
    it('10 absolute path rejection', async () => {
        const ws = await makeRepo('alice');
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: [os.tmpdir()] }), (e) => e.code === 'INVALID_PATH');
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['C:\\Windows\\x.txt'] }), (e) => e.code === 'INVALID_PATH');
    });
    it('11 traversal rejection', async () => {
        const ws = await makeRepo('alice');
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['../evil.txt'] }), (e) => e.code === 'INVALID_PATH');
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['sub/../../evil.txt'] }), (e) => e.code === 'INVALID_PATH');
    });
    it('12 symlink escape rejection', async () => {
        const ws = await makeRepo('alice');
        const link = path.join(ws.rootPath, 'link-out');
        try {
            await fsp.symlink(os.tmpdir(), link);
        } catch {
            return;
        }
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['link-out'] }), (e) => e.code === 'INVALID_PATH');
    });
    it('13 empty git_add rejection (no default add-all)', async () => {
        const ws = await makeRepo('alice');
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: [] }), (e) => e.code === 'INVALID_PATH');
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: null }), (e) => e.code === 'INVALID_PATH');
    });
    it('14 "." git_add rejection', async () => {
        const ws = await makeRepo('alice');
        await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['.'] }), (e) => e.code === 'INVALID_PATH');
    });
    it('15 glob rejection', async () => {
        const ws = await makeRepo('alice');
        for (const g of ['*.js', 'src/**', 'file?.txt', 'a[bc].txt']) {
            await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: [g] }), (e) => e.code === 'INVALID_PATH', g);
        }
    });
    it('16 option injection rejection', async () => {
        const ws = await makeRepo('alice');
        for (const o of ['--amend', '--no-verify', '-m', '--']) {
            await assert.rejects(() => gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: [o] }), (e) => e.code === 'INVALID_PATH', o);
        }
        await assert.rejects(() => gitService.log({ workspaceId: ws.workspaceId, owner: 'alice', limit: '--all' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => gitService.log({ workspaceId: ws.workspaceId, owner: 'alice', limit: 0 }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => gitService.log({ workspaceId: ws.workspaceId, owner: 'alice', limit: 51 }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('17 commit message empty rejection', async () => {
        const ws = await makeRepo('alice');
        for (const m of ['', '   ', null, undefined]) {
            await assert.rejects(() => gitService.commit({ workspaceId: ws.workspaceId, owner: 'alice', message: m }), (e) => e.code === 'INVALID_COMMIT_MESSAGE', String(m));
        }
    });
    it('18 commit message too long rejection', async () => {
        const ws = await makeRepo('alice');
        await assert.rejects(() => gitService.commit({ workspaceId: ws.workspaceId, owner: 'alice', message: 'x'.repeat(201) }), (e) => e.code === 'INVALID_COMMIT_MESSAGE');
        const ok = await gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['new.txt'] });
        assert.equal(ok.ok, true);
        const c = await gitService.commit({ workspaceId: ws.workspaceId, owner: 'alice', message: 'x'.repeat(200) });
        assert.equal(c.ok, true);
    });
    it('19 arbitrary command rejected at tool boundary', async () => {
        const ws = await makeRepo('alice');
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('git_status', { workspaceId: ws.workspaceId, command: 'push origin main' }, actx()), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('git_status', { workspaceId: ws.workspaceId, executable: 'git' }, actx()), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('git_status', { workspaceId: ws.workspaceId, args: ['push'] }, actx()), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('20 arbitrary cwd rejected at tool boundary', async () => {
        const ws = await makeRepo('alice');
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('git_status', { workspaceId: ws.workspaceId, cwd: '..' }, actx()), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('git_status', { workspaceId: ws.workspaceId, rootPath: ws.rootPath }, actx()), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('21 env rejected at tool boundary', async () => {
        const ws = await makeRepo('alice');
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('git_status', { workspaceId: ws.workspaceId, env: { EVIL: '1' } }, actx()), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('22-25 push/reset/clean/checkout have no API surface', async () => {
        for (const name of ['push', 'pull', 'fetch', 'reset', 'clean', 'checkout', 'restore', 'merge', 'rebase', 'run', 'executeRaw']) {
            assert.equal(gitService[name], undefined, `gitService.${name} must not exist`);
            assert.equal(toolRegistry.get(`git_${name}`), null, `tool git_${name} must not exist`);
        }
        registerNativeTools(toolRegistry);
        const names = toolRegistry.list().map((t) => t.name);
        for (const forbidden of ['git_push', 'git_reset', 'git_clean', 'git_checkout', 'git_merge', 'git_rebase']) {
            assert.ok(!names.includes(forbidden), `${forbidden} must not be registered`);
        }
    });
});

describe('P3-5 runtime propagation (stub commandService)', () => {
    it('26 commandService delegation (fixed git shape)', async () => {
        const ws = await makeRepo('alice');
        const stub = stubCmd(async () => ({ ...okOut, stdout: 'main\n' }));
        const c = new AbortController();
        const out = await gitService.branch({ workspaceId: ws.workspaceId, owner: 'alice', timeoutMs: 7000, signal: c.signal, commandService: stub });
        assert.equal(out.branch, 'main');
        assert.equal(stub.calls.length, 1);
        assert.equal(stub.calls[0].executable, 'git');
        assert.deepEqual(stub.calls[0].args, ['branch', '--show-current']);
        assert.equal(stub.calls[0].cwd, null);
        assert.equal(stub.calls[0].timeoutMs, 7000);
        assert.equal(stub.calls[0].signal, c.signal);
        assert.equal(stub.calls[0].env, undefined);
    });
    it('26b add/commit fixed shapes', async () => {
        const ws = await makeRepo('alice');
        const stub = stubCmd(async () => okOut);
        await gitService.add({ workspaceId: ws.workspaceId, owner: 'alice', paths: ['new.txt'], commandService: stub });
        assert.deepEqual(stub.calls[0].args, ['add', '--', 'new.txt']);
        await gitService.commit({ workspaceId: ws.workspaceId, owner: 'alice', message: 'hello world', commandService: stub });
        assert.deepEqual(stub.calls[1].args, ['commit', '-m', 'hello world']);
        await gitService.log({ workspaceId: ws.workspaceId, owner: 'alice', limit: 5, commandService: stub });
        assert.deepEqual(stub.calls[2].args, ['log', '--oneline', '-n', '5']);
    });
    it('27 timeout propagation', async () => {
        const ws = await makeRepo('alice');
        const stub = stubCmd(async () => { throw Object.assign(new Error('t'), { code: 'TIMEOUT' }); });
        const out = await gitService.status({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.code, 'TIMEOUT');
        assert.equal(out.timedOut, true);
    });
    it('28 abort propagation (never swallowed)', async () => {
        const ws = await makeRepo('alice');
        const stub = stubCmd(async () => { throw Object.assign(new Error('a'), { code: 'ABORTED' }); });
        await assert.rejects(() => gitService.status({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub }), (e) => e.code === 'ABORTED');
        const c = new AbortController();
        c.abort();
        await assert.rejects(() => gitService.status({ workspaceId: ws.workspaceId, owner: 'alice', signal: c.signal, commandService: stub }), (e) => e.code === 'ABORTED');
    });
    it('29 output truncation propagation', async () => {
        const ws = await makeRepo('alice');
        const stub = stubCmd(async () => ({ ...okOut, stdout: 'x', stdoutTruncated: true }));
        const out = await gitService.diff({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.truncated, true);
    });
    it('30 non-zero git exit normalized, not thrown', async () => {
        const ws = await makeRepo('alice');
        const notRepo = stubCmd(async () => ({ ...okOut, ok: false, exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }));
        const r1 = await gitService.status({ workspaceId: ws.workspaceId, owner: 'alice', commandService: notRepo });
        assert.equal(r1.ok, false);
        assert.equal(r1.code, 'GIT_NOT_REPOSITORY');
        const failed = stubCmd(async () => ({ ...okOut, ok: false, exitCode: 1, stderr: 'boom' }));
        const r2 = await gitService.commit({ workspaceId: ws.workspaceId, owner: 'alice', message: 'msg here', commandService: failed });
        assert.equal(r2.ok, false);
        assert.equal(r2.code, 'GIT_FAILED');
    });
});

describe('P3-5 permission boundary', () => {
    it('31 read-only tools need no approval', async () => {
        registerNativeTools(toolRegistry);
        for (const name of ['git_status', 'git_diff', 'git_log', 'git_branch']) {
            const m = toolRegistry.describe(name);
            assert.equal(m.readOnly, true, name);
            assert.equal(m.needsApproval, false, name);
        }
        const ws = await makeRepo('alice');
        const out = await toolRegistry.execute('git_status', { workspaceId: ws.workspaceId }, { owner: 'alice' });
        assert.ok(out.mcpTools.includes('git_status'));
        assert.equal(out.result.operation, 'status');
    });
    it('32 git_add requires approval', async () => {
        registerNativeTools(toolRegistry);
        const m = toolRegistry.describe('git_add');
        assert.equal(m.needsApproval, true);
        assert.deepEqual(m.capabilities, ['git.add']);
        const ws = await makeRepo('alice');
        await assert.rejects(() => toolRegistry.execute('git_add', { workspaceId: ws.workspaceId, paths: ['new.txt'] }, { owner: 'alice' }), (e) => e.code === 'PERMISSION_REQUIRED');
        const out = await toolRegistry.execute('git_add', { workspaceId: ws.workspaceId, paths: ['new.txt'] }, actx());
        assert.equal(out.result.ok, true);
    });
    it('33 git_commit requires approval', async () => {
        registerNativeTools(toolRegistry);
        const m = toolRegistry.describe('git_commit');
        assert.equal(m.needsApproval, true);
        assert.deepEqual(m.capabilities, ['git.commit']);
        const ws = await makeRepo('alice');
        await assert.rejects(() => toolRegistry.execute('git_commit', { workspaceId: ws.workspaceId, message: 'x' }, { owner: 'alice' }), (e) => e.code === 'PERMISSION_REQUIRED');
    });
});
