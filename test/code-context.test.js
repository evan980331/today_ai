// P3-2 Code Context tests. Fixtures live in a temp WORKSPACE_ROOT only.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService, resetSharedMemoryForTests } = require('../src/services/workspaceService');
const { MemoryWorkspaceStore } = require('../src/services/workspaceStore');
const { buildContext, LIMITS, parsePackageJson, detectProjectType } = require('../src/services/codeContextService');
const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');

let ROOT = null;
let SAVED_ROOT;
let SAVED_DB_URL;
let n = 0;
const sid = () => `p32-test-${Date.now()}-${(n += 1)}`;

async function writeFixture(root, rel, content) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
}

before(async () => {
    SAVED_ROOT = process.env.WORKSPACE_ROOT;
    SAVED_DB_URL = process.env.DATABASE_URL;
    // Force the shared memory store so the tool's default service sees the
    // same workspaces the tests create. Restored afterwards.
    delete process.env.DATABASE_URL;
    ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'todayai-cc-test-'));
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

// Fixture project dir directly under the temp root (service-independent).
async function makeProject(files) {
    const dir = await fsp.mkdtemp(path.join(ROOT, 'proj-'));
    for (const [rel, content] of Object.entries(files)) {
        await writeFixture(dir, rel, content);
    }
    return { rootPath: dir };
}

// Workspace-backed fixture for tool tests (shared default service,
// which is the memory singleton while DATABASE_URL is unset above).
async function makeWorkspace(files, owner = 'alice') {
    const ws = await WorkspaceService.default().create({ sessionId: sid(), owner });
    for (const [rel, content] of Object.entries(files)) {
        await writeFixture(ws.rootPath, rel, content);
    }
    return ws;
}

const PKG = JSON.stringify({ name: 'demo', scripts: { test: 'node --test' }, dependencies: { express: '^4.0.0' }, devDependencies: { nodemon: '^3.0.0' } });

describe('P3-2 service basics', () => {
    it('1 builds basic project context', async () => {
        const { rootPath } = await makeProject({ 'package.json': PKG, 'src/index.js': 'hello' });
        const ctx = await buildContext(rootPath);
        assert.ok(ctx.project);
        assert.ok(Array.isArray(ctx.structure));
        assert.ok(Array.isArray(ctx.files));
        assert.equal(typeof ctx.truncated, 'boolean');
        assert.ok(ctx.limits);
    });
    it('2 workspace metadata carried by tool result', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWorkspace({});
        const out = await toolRegistry.execute('code_context', { sessionId: ws.sessionId }, { owner: 'alice' });
        assert.equal(out.result.workspace.sessionId, ws.sessionId);
        assert.equal(out.result.workspace.workspaceId, ws.workspaceId);
        assert.equal(out.result.workspace.status, 'active');
        assert.ok(out.mcpTools.includes('code_context'));
    });
    it('2b repository metadata passes through', async () => {
        registerNativeTools(toolRegistry);
        const repo = { provider: 'github', owner: 'o', name: 'r', ref: 'main' };
        const ws = await WorkspaceService.default().create({ sessionId: sid(), owner: 'alice', repository: repo });
        const out = await toolRegistry.execute('code_context', { sessionId: ws.sessionId }, { owner: 'alice' });
        assert.deepEqual(out.result.repository, repo);
    });
    it('3 project structure sorted with dirs and files', async () => {
        const { rootPath } = await makeProject({ 'b.js': '1', 'a.js': '2', 'sub/c.js': '3' });
        const ctx = await buildContext(rootPath);
        const paths = ctx.structure.map((e) => e.path);
        assert.deepEqual(paths, [...paths].sort());
        assert.ok(paths.includes('sub'));
        assert.ok(ctx.structure.find((e) => e.path === 'sub').type === 'directory');
        assert.ok(ctx.structure.find((e) => e.path === 'a.js').type === 'file');
    });
    it('4 package.json parsing', async () => {
        const { rootPath } = await makeProject({ 'package.json': PKG });
        const ctx = await buildContext(rootPath);
        assert.equal(ctx.project.type, 'node');
        assert.equal(ctx.project.package.name, 'demo');
        assert.deepEqual(ctx.project.package.scripts, { test: 'node --test' });
        assert.ok(ctx.project.package.dependencies.express);
        assert.ok(ctx.project.package.devDependencies.nodemon);
    });
    it('5 important files listed', async () => {
        const { rootPath } = await makeProject({ 'package.json': PKG, 'README.md': '# hi', 'src/x.js': '1' });
        const ctx = await buildContext(rootPath);
        assert.ok(ctx.importantFiles.includes('package.json'));
        assert.ok(ctx.importantFiles.includes('README.md'));
    });
    it('6 source selection includes content only for chosen files', async () => {
        const { rootPath } = await makeProject({ 'package.json': PKG, 'src/index.js': 'ENTRY', 'src/util.js': 'UTIL' });
        const ctx = await buildContext(rootPath, { maxFiles: 2 });
        assert.equal(ctx.files.length, 2);
        for (const f of ctx.files) {
            assert.ok(typeof f.path === 'string' && typeof f.language === 'string' && typeof f.content === 'string');
        }
    });
    it('7 relative paths only, no absolute root', async () => {
        const { rootPath } = await makeProject({ 'package.json': PKG, 'src/a.js': '1' });
        const ctx = await buildContext(rootPath);
        const dump = JSON.stringify(ctx);
        assert.ok(!dump.includes(rootPath));
        assert.ok(!dump.includes(ROOT));
        assert.equal(ctx.project.root, '.');
    });
});

describe('P3-2 isolation + traversal', () => {
    it('8 workspace isolation via tool (session separation)', async () => {
        registerNativeTools(toolRegistry);
        const a = await makeWorkspace({ 'only-a.txt': 'A' });
        const other = sid();
        await assert.rejects(() => toolRegistry.execute('code_context', { sessionId: other }, { owner: 'alice' }));
        const out = await toolRegistry.execute('code_context', { sessionId: a.sessionId }, { owner: 'alice' });
        assert.ok(out.result.files.some((f) => f.path === 'only-a.txt'));
    });
    it('9 cross-owner rejection', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWorkspace({});
        await assert.rejects(() => toolRegistry.execute('code_context', { sessionId: ws.sessionId }, { owner: 'bob' }));
        await assert.rejects(
            () => toolRegistry.execute('code_context', { workspaceId: ws.workspaceId }, { owner: 'bob', sessionId: ws.sessionId })
        );
    });
    it('10 path traversal rejection', async () => {
        registerNativeTools(toolRegistry);
        const ws = await makeWorkspace({ 'a.js': '1' });
        await assert.rejects(
            () => toolRegistry.execute('code_context', { sessionId: ws.sessionId, paths: ['../x'] }, { owner: 'alice' }),
            (e) => e.code === 'TOOL_INVALID_INPUT'
        );
        await assert.rejects(
            () => toolRegistry.execute('code_context', { sessionId: ws.sessionId, paths: ['%2e%2e/x'] }, { owner: 'alice' }),
            (e) => e.code === 'TOOL_INVALID_INPUT'
        );
    });
});

describe('P3-2 exclusions', () => {
    it('11 .env exclusion (+ secret content never read)', async () => {
        const { rootPath } = await makeProject({ '.env': 'TOKEN=abc', 'a.js': '1' });
        const ctx = await buildContext(rootPath);
        assert.ok(!JSON.stringify(ctx).includes('TOKEN=abc'));
        assert.ok(!ctx.structure.some((e) => e.path === '.env'));
    });
    it('12 secret file exclusion', async () => {
        const { rootPath } = await makeProject({ 'id_rsa': 'k', 'api-token.txt': 't', 'creds.json': '{}', 'ok.js': '1' });
        const ctx = await buildContext(rootPath);
        const paths = ctx.structure.map((e) => e.path).join('|');
        assert.ok(!paths.includes('id_rsa') && !paths.includes('api-token') && !paths.includes('creds.json'));
    });
    it('13 .git exclusion', async () => {
        const { rootPath } = await makeProject({ '.git/config': 'x', '.git/objects/o': 'y', 'a.js': '1' });
        const ctx = await buildContext(rootPath);
        assert.ok(!ctx.structure.some((e) => e.path.startsWith('.git')));
    });
    it('14 node_modules exclusion', async () => {
        const { rootPath } = await makeProject({ 'node_modules/dep/index.js': 'x', 'a.js': '1' });
        const ctx = await buildContext(rootPath);
        assert.ok(!ctx.structure.some((e) => e.path.startsWith('node_modules')));
    });
    it('15 binary exclusion', async () => {
        const { rootPath } = await makeProject({ 'a.js': '1' });
        await fsp.writeFile(path.join(rootPath, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
        await fsp.writeFile(path.join(rootPath, 'blob.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
        const ctx = await buildContext(rootPath);
        const paths = ctx.structure.map((e) => e.path);
        assert.ok(!paths.includes('img.png'));
        assert.ok(!ctx.files.some((f) => f.path === 'blob.dat'));
    });
});

describe('P3-2 limits + robustness', () => {
    it('16 single file size limit', async () => {
        const { rootPath } = await makeProject({ 'a.js': '1' });
        await fsp.writeFile(path.join(rootPath, 'big.js'), 'x'.repeat(LIMITS.maxBytesPerFile + 100));
        const ctx = await buildContext(rootPath);
        assert.ok(!ctx.files.some((f) => f.path === 'big.js'));
        assert.equal(ctx.truncated, true);
    });
    it('17 total context limit', async () => {
        const files = {};
        for (let i = 0; i < 10; i += 1) files[`f${i}.js`] = 'y'.repeat(5000);
        const { rootPath } = await makeProject(files);
        const ctx = await buildContext(rootPath, { maxTotalBytes: 6000 });
        assert.equal(ctx.truncated, true);
        assert.ok(JSON.stringify(ctx.files).length <= 20000);
    });
    it('18 max file limit', async () => {
        const { rootPath } = await makeProject({ 'a.js': '1', 'b.js': '2', 'c.js': '3' });
        const ctx = await buildContext(rootPath, { maxFiles: 2 });
        assert.equal(ctx.files.length, 2);
        assert.equal(ctx.truncated, true);
    });
    it('19 deterministic output', async () => {
        const { rootPath } = await makeProject({ 'package.json': PKG, 'src/b.js': '2', 'src/a.js': '1' });
        const a = await buildContext(rootPath);
        const b = await buildContext(rootPath);
        assert.deepEqual(a, b);
    });
    it('20 malformed package.json never crashes', async () => {
        const { rootPath } = await makeProject({ 'package.json': '{oops', 'a.js': '1' });
        const ctx = await buildContext(rootPath);
        assert.equal(ctx.project.package, null);
        assert.ok(ctx.files.some((f) => f.path === 'a.js'));
        assert.equal(parsePackageJson('{oops'), null);
    });
    it('21 empty workspace', async () => {
        const { rootPath } = await makeProject({});
        const ctx = await buildContext(rootPath);
        assert.deepEqual(ctx.structure, []);
        assert.deepEqual(ctx.files, []);
        assert.equal(ctx.project.type, 'unknown');
        assert.equal(ctx.truncated, false);
    });
    it('22 missing README/package.json still works', async () => {
        const { rootPath } = await makeProject({ 'src/a.js': '1' });
        const ctx = await buildContext(rootPath);
        assert.ok(ctx.files.some((f) => f.path === 'src/a.js'));
        assert.equal(ctx.project.package, null);
    });
    it('23 symlink escape protection', async () => {
        const { rootPath } = await makeProject({ 'a.js': '1' });
        try {
            await fsp.symlink(os.tmpdir(), path.join(rootPath, 'link-out'));
        } catch {
            return; // symlink privilege missing on this platform
        }
        const ctx = await buildContext(rootPath);
        assert.ok(!ctx.structure.some((e) => e.path.startsWith('link-out')));
    });
    it('project type detection', () => {
        assert.equal(detectProjectType(new Set(['go.mod'])), 'go');
        assert.equal(detectProjectType(new Set(['requirements.txt'])), 'python');
        assert.equal(detectProjectType(new Set([])), 'unknown');
    });
});

describe('P3-2 tool contract + P2 regression', () => {
    it('tool metadata: readOnly, no approval, capabilities', async () => {
        registerNativeTools(toolRegistry);
        const m = toolRegistry.describe('code_context');
        assert.equal(m.readOnly, true);
        assert.equal(m.needsApproval, false);
        assert.deepEqual(m.capabilities, ['workspace.read', 'code.read']);
        assert.ok(typeof m.execute === 'undefined');
    });
    it('missing owner rejected without touching disk', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(
            () => toolRegistry.execute('code_context', { sessionId: sid() }, {}),
            (e) => e.code === 'TOOL_INVALID_INPUT'
        );
    });
    it('24 existing P2 behavior intact (calculator + registry size)', async () => {
        registerNativeTools(toolRegistry);
        assert.equal(toolRegistry.list().length, 16);
        assert.equal((await toolRegistry.execute('calculator', '1 + 1')).result, '2');
    });
});
