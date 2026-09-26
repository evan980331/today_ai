// P3-3 command execution tests. Real processes, safe commands only
// (node/git --version, fixture scripts inside a temp workspace).
// No shell strings, no destructive commands, no real credentials.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const commandService = require('../src/services/commandService');
const policy = require('../src/services/commandPolicy');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p33-test-${Date.now()}-${(n += 1)}`;
const APPROVED = { approval: { status: 'approved' } };
const actx = (extra = {}) => ({ owner: 'alice', ...APPROVED, ...extra });

async function writeFixture(root, rel, content) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
}

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-cmd-test-'));
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

async function makeWorkspace(files = {}) {
    const ws = await WorkspaceService.default().create({ sessionId: sid(), owner: 'alice' });
    for (const [rel, content] of Object.entries(files)) {
        await writeFixture(ws.rootPath, rel, content);
    }
    return ws;
}

async function runTool(input, ctx) {
    registerNativeTools(toolRegistry);
    return toolRegistry.execute('command_execute', input, ctx);
}

describe('P3-3 policy', () => {
    it('11 command policy allowed executables', () => {
        for (const exe of ['node', 'npm', 'npx', 'git', 'python', 'pytest', 'NODE', 'Git.exe']) {
            assert.ok(policy.validateExecutable(exe).canonical, exe);
        }
    });
    it('12 dangerous executables rejected', () => {
        for (const exe of ['powershell', 'pwsh', 'cmd', 'shutdown', 'format', 'curl', 'wget', 'taskkill', 'reg', 'mshta', 'rundll32', 'C:\\Windows\\cmd.exe', '../bin/x', '']) {
            assert.throws(() => policy.validateExecutable(exe), (e) => e.code === 'TOOL_INVALID_INPUT', exe);
        }
    });
    it('13 command chaining rejected', () => {
        for (const a of ['a;b', 'a&&b', 'a||b', 'a|b', '$(x)', '`x`']) {
            assert.throws(() => policy.validateArgs([a]), (e) => e.code === 'TOOL_INVALID_INPUT', a);
        }
    });
    it('14 redirection rejected', () => {
        for (const a of ['>x', '>>x', '<x', '2>x']) {
            assert.throws(() => policy.validateArgs([a]), (e) => e.code === 'TOOL_INVALID_INPUT', a);
        }
    });
    it('15 shell injection rejected', () => {
        for (const a of ['%TEMP%', '$env:X', '~/.x', '"q"', "'q'", 'a\nb', 'a\0b', 'a*b', 'a?b']) {
            assert.throws(() => policy.validateArgs([a]), (e) => e.code === 'TOOL_INVALID_INPUT', JSON.stringify(a));
        }
    });
});

describe('P3-3 service execution', () => {
    it('1 basic allowed command (node --version)', async () => {
        const ws = await makeWorkspace();
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['--version'] });
        assert.equal(out.ok, true);
        assert.equal(out.exitCode, 0);
        assert.ok(/^v\d+\./.test(out.stdout.trim()));
        assert.equal(out.timedOut, false);
        assert.ok(typeof out.durationMs === 'number');
    });
    it('fixture script runs in workspace root cwd', async () => {
        const ws = await makeWorkspace({ 'fixture.js': 'console.log("hi-" + process.cwd().length);' });
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['fixture.js'] });
        assert.equal(out.ok, true);
        assert.ok(out.stdout.startsWith('hi-'));
    });
    it('2 default cwd is the workspace root', async () => {
        const ws = await makeWorkspace({ 'sub/f.js': 'console.log(require("fs").readdirSync(".").join(","));' });
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['sub/f.js'] });
        assert.ok(out.stdout.includes('sub'));
    });
    it('3 relative cwd accepted', async () => {
        const ws = await makeWorkspace({ 'sub/f.js': 'console.log(process.cwd().endsWith("sub"));' });
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['f.js'], cwd: 'sub' });
        assert.ok(out.stdout.includes('true'));
    });
    it('4 cwd traversal rejection', async () => {
        const ws = await makeWorkspace();
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['--version'], cwd: '../x' }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('5 absolute outside cwd rejection', async () => {
        const ws = await makeWorkspace();
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['--version'], cwd: os.tmpdir() }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('6 symlink escape rejection', async () => {
        const ws = await makeWorkspace({ 'sub/f.js': '1' });
        const link = path.join(ws.rootPath, 'link-out');
        try {
            await fsp.symlink(os.tmpdir(), link);
        } catch {
            return;
        }
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['--version'], cwd: 'link-out' }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('7 workspace isolation (session scoping)', async () => {
        const a = await makeWorkspace();
        const b = await makeWorkspace();
        assert.notEqual(a.workspaceId, b.workspaceId);
        const out = await commandService.execute({ sessionId: a.sessionId, owner: 'alice', executable: 'node', args: ['--version'] });
        assert.equal(out.ok, true);
    });
    it('8 cross-owner rejection', async () => {
        const ws = await makeWorkspace();
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'bob', executable: 'node', args: ['--version'] }));
    });
    it('9 missing owner rejection', async () => {
        const ws = await makeWorkspace();
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: '', executable: 'node', args: ['--version'] }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('10 invalid workspace rejection', async () => {
        await assert.rejects(() => commandService.execute({ workspaceId: 'ws_deadbeefdeadbeef', owner: 'alice', executable: 'node', args: ['--version'] }));
        await assert.rejects(() => commandService.execute({ owner: 'alice', executable: 'node', args: ['--version'] }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('16 environment injection rejection', async () => {
        const ws = await makeWorkspace();
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['--version'], env: { EVIL: '1' } }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('secrets never reach child env', async () => {
        const ws = await makeWorkspace({ 'e.js': 'console.log(JSON.stringify(Object.keys(process.env).filter(k=>/TOKEN|SECRET|PASSWORD|DATABASE_URL/i.test(k))));' });
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['e.js'] });
        assert.equal(out.stdout.trim(), '[]');
    });
    it('19 output limit defaults (64KB caps)', async () => {
        const ws = await makeWorkspace({ 'big.js': 'console.log("x".repeat(200000)); console.error("e".repeat(200000));' });
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['big.js'] });
        assert.equal(out.ok, true);
        assert.ok(Buffer.byteLength(out.stdout, 'utf8') <= 64 * 1024);
        assert.ok(Buffer.byteLength(out.stderr, 'utf8') <= 64 * 1024);
    });
    it('20/21 stdout+stderr truncation flags', async () => {
        const ws = await makeWorkspace({ 'big.js': 'console.log("x".repeat(200000)); console.error("e".repeat(200000));' });
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['big.js'] });
        assert.equal(out.stdoutTruncated, true);
        assert.equal(out.stderrTruncated, true);
    });
    it('22/23 exit code propagation + non-zero', async () => {
        const ws = await makeWorkspace({ 'exit3.js': 'process.exit(3);' });
        const out = await commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['exit3.js'] });
        assert.equal(out.ok, false);
        assert.equal(out.exitCode, 3);
    });
    it('17 default timeout is finite (30s)', async () => {
        const { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, resolveTimeout } = commandService;
        assert.equal(DEFAULT_TIMEOUT_MS, 30000);
        assert.equal(MAX_TIMEOUT_MS, 120000);
        assert.equal(resolveTimeout(null), 30000);
        assert.equal(resolveTimeout(0), 30000);
        assert.equal(resolveTimeout(-5), 30000);
        assert.equal(resolveTimeout(9999999), 120000);
    });
    it('18 timeout termination (hanging process killed)', async () => {
        const ws = await makeWorkspace({ 'hang.js': 'setTimeout(()=>{},120000);' });
        const start = Date.now();
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['hang.js'], timeoutMs: 800 }), (e) => e.code === 'TIMEOUT');
        assert.ok(Date.now() - start < 30000, 'must not wait for the hang');
    });
    it('abort terminates the process', async () => {
        const ws = await makeWorkspace({ 'hang.js': 'setTimeout(()=>{},120000);' });
        const c = new AbortController();
        setTimeout(() => c.abort(), 200);
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['hang.js'], timeoutMs: 60000, signal: c.signal }), (e) => e.code === 'ABORTED');
    });
    it('path-like args contained (traversal arg rejected)', async () => {
        const ws = await makeWorkspace({ 'f.js': '1' });
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['../../x.js'] }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => commandService.execute({ workspaceId: ws.workspaceId, owner: 'alice', executable: 'node', args: ['C:\\Windows\\x.js'] }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
});

describe('P3-3 tool contract', () => {
    it('metadata: readOnly false, needsApproval true, capabilities', async () => {
        registerNativeTools(toolRegistry);
        const m = toolRegistry.describe('command_execute');
        assert.equal(m.readOnly, false);
        assert.equal(m.needsApproval, true);
        assert.deepEqual(m.capabilities, ['command.execute']);
        assert.equal(typeof m.execute, 'undefined');
    });
    it('24 registry execution returns mcpTools + activity result', async () => {
        const ws = await makeWorkspace();
        const out = await runTool({ workspaceId: ws.workspaceId, executable: 'node', args: ['--version'] }, actx());
        assert.ok(out.mcpTools.includes('command_execute'));
        assert.equal(out.result.ok, true);
        assert.equal(out.result.timedOut, false);
        assert.ok(typeof out.result.durationMs === 'number');
    });
    it('approval gate: missing/pending/rejected never spawn', async () => {
        const ws = await makeWorkspace({ 'spy.js': 'require("fs").writeFileSync("pwned.txt","x");' });
        const base = { workspaceId: ws.workspaceId, executable: 'node', args: ['spy.js'] };
        await assert.rejects(() => runTool(base, { owner: 'alice' }), (e) => e.code === 'PERMISSION_REQUIRED');
        await assert.rejects(() => runTool(base, { owner: 'alice', approval: { status: 'pending' } }), (e) => e.code === 'PERMISSION_REQUIRED');
        await assert.rejects(() => runTool(base, { owner: 'alice', approval: { status: 'rejected' } }), (e) => e.code === 'PERMISSION_DENIED');
        assert.ok(!fs.existsSync(path.join(ws.rootPath, 'pwned.txt')));
    });
    it('missing owner rejected', async () => {
        const ws = await makeWorkspace();
        await assert.rejects(() => runTool({ workspaceId: ws.workspaceId, executable: 'node', args: ['--version'] }, APPROVED), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
});
