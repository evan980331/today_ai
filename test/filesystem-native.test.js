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
    await fsp.mkdir(path.join(ROOT, 'many'));
    for (let i = 0; i < 12; i += 1) {
        await fsp.writeFile(path.join(ROOT, 'many', `f${i}.txt`), 'x');
    }
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
        assert.equal(toolRegistry.list().length, 15);
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

describe('P2-F filesystem.list maxEntries', () => {
    it('17 default maxEntries (no truncation on small dirs)', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.list', { path: 'sub' });
        assert.equal(out.result.truncated, false);
        assert.equal(out.result.entries.length, 1);
    });
    it('18 custom maxEntries', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.list', { path: 'many', maxEntries: 12 });
        assert.equal(out.result.truncated, false);
        assert.equal(out.result.entries.length, 12);
        await assert.rejects(() => toolRegistry.execute('filesystem.list', { path: 'many', maxEntries: 0 }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('filesystem.list', { path: 'many', maxEntries: 5001 }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
    it('19 maxEntries truncation', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.list', { path: 'many', maxEntries: 5 });
        assert.equal(out.result.truncated, true);
        assert.equal(out.result.entries.length, 5);
    });
    it('20 truncated list never leaks root', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.list', { path: 'many', maxEntries: 3 });
        assert.ok(!JSON.stringify(out).includes(ROOT));
        assert.equal(out.result.path, 'many');
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

const APPROVED = { approval: { status: 'approved' } };

describe('P2-H filesystem.write', () => {
    it('1 write new file', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.write', { path: 'new.txt', content: 'hi' }, APPROVED);
        assert.equal(out.result.path, 'new.txt');
        assert.equal(out.result.created, true);
        assert.ok(out.mcpTools.includes('filesystem.write'));
        assert.equal(await fsp.readFile(path.join(ROOT, 'new.txt'), 'utf8'), 'hi');
    });
    it('2 overwrite existing file', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.write', { path: 'hello.txt', content: 'v2' }, APPROVED);
        assert.equal(out.result.created, false);
        assert.equal(await fsp.readFile(path.join(ROOT, 'hello.txt'), 'utf8'), 'v2');
    });
    it('3 UTF-8 Chinese content', async () => {
        registerNativeTools(toolRegistry);
        await toolRegistry.execute('filesystem.write', { path: 'zh.txt', content: '你好世界' }, APPROVED);
        assert.equal(await fsp.readFile(path.join(ROOT, 'zh.txt'), 'utf8'), '你好世界');
    });
    it('4 empty content', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.write', { path: 'empty.txt', content: '' }, APPROVED);
        assert.equal(out.result.bytes, 0);
        assert.equal(await fsp.readFile(path.join(ROOT, 'empty.txt'), 'utf8'), '');
    });
    it('5/6 nested path with parent creation', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.write', { path: 'a/b/c.txt', content: 'deep' }, APPROVED);
        assert.equal(out.result.path, 'a/b/c.txt');
        assert.equal(await fsp.readFile(path.join(ROOT, 'a', 'b', 'c.txt'), 'utf8'), 'deep');
    });
    it('write rejects non-string content (no buffer/base64 bypass)', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'x.txt', content: 123 }, APPROVED), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'x.txt' }, APPROVED), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('filesystem.write', 'justastring', APPROVED), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
});

describe('P2-H filesystem.createDirectory', () => {
    it('7 create directory', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.createDirectory', { path: 'nd' }, APPROVED);
        assert.equal(out.result.created, true);
        assert.ok(out.mcpTools.includes('filesystem.createDirectory'));
        assert.ok((await fsp.stat(path.join(ROOT, 'nd'))).isDirectory());
    });
    it('8 nested directory', async () => {
        registerNativeTools(toolRegistry);
        await toolRegistry.execute('filesystem.createDirectory', { path: 'n1/n2/n3' }, APPROVED);
        assert.ok((await fsp.stat(path.join(ROOT, 'n1', 'n2', 'n3'))).isDirectory());
    });
    it('9 existing directory is idempotent', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.createDirectory', { path: 'sub' }, APPROVED);
        assert.equal(out.result.created, false);
    });
    it('10 existing file errors', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.createDirectory', { path: 'hello.txt' }, APPROVED), (e) => e.code === 'FILESYSTEM_ALREADY_EXISTS');
    });
});

describe('P2-H write sandbox security', () => {
    it('11/12 traversal + absolute escape blocked (write + mkdir)', async () => {
        registerNativeTools(toolRegistry);
        for (const tool of ['filesystem.write', 'filesystem.createDirectory']) {
            const input = tool === 'filesystem.write' ? { path: '../evil.txt', content: 'x' } : { path: '../evil' };
            await assert.rejects(() => toolRegistry.execute(tool, input, APPROVED), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION', tool);
            const abs = tool === 'filesystem.write' ? { path: path.join(path.dirname(ROOT), 'evil.txt'), content: 'x' } : { path: path.join(path.dirname(ROOT), 'evil') };
            await assert.rejects(() => toolRegistry.execute(tool, abs, APPROVED), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION', tool);
        }
    });
    it('13 encoded traversal blocked', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: '%2e%2e/evil.txt', content: 'x' }, APPROVED), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
    });
    it('14 null byte blocked', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'a\0b', content: 'x' }, APPROVED), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
    });
    it('15/16 symlink + parent symlink escape blocked', async () => {
        if (!hasLink('link-out')) return;
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'link-out/evil.txt', content: 'x' }, APPROVED), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
        await assert.rejects(() => toolRegistry.execute('filesystem.createDirectory', { path: 'link-out/evil' }, APPROVED), (e) => e.code === 'FILESYSTEM_SANDBOX_VIOLATION');
        assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'evil.txt')));
    });
    it('17/18/19 failures normalized without absolute paths', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'sub', content: 'x' }, APPROVED), (e) => {
            assert.ok(!e.message.includes(ROOT));
            return e.code === 'FILESYSTEM_ALREADY_EXISTS';
        });
        await assert.rejects(() => toolRegistry.execute('filesystem.createDirectory', { path: '../x' }, APPROVED), (e) => {
            assert.ok(!e.message.includes(ROOT));
            return e.code === 'FILESYSTEM_SANDBOX_VIOLATION';
        });
    });
});

describe('P2-H write permission', () => {
    it('20/21 write without/pending approval -> PERMISSION_REQUIRED, nothing written', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'p1.txt', content: 'x' }), (e) => e.code === 'PERMISSION_REQUIRED');
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'p1.txt', content: 'x' }, { approval: { status: 'pending' } }), (e) => e.code === 'PERMISSION_REQUIRED');
        assert.ok(!fs.existsSync(path.join(ROOT, 'p1.txt')));
    });
    it('22 write rejected -> PERMISSION_DENIED', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.write', { path: 'p2.txt', content: 'x' }, { approval: { status: 'rejected' } }), (e) => e.code === 'PERMISSION_DENIED');
        assert.ok(!fs.existsSync(path.join(ROOT, 'p2.txt')));
    });
    it('23 write approved executes once', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('filesystem.write', { path: 'p3.txt', content: 'ok' }, APPROVED);
        assert.equal(out.result.bytes, 2);
        assert.equal(await fsp.readFile(path.join(ROOT, 'p3.txt'), 'utf8'), 'ok');
    });
    it('24/25 mkdir without approval -> REQUIRED; approved executes', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('filesystem.createDirectory', { path: 'pd' }), (e) => e.code === 'PERMISSION_REQUIRED');
        assert.ok(!fs.existsSync(path.join(ROOT, 'pd')));
        const out = await toolRegistry.execute('filesystem.createDirectory', { path: 'pd' }, APPROVED);
        assert.equal(out.result.created, true);
    });
    it('26 permission errors do not retry via core', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => core.run({ id: 'pw1', prompt: 'x', sessionId: 's', tools: ['filesystem.write'] }, {}), (e) => e.code === 'PERMISSION_REQUIRED');
        assert.equal(core.isRetryable(Object.assign(new Error('x'), { code: 'PERMISSION_REQUIRED', status: 400 })), false);
        assert.ok(!fs.existsSync(path.join(ROOT, 'x')));
    });
});

describe('P2-H write tool metadata', () => {
    it('27 filesystem.write readOnly=false needsApproval=true', () => {
        assert.equal(fsTools.filesystemWrite.readOnly, false);
        assert.equal(fsTools.filesystemWrite.needsApproval, true);
        assert.deepEqual(fsTools.filesystemWrite.capabilities, ['filesystem.write']);
        assert.ok(Object.isFrozen(fsTools.filesystemWrite));
    });
    it('28 filesystem.createDirectory readOnly=false needsApproval=true', () => {
        assert.equal(fsTools.filesystemCreateDirectory.readOnly, false);
        assert.equal(fsTools.filesystemCreateDirectory.needsApproval, true);
        assert.deepEqual(fsTools.filesystemCreateDirectory.capabilities, ['filesystem.write', 'filesystem.createDirectory']);
        assert.ok(Object.isFrozen(fsTools.filesystemCreateDirectory));
    });
    it('read/list stay read-only with no approval', () => {
        assert.equal(fsTools.filesystemRead.readOnly, true);
        assert.equal(fsTools.filesystemRead.needsApproval, false);
        assert.equal(fsTools.filesystemList.readOnly, true);
        assert.equal(fsTools.filesystemList.needsApproval, false);
    });
});
