// P0-7: REAL OpenCode Server integration (opt-in only).
// Run with:
//   OPENCODE_INTEGRATION_TEST=true OPENCODE_SERVER_URL=http://127.0.0.1:4096 \
//   OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=xxx npm test
// Without OPENCODE_INTEGRATION_TEST=true the whole file SKIPS explicitly
// (never fake-passes). Requires a reachable server with the survey-verified
// API (opencode >= 1.18: POST /session, POST /session/{id}/message,
// GET /event SSE, POST /session/{id}/abort, Basic auth).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ENABLED = process.env.OPENCODE_INTEGRATION_TEST === 'true';

describe('OpenCode Server integration (real server)', { skip: !ENABLED }, () => {
    const { OpenCodeClient } = require('../src/services/agentClient');

    function client() {
        return new OpenCodeClient({
            transport: 'server',
            serverUrl: process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:4096',
            username: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
            password: process.env.OPENCODE_SERVER_PASSWORD || ''
        });
    }

    it('health reports reachable server', async () => {
        const h = await client().health();
        assert.equal(h.available, true, `server must be reachable: ${h.reason || h.status}`);
        assert.equal(h.transport, 'server');
    });

    it('create session returns an id', async () => {
        const ses = await client().createSession({ title: 'todayai-integration-probe' });
        assert.ok(ses.id && ses.id.startsWith('ses_'), `unexpected session: ${JSON.stringify(ses)}`);
    });

    it('send prompt returns assistant text', async () => {
        const c = client();
        const ses = await c.createSession({ title: 'todayai-integration-prompt' });
        const out = await c.promptSession(ses.id, 'reply with exactly: INTEGRATION_OK', { timeoutMs: 180000 });
        assert.ok(out.result.includes('INTEGRATION_OK'), `unexpected result: ${out.result.slice(0, 200)}`);
    });

    it('subscribe receives incremental events then idle', async () => {
        const c = client();
        const ses = await c.createSession({ title: 'todayai-integration-stream' });
        const seen = [];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180000);
        try {
            await Promise.all([
                c.subscribeSessionEvents(ses.id, {
                    signal: controller.signal,
                    onRawEvent: (e) => { seen.push(e.type); }
                }),
                c.promptSession(ses.id, 'reply with exactly: STREAM_OK', { signal: controller.signal, timeoutMs: 170000 })
            ]);
        } finally {
            clearTimeout(timer);
        }
        assert.ok(seen.includes('message.part.delta') || seen.includes('message.part.updated'),
            `expected streaming part events, got: ${seen.slice(0, 10)}`);
        assert.ok(seen.includes('session.idle'), `expected session.idle, got: ${seen.slice(-5)}`);
    });

    it('abort stops a session (returns true)', async () => {
        const c = client();
        const ses = await c.createSession({ title: 'todayai-integration-abort' });
        const r = await c.abortSession(ses.id);
        assert.equal(r.ok, true);
    });
});
