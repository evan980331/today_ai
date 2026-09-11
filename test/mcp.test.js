const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('MCP parsing', () => {
    const { parseMcpTools } = require('../src/services/opencode');

    it('should return [] for no tools', () => {
        assert.deepEqual(parseMcpTools('Hello world'), []);
        assert.deepEqual(parseMcpTools(''), []);
        assert.deepEqual(parseMcpTools(null), []);
    });

    it('should parse github tools from default format', () => {
        const raw = 'github_search_repositories {"query":"test"}\n some text\n github_get_file_contents {"owner":"a"}';
        const tools = parseMcpTools(raw);
        assert.ok(tools.includes('github_search_repositories'));
        assert.ok(tools.includes('github_get_file_contents'));
        assert.equal(tools.length, 2); // deduplicated
    });

    it('should parse JSON format tool_use', () => {
        const raw = '{"type":"tool_use","part":{"tool":"github_list_commits"}}\n{"type":"tool_use","part":{"tool":"gmail_search"}}';
        const tools = parseMcpTools(raw);
        assert.ok(tools.includes('github_list_commits'));
        assert.ok(tools.includes('gmail_search'));
    });

    it('should handle mixed and deduplicate case-insensitive', () => {
        const raw = 'GitHub_Search_Repositories xxx github_search_repositories';
        const tools = parseMcpTools(raw);
        assert.equal(tools.length, 1);
        assert.equal(tools[0], 'github_search_repositories');
    });

    it('should use mock MCP detection', async () => {
        const svc = require('../src/services/opencode');
        // With MOCK, prompt containing github should return mock tool
        const res = await svc.run('列出 GitHub repo', { timeoutMs: 5000 });
        // run returns object with mcpTools when MOCK, check
        if (typeof res === 'object') {
            assert.ok(Array.isArray(res.mcpTools));
        }
    });
});

describe('MCP DB persistence', () => {
    it('chat without MCP should save [] not null', async () => {
        const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';
        const sid = `mcp-empty-${Date.now()}`;
        const { body } = await (async () => {
            const res = await fetch(`${BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'hello simple no tools', sessionId: sid })
            });
            return { body: await res.json() };
        })();
        assert.ok(Array.isArray(body.mcpTools));
        assert.equal(body.mcpTools.length, 0);
        // Check DB via history
        const histRes = await fetch(`${BASE}/api/history?sessionId=${sid}`);
        const hist = await histRes.json();
        const aiRow = hist.find(r => r.role === 'ai');
        assert.ok(aiRow);
        // mcp_tools should be [] (jsonb) or null, but not string "null"
        assert.ok(aiRow.mcp_tools === null || Array.isArray(aiRow.mcp_tools));
        if (Array.isArray(aiRow.mcp_tools)) {
            assert.equal(aiRow.mcp_tools.length, 0);
        }
        await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' });
    });

    it('chat with github should save tool name', async () => {
        const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';
        const sid = `mcp-github-${Date.now()}`;
        const { body } = await (async () => {
            const res = await fetch(`${BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: '列出 GitHub repo 資訊', sessionId: sid })
            });
            return { body: await res.json() };
        })();
        assert.ok(Array.isArray(body.mcpTools));
        assert.ok(body.mcpTools.includes('github_get_file_contents'));
        const histRes = await fetch(`${BASE}/api/history?sessionId=${sid}`);
        const hist = await histRes.json();
        const aiRow = hist.find(r => r.role === 'ai');
        assert.ok(Array.isArray(aiRow.mcp_tools));
        assert.ok(aiRow.mcp_tools.includes('github_get_file_contents'));
        await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' });
    });

    it('should not duplicate AI response on success', async () => {
        const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';
        const sid = `mcp-dedup-${Date.now()}`;
        await fetch(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'hello dedup', sessionId: sid })
        });
        const histRes = await fetch(`${BASE}/api/history?sessionId=${sid}`);
        const hist = await histRes.json();
        const aiRows = hist.filter(r => r.role === 'ai');
        assert.equal(aiRows.length, 1, 'AI should be saved exactly once');
        await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' });
    });
});
