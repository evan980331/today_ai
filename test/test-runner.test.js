// P3-4 Test Runner tests. Temp fixture workspaces + injected stub
// commandService only — never touches the real repo, never spawns.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const testRunnerService = require('../src/services/testRunnerService');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p34-test-${Date.now()}-${(n += 1)}`;
const APPROVED = { approval: { status: 'approved' } };

async function writeFixture(root, rel, content) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
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

const passResult = { ok: true, exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 5 };

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-testrunner-'));
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

async function makeWorkspace(owner = 'alice', files = {}) {
    const ws = await WorkspaceService.default().create({ sessionId: sid(), owner });
    for (const [rel, content] of Object.entries(files)) {
        await writeFixture(ws.rootPath, rel, content);
    }
    return ws;
}

describe('P3-4 detection + result mapping', () => {
    it('Node project with scripts.test -> npm test, TEST_PASS', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'node x.js' } }) });
        const stub = stubCmd(async () => passResult);
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.ok, true);
        assert.equal(out.code, 'TEST_PASS');
        assert.deepEqual(out.command, { executable: 'npm', args: ['test'] });
        assert.equal(stub.calls.length, 1);
        assert.equal(stub.calls[0].executable, 'npm');
    });
    it('Node project without test script -> NO_TEST_COMMAND, no spawn', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { build: 'x' } }) });
        const stub = stubCmd(async () => passResult);
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'NO_TEST_COMMAND');
        assert.equal(out.command, null);
        assert.equal(stub.calls.length, 0);
    });
    it('Python + pytest marker -> python -m pytest', async () => {
        const ws = await makeWorkspace('alice', { 'pytest.ini': '[pytest]\n', 'tests/test_a.py': 'def test_x(): pass\n' });
        const stub = stubCmd(async () => passResult);
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.deepEqual(out.command, { executable: 'python', args: ['-m', 'pytest'] });
        assert.equal(out.code, 'TEST_PASS');
    });
    it('Python unittest fallback (tests/ plain) -> discover', async () => {
        const ws = await makeWorkspace('alice', { 'tests/helper.py': 'x=1\n' });
        const stub = stubCmd(async () => passResult);
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.deepEqual(out.command, { executable: 'python', args: ['-m', 'unittest', 'discover', '-s', 'tests', '-v'] });
    });
    it('unsupported project -> NO_TEST_COMMAND', async () => {
        const ws = await makeWorkspace('alice', { 'README.md': 'hi' });
        const stub = stubCmd(async () => passResult);
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.code, 'NO_TEST_COMMAND');
        assert.equal(stub.calls.length, 0);
    });
    it('non-zero exit -> TEST_FAILED with exitCode', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => ({ ...passResult, ok: false, exitCode: 1, stdout: '', stderr: 'fail' }));
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.ok, false);
        assert.equal(out.code, 'TEST_FAILED');
        assert.equal(out.exitCode, 1);
    });
});

describe('P3-4 security + isolation', () => {
    it('workspace ownership isolation (cross-owner 404)', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => passResult);
        await assert.rejects(() => testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'bob', commandService: stub }));
        assert.equal(stub.calls.length, 0);
    });
    it('owner missing rejected', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => passResult);
        await assert.rejects(() => testRunnerService.run({ workspaceId: ws.workspaceId, owner: '', commandService: stub }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('no arbitrary command input (extra fields throw)', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('test_runner', { workspaceId: ws.workspaceId, executable: 'rm' }, { owner: 'alice', ...APPROVED }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('test_runner', { workspaceId: ws.workspaceId, env: { A: '1' } }, { owner: 'alice', ...APPROVED }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('test_runner', { workspaceId: ws.workspaceId, cwd: '..' }, { owner: 'alice', ...APPROVED }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('test_runner', { workspaceId: ws.workspaceId, rootPath: '/tmp' }, { owner: 'alice', ...APPROVED }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('no absolute path leakage, no env leakage', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => passResult);
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        const text = JSON.stringify(out);
        assert.ok(!text.includes(ws.rootPath));
        assert.ok(!('env' in out));
        assert.ok(!text.includes('DATABASE_URL'));
    });
});

describe('P3-4 propagation', () => {
    it('commandService integration: timeout/args/signal forwarded', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => passResult);
        const c = new AbortController();
        await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', timeoutMs: 5000, signal: c.signal, commandService: stub });
        assert.equal(stub.calls[0].timeoutMs, 5000);
        assert.equal(stub.calls[0].signal, c.signal);
        assert.equal(stub.calls[0].owner, 'alice');
        assert.equal(stub.calls[0].env, undefined);
    });
    it('timeout maps to TIMEOUT code', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => { throw Object.assign(new Error('t'), { code: 'TIMEOUT' }); });
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.code, 'TIMEOUT');
        assert.equal(out.timedOut, true);
    });
    it('abort propagates (never swallowed)', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => { throw Object.assign(new Error('a'), { code: 'ABORTED' }); });
        await assert.rejects(() => testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub }), (e) => e.code === 'ABORTED');
        const c = new AbortController();
        c.abort();
        await assert.rejects(() => testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', signal: c.signal, commandService: stub }), (e) => e.code === 'ABORTED');
    });
    it('output truncation propagation', async () => {
        const ws = await makeWorkspace('alice', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
        const stub = stubCmd(async () => ({ ...passResult, stdoutTruncated: true }));
        const out = await testRunnerService.run({ workspaceId: ws.workspaceId, owner: 'alice', commandService: stub });
        assert.equal(out.truncated, true);
    });
    it('tool contract: needsApproval, capability, activity shape', async () => {
        registerNativeTools(toolRegistry);
        const m = toolRegistry.describe('test_runner');
        assert.equal(m.readOnly, false);
        assert.equal(m.needsApproval, true);
        assert.deepEqual(m.capabilities, ['test.run']);
        const ws = await makeWorkspace('alice', { 'README.md': 'x' });
        const out = await toolRegistry.execute('test_runner', { workspaceId: ws.workspaceId }, { owner: 'alice', ...APPROVED });
        assert.ok(out.mcpTools.includes('test_runner'));
        assert.equal(out.result.code, 'NO_TEST_COMMAND');
    });
});
