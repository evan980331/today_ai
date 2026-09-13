// P0.7-13: Cloud E2E contract (opt-in only).
// Requires ALL of:
//   CLOUD_WORKER_INTEGRATION_TEST=true
//   TODAY_AI_BASE_URL=https://<today-ai-api>
//   WORKER_URL=https://<agent-worker>
//   WORKER_SHARED_SECRET=<secret>
// If ANY is missing the whole file SKIPS explicitly (never fake-passes).
//
// Flow (minimal prompt, no streaming dependency):
//   client -> Today AI API (/api/chat) -> Remote Worker -> OpenCode
//   -> workspace file -> response
// Verifies: login, chat 200 + marker in result, history written once,
// no worker/OpenCode internals leaked to the client. Direct workspace-disk
// checks are impossible against a remote host by design; file creation is
// verified through the agent's reported result.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const ENABLED =
    process.env.CLOUD_WORKER_INTEGRATION_TEST === 'true' &&
    !!process.env.TODAY_AI_BASE_URL &&
    !!process.env.WORKER_URL &&
    !!process.env.WORKER_SHARED_SECRET;

describe('Cloud worker E2E (real deployment)', { skip: !ENABLED }, () => {
    const BASE = (process.env.TODAY_AI_BASE_URL || '').replace(/\/+$/, '');
    let cookie = '';
    const sid = `e2e-cloud-${Date.now()}`;

    before(async () => {
        const res = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: process.env.E2E_USERNAME || 'admin',
                password: process.env.E2E_PASSWORD || ''
            })
        });
        assert.equal(res.status, 200, 'E2E login must succeed (check E2E_USERNAME/E2E_PASSWORD)');
        const m = (res.headers.get('set-cookie') || '').match(/todayai_session=([^;]+)/);
        assert.ok(m, 'login must set session cookie');
        cookie = `todayai_session=${m[1]}`;
    });

    it('chat creates the marker file through the remote worker', async () => {
        const res = await fetch(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({
                prompt: 'Create a file named e2e-worker-test.txt containing exactly E2E_WORKER_OK. Reply with E2E_WORKER_OK when done.',
                sessionId: sid
            })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(
            (body.result || '').includes('E2E_WORKER_OK'),
            `agent must confirm marker, got: ${(body.result || '').slice(0, 200)}`
        );
        const text = JSON.stringify(body);
        assert.ok(!text.includes('127.0.0.1:4'), 'no worker/OpenCode URL may leak to client');
        assert.ok(!text.includes('workspacePath'), 'no internal paths may leak to client');
    });

    it('history written exactly once, no duplicates', async () => {
        const res = await fetch(`${BASE}/api/history?sessionId=${sid}&limit=20`, { headers: { Cookie: cookie } });
        const hist = await res.json();
        const aiRows = hist.filter((r) => r.role === 'ai');
        assert.equal(aiRows.length, 1, `expected exactly 1 ai row, got ${aiRows.length}`);
    });

    it('stream creates mobile-e2e.txt via Remote Worker with SSE', async () => {
        const streamSid = `e2e-stream-${Date.now()}`;
        const res = await fetch(`${BASE}/api/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({
                prompt: 'Create a file named mobile-e2e.txt containing exactly MOBILE_E2E_OK.',
                sessionId: streamSid
            })
        });
        assert.equal(res.status, 200, 'stream must open');
        assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
        const text = await res.text();
        const names = [];
        for (const chunk of text.split('\n\n')) {
            const ev = (chunk.match(/^event:\s*(.+)$/m) || [])[1];
            if (ev) names.push(ev);
        }
        for (const need of ['session.started', 'done']) {
            assert.ok(names.includes(need), `missing ${need}, got ${names}`);
        }
        assert.ok(!names.includes('error'), `unexpected error event in: ${names}`);
        assert.ok(text.includes('MOBILE_E2E_OK'), 'agent result must confirm the marker');
        const flat = JSON.stringify(names);
        void flat;
        assert.ok(!text.includes('X-Worker-Auth'), 'no auth material may leak');
        assert.ok(!text.includes('WORKER_SHARED_SECRET'), 'no secret names may leak');
        const hist = await (await fetch(`${BASE}/api/history?sessionId=${streamSid}&limit=20`, { headers: { Cookie: cookie } })).json();
        assert.equal(hist.filter((r) => r.role === 'ai').length, 1, 'stream history written exactly once');
    });
});
