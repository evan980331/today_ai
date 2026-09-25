// P2-E: read-only Filesystem Native Tools tests.
// Uses a temporary WORKSPACE_ROOT only — never real user files.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const fsTools = require('../src/services/tools/filesystem');
const fsClient = require('../src/services/filesystem/client');
const core = require('../src/agent/core');

let ROOT = null;
let SAVED_WORKSPACE_ROOT;

before(async () => {
    SAVED_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-fs-test-'));
    process.env.WORKSPACE_ROOT = ROOT;
    await fsp.writeFile(path.join(ROOT, 'hello.txt'), 'hello world');
    await fsp.writeFile(path.join(ROOT, 'big.txt'), 'x'.repeat(500));
    await fsp.writeFile(path.join(ROOT, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x28]));
    await fsp.mkdir(path.join(ROOT, 'sub'));
    await fsp.writeFile(path.join(ROOT, 'sub', 'nested.txt'), 'nested');
    await fsp.mkdir(path.join(ROOT, 'empty'));
    try {
        await fsp.symlink(os.tmpdir(), path.join(ROOT, 'link-out'));
    } catch { /* symlink privilege missing -> related test skips */ }
    try {
        await fsp.symlink(path.join(ROOT, 'sub'), path.join(ROOT, 'link-in'));
    } catch { /* same */ }
});

after(async () => {
    if (SAVED_WORKSPACE_ROOT === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = SAVED_WORKSPACE_ROOT;
    if (ROOT) await fsp.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    toolRegistry._clearForTests();
});

function hasLink(name) {
    return fs.existsSync(path.join(ROOT, name));
}

describe('P2-E metadata + registration', () => {
    it('17/18 readOnly=true needsApproval=false, frozen', () => {
        for (const t of [fsTools.filesystemRead, fsTools.filesystemList]) {
            assert.equal(t.readOnly, true);
            assert.equal(t.needsApproval, false);
            assert.ok(Object.isFrozen(t));
            assert.ok(t.inputSchema && typeof t.inputSchema === 'object');
        }
        assert.equal(fsTools.filesystemRead.name, 'filesystem.read');
        assert.equal(fsTools.filesystemList.name, 'filesystem.list');
    });
    it('19 registry registration, idempotent', () => {
        const r1 = registerNativeTools(toolRegistry);
        assert.ok(r1.registered.includes('filesystem.read'));
        assert.ok(r1.registered.includes('filesystem.list'));
        assert.equal(toolRegistry.list().length, 13);
        const r2 = registerNativeTools(toolRegistry);
        assert.deepEqual(r2.registered, []);
    });
});

describe('P2-E filesystem.read', () => {
    it('1 normal read', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.read', { path: 'hello.txt' });
        assert.equal(out.result.content, 'hello world');
        assert.equal(out.result.path, 'hello.txt');
        assert.equal(out.result.truncated, false);
        assert.ok(out.mcpTools.includes('filesystem.read'));
    });
    it('2 string shorthand', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.read', 'hello.txt');
        assert.equal(out.result.content, 'hello world');
    });
    it('5 ../ traversal blocked', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: '../x' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'sub/../../x' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
    });
    it('6 absolute path escape blocked', async () => {
        registerNativeTools(toolRegistry);
        const outside = path.join(path.dirname(ROOT), 'definitely-outside.txt');
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: outside }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
    });
    it('7 normalized + encoded traversal blocked', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'sub/../..' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: '%2e%2e/secret' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'sub%2f..%2fx' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
    });
    it('8 symlink escape blocked', async () => {
        if (!hasLink('link-out')) return; // symlink creation not permitted here
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'link-out' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION' || e.code === 'FILESYSTEM_NOT_DIRECTORY');
    });
    it('9 null byte blocked', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'a\0b' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
    });
    it('10 nonexistent file', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'nope.txt' }), (e) => e.code === 'FILESYSTEM_NOT_FOUND');
    });
    it('12 read directory as file', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'sub' }), (e) => e.code === 'FILESYSTEM_NOT_DIRECTORY');
    });
    it('15 maxBytes enforced + validated', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'big.txt', maxBytes: 10 }), (e) => e.code === 'FILESYSTEM_TOO_LARGE');
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'hello.txt', maxBytes: 0 }), (e) => e.code === 'TOOL_INVALID_INPUT');
        const out = await toolRegistry.execute('filesystem.read', { path: 'big.txt', maxBytes: 500 });
        assert.equal(out.result.content.length, 500);
    });
    it('binary file is not blindly decoded', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'binary.bin' }), (e) => e.code === 'FILESYSTEM_INVALID_INPUT');
    });
    it('16 output never exposes workspace root', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.read', { path: 'hello.txt' });
        assert.ok(!JSON.stringify(out).includes(ROOT));
    });
});

describe('P2-E filesystem.list', () => {
    it('3 list directory', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.list', { path: 'sub' });
        assert.equal(out.result.path, 'sub');
        assert.deepEqual(out.result.entries, [{ name: 'nested.txt', type: 'file' }]);
        assert.ok(out.mcpTools.includes('filesystem.list'));
    });
    it('4 string shorthand + root forms', async () => {
        registerNativeTools(toolRegistry);
        const viaStr = await toolRegistry.execute('filesystem.list', 'sub');
        assert.deepEqual(viaStr.result.entries, [{ name: 'nested.txt', type: 'file' }]);
        for (const rootForm of [undefined, '', '.', {}]) {
            const out = await toolRegistry.execute('filesystem.list', rootForm);
            assert.equal(out.result.path, '.');
            const names = out.result.entries.map((e) => e.name);
            assert.ok(names.includes('hello.txt') && names.includes('sub'));
            assert.ok(out.result.entries.every((e) => e.type === 'file' || e.type === 'directory' || e.type === 'symlink' || e.type === 'other'));
            assert.ok(!JSON.stringify(out).includes(ROOT));
        }
    });
    it('8b symlink outside root is never followed for listing', async () => {
        if (!hasLink('link-out')) return;
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.list', { path: 'link-out' }), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION' || e.code === 'FILESYSTEM_NOT_FOUND');
    });
    it('11 nonexistent directory', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.list', { path: 'nope-dir' }), (e) => e.code === 'FILESYSTEM_NOT_FOUND');
    });
    it('13 list file as directory', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.list', { path: 'hello.txt' }), (e) => e.code === 'FILESYSTEM_NOT_DIRECTORY');
    });
    it('14 permission/error normalization (mapper unit)', () => {
        assert.throws(() => fsClient.mapFsError(Object.assign(new Error('x'), { code: 'EACCES' }), 'f', 'read'), (e) => e.code === 'FILESYSTEM_PERMISSION_DENIED');
        assert.throws(() => fsClient.mapFsError(Object.assign(new Error('x'), { code: 'ENOENT' }), 'f', 'read'), (e) => e.code === 'FILESYSTEM_NOT_FOUND');
        assert.throws(() => fsClient.mapFsError(Object.assign(new Error('boom /secret/root/x'), { code: 'EIO' }), 'f', 'read'), (e) => !e.message.includes('/secret/root'));
    });
});

describe('P2-E core path + abort/timeout + leakage', () => {
    it('20 Core → Planner → Registry → Filesystem', async () => {
        registerNativeTools(toolRegistry);
        const l = await core.run({ id: 'fs1', prompt: '', sessionId: 's', tools: ['filesystem.list'] }, {});
        assert.ok(l.result.entries.some((e) => e.name === 'hello.txt'));
        const r = await core.run({ id: 'fs2', prompt: 'hello.txt', sessionId: 's', tools: ['filesystem.read'] }, {});
        assert.equal(r.result.content, 'hello world');
        assert.ok(!JSON.stringify(r).includes(ROOT));
    });
    it('21 abort (already-aborted signal)', async () => {
        registerNativeTools(toolRegistry);
        const c = new AbortController();
        c.abort();
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: 'hello.txt' }, { signal: c.signal }), (e) => e.code === 'ABORTED');
        await assert.rejects(() => toolRegistry.execute('filesystem.list', {}, { signal: c.signal }), (e) => e.code === 'ABORTED');
    });
    it('22 timeout (registry boundary, hanging fs op)', async () => {
        const fspMod = require('node:fs/promises');
        const orig = fspMod.readdir;
        fspMod.readdir = async () => new Promise(() => {});
        try {
            registerNativeTools(toolRegistry);
            await assert.rejects(() => toolRegistry.execute('filesystem.list', {}, { timeoutMs: 30 }), (e) => e.code === 'TIMEOUT');
        } finally {
            fspMod.readdir = orig;
        }
    });
    it('23 no credential/path leakage in errors', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.read', { path: '../x' }), (e) => {
            assert.ok(!JSON.stringify({ m: e.message }).includes(ROOT));
            return e.code === 'FILESYSTEM_SANDBOX_VIOLATION';
        });
    });
});
