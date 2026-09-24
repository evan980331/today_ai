// P2-B Gmail Native Tool tests (mock transport only — never real Gmail).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools, NATIVE_TOOL_NAMES } = require('../src/services/tools/nativeTools');
const gmailTools = require('../src/services/tools/gmail');
const auth = require('../src/services/gmail/auth');
const { createGmailClient } = require('../src/services/gmail/client');
const core = require('../src/agent/core');

function b64url(s) {
    return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mockClient(overrides = {}) {
    return {
        searchMessages: async () => ({ messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 }),
        getMessage: async () => ({
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX'],
            snippet: 'hello snippet',
            payload: {
                headers: [
                    { name: 'Subject', value: 'Hi' },
                    { name: 'From', value: 'a@x.com' },
                    { name: 'Date', value: 'Thu, 24 Sep 2026' }
                ],
                parts: [
                    { mimeType: 'text/plain', body: { data: b64url('plain body text') } },
                    { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } }
                ]
            }
        }),
        listThreads: async () => ({ threads: [{ id: 't1', snippet: 's1' }], resultSizeEstimate: 1 }),
        ...overrides
    };
}

beforeEach(() => {
    toolRegistry._clearForTests();
    auth._clearTokenCacheForTests();
    gmailTools.setGmailClientFactory(() => mockClient());
});

afterEach(() => {
    gmailTools.resetGmailClientFactory();
    auth._clearTokenCacheForTests();
    toolRegistry._clearForTests();
});

describe('P2-B metadata + registration', () => {
    it('1 tool metadata (readOnly, no approval, inputSchema)', () => {
        for (const t of [gmailTools.gmailSearch, gmailTools.gmailGetMessage, gmailTools.gmailListThreads]) {
            assert.ok(t.name.startsWith('gmail.'));
            assert.ok(t.description && t.description.length > 0);
            assert.ok(t.inputSchema && typeof t.inputSchema === 'object');
            assert.equal(t.readOnly, true);
            assert.equal(t.needsApproval, false);
            assert.equal(typeof t.execute, 'function');
            assert.ok(Object.isFrozen(t));
        }
    });
    it('2 registerNativeTools gives calculator + 3 gmail tools, idempotent', () => {
        const r1 = registerNativeTools(toolRegistry);
        assert.deepEqual(r1.registered.sort(), ['calculator', 'gmail.getMessage', 'gmail.listThreads', 'gmail.search'].sort());
        assert.deepEqual(NATIVE_TOOL_NAMES.sort(), r1.registered.sort());
        for (const n of ['calculator', 'gmail.search', 'gmail.getMessage', 'gmail.listThreads']) {
            assert.ok(toolRegistry.has(n), n);
        }
        const r2 = registerNativeTools(toolRegistry);
        assert.deepEqual(r2.registered, []);
        assert.equal(r2.skipped.length, 4);
    });
});

describe('P2-B input validation', () => {
    it('3 gmail.search input validation', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('gmail.search', null), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('gmail.search', {}), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('gmail.search', { query: '' }), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('gmail.search', { query: 'x', maxResults: 0 }), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('gmail.search', { query: 'x', maxResults: 51 }), (e) => e.status === 400);
    });
    it('4 gmail.getMessage input validation', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('gmail.getMessage', {}), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('gmail.getMessage', { messageId: '' }), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('gmail.getMessage', { messageId: 123 }), (e) => e.status === 400);
    });
    it('5 gmail.listThreads input validation', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('gmail.listThreads', { query: '' }), (e) => e.status === 400);
        await assert.rejects(() => toolRegistry.execute('gmail.listThreads', { maxResults: 999 }), (e) => e.status === 400);
        // empty/undefined input is valid (optional query)
        const out = await toolRegistry.execute('gmail.listThreads', undefined);
        assert.ok(out.result.threads);
    });
});

describe('P2-B normalized output', () => {
    it('6/7 search success + normalized output', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('gmail.search', { query: 'from:boss' });
        assert.deepEqual(out.result.messages, [{ id: 'm1', threadId: 't1' }]);
        assert.equal(out.result.resultSizeEstimate, 1);
        assert.equal(out.result.query, 'from:boss');
        assert.ok(out.mcpTools.includes('gmail.search'));
        assert.ok(!JSON.stringify(out).includes('ya29.'));
    });
    it('8 getMessage normalized output', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('gmail.getMessage', { messageId: 'm1' });
        assert.equal(out.result.id, 'm1');
        assert.equal(out.result.threadId, 't1');
        assert.deepEqual(out.result.labelIds, ['INBOX']);
        assert.equal(out.result.subject, 'Hi');
        assert.equal(out.result.from, 'a@x.com');
        assert.ok(out.result.snippet.includes('hello'));
    });
    it('9 multipart prefers text/plain', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('gmail.getMessage', { messageId: 'm1' });
        assert.equal(out.result.body, 'plain body text');
        assert.equal(out.result.bodyMimeType, 'text/plain');
    });
    it('10 html fallback when no text/plain', async () => {
        gmailTools.setGmailClientFactory(() => mockClient({
            getMessage: async () => ({
                id: 'm2', threadId: 't2', labelIds: [], snippet: 's',
                payload: {
                    headers: [],
                    parts: [{ mimeType: 'text/html', body: { data: b64url('<p>Hello <b>World</b></p>') } }]
                }
            })
        }));
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('gmail.getMessage', { messageId: 'm2' });
        assert.equal(out.result.body, 'Hello World');
        assert.equal(out.result.bodyMimeType, 'text/html');
    });
    it('11 listThreads normalized output', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('gmail.listThreads', { query: 'in:inbox' });
        assert.deepEqual(out.result.threads, [{ id: 't1', snippet: 's1' }]);
        assert.equal(out.result.resultSizeEstimate, 1);
        assert.ok(out.mcpTools.includes('gmail.listThreads'));
    });
});

describe('P2-B error mapping (mock HTTP)', () => {
    function httpClient(status, body) {
        return createGmailClient({
            fetchFn: async () => ({ ok: false, status, text: async () => body }),
            getToken: async () => 'tok_test'
        });
    }
    it('12 API 401 -> GMAIL_UNAUTHORIZED', async () => {
        gmailTools.setGmailClientFactory(() => httpClient(401, 'Invalid Credentials'));
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('gmail.search', { query: 'x' }), (e) => e.code === 'GMAIL_UNAUTHORIZED');
    });
    it('13 API 403 -> GMAIL_FORBIDDEN', async () => {
        gmailTools.setGmailClientFactory(() => httpClient(403, 'insufficientPermissions'));
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('gmail.getMessage', { messageId: 'm' }), (e) => e.code === 'GMAIL_FORBIDDEN');
    });
    it('14 API 404 -> GMAIL_NOT_FOUND', async () => {
        gmailTools.setGmailClientFactory(() => httpClient(404, 'Not Found'));
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('gmail.getMessage', { messageId: 'nope' }), (e) => e.code === 'GMAIL_NOT_FOUND');
    });
    it('15 missing configuration -> GMAIL_CONFIG_MISSING', async () => {
        gmailTools.resetGmailClientFactory(); // real client, no creds in test env
        const saved = { ...process.env };
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        delete process.env.GOOGLE_REFRESH_TOKEN;
        registerNativeTools(toolRegistry);
        try {
            await assert.rejects(() => toolRegistry.execute('gmail.search', { query: 'x' }), (e) => e.code === 'GMAIL_CONFIG_MISSING');
        } finally {
            process.env = saved;
        }
    });
    it('16 abort -> ABORTED (never wrapped)', async () => {
        gmailTools.setGmailClientFactory(() => mockClient({
            searchMessages: async () => new Promise(() => {})
        }));
        registerNativeTools(toolRegistry);
        const c = new AbortController();
        const p = toolRegistry.execute('gmail.search', { query: 'x' }, { signal: c.signal, timeoutMs: 5000 });
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
    });
    it('17 timeout -> TIMEOUT (never wrapped)', async () => {
        gmailTools.setGmailClientFactory(() => mockClient({
            listThreads: async () => new Promise(() => {})
        }));
        registerNativeTools(toolRegistry);
        await assert.rejects(
            toolRegistry.execute('gmail.listThreads', {}, { timeoutMs: 30 }),
            (e) => e.code === 'TIMEOUT'
        );
    });
    it('18 token never appears in error/output', async () => {
        const secret = 'ya29.test-secret-token-xyz';
        gmailTools.setGmailClientFactory(() => httpClient(401, `Invalid Credentials ${secret} Bearer ${secret}`));
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('gmail.search', { query: 'x' }), (e) => {
            assert.ok(!String(e.message).includes(secret), 'token leaked in error');
            return e.code === 'GMAIL_UNAUTHORIZED';
        });
    });
});

describe('P2-B integration regression', () => {
    it('19 calculator regression', async () => {
        registerNativeTools(toolRegistry);
        assert.equal((await toolRegistry.execute('calculator', '2 + 3 * 4')).result, '14');
    });
    it('20 Agent Core -> ToolRegistry -> Gmail Tool (explicit selection)', async () => {
        registerNativeTools(toolRegistry);
        const task = { id: 'gmail1', prompt: 'from:boss', sessionId: 's-g', tools: ['gmail.search'] };
        const out = await core.run(task, {});
        assert.ok(out.result.messages);
        assert.equal(out.result.query, 'from:boss');
        assert.ok(out.mcpTools.includes('gmail.search'));
    });
    it('core never imports gmail implementation', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'core.js'), 'utf8');
        assert.ok(!src.includes('gmail'), 'core must not reference gmail');
        assert.ok(!src.includes('calculator'), 'core must not reference calculator');
    });
    it('21 Gmail MCP regression (config untouched)', () => {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'opencode.json'), 'utf8'));
        assert.ok(cfg.mcp.gmail, 'gmail MCP still present');
        assert.deepEqual(cfg.mcp.gmail.command, ['npx', '-y', '@klodr/gmail-mcp']);
        assert.equal(cfg.mcp.gmail.environment.GMAIL_OAUTH_PATH, '{env:GMAIL_OAUTH_PATH}');
    });
    it('22 tools:[] OpenCode regression', async () => {
        const rt = require('../src/services/opencodeRuntime');
        const orig = rt.execute;
        rt.execute = async () => ({ result: 'runtime-ok', mcpTools: [] });
        try {
            const out = await core.run({ id: 'rt1', prompt: 'hi', sessionId: 's', tools: [] }, {});
            assert.equal(out.result, 'runtime-ok');
        } finally {
            rt.execute = orig;
        }
    });
});
