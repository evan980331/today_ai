// Provider-identity diagnostic invariants (no production code touched).
//
// Background: provider error
//   [invalid_request_error] reasoning `encrypted_content` was not issued
//   to this caller
// means encrypted reasoning issued under one caller was replayed under a
// different one. These tests pin the Today AI side of that contract:
// Today AI must NEVER originate, store, or replay reasoning/encrypted
// content, and must always open a fresh OpenCode session per execution.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Outbound OpenCode payloads carry no reasoning state', () => {
    it('CLI prompt path sends plain text only', async () => {
        const svc = require('../src/services/opencode');
        const origRun = svc.run;
        let captured = null;
        svc.run = async (prompt, opts) => {
            captured = { prompt, opts };
            return { result: 'ok', mcpTools: [], raw: '' };
        };
        try {
            const { OpenCodeClient } = require('../src/services/agentClient');
            await new OpenCodeClient({ transport: 'cli' }).sendPrompt('hello identity');
            assert.ok(captured, 'run must be called');
            assert.equal(typeof captured.prompt, 'string');
            const flat = JSON.stringify(captured);
            assert.ok(!/reasoning/i.test(flat), 'no reasoning field may leave Today AI');
            assert.ok(!/encrypted/i.test(flat), 'no encrypted field may leave Today AI');
        } finally {
            svc.run = origRun;
        }
    });

    it('server promptSession posts text-only parts', async () => {
        const { OpenCodeClient } = require('../src/services/agentClient');
        const client = new OpenCodeClient({ transport: 'server', serverUrl: 'http://127.0.0.1:9' });
        client.resolveTransport = async () => 'server';
        const calls = [];
        client.serverRequest = async (path, opts) => {
            calls.push({ path, body: opts && opts.body });
            return { status: 200, data: { info: {}, parts: [] } };
        };
        await client.promptSession('ses_probe123', 'hello identity');
        assert.equal(calls.length, 1);
        assert.ok(calls[0].path.includes('ses_probe123'));
        const parts = calls[0].body.parts;
        assert.ok(Array.isArray(parts) && parts.length === 1);
        assert.deepEqual(Object.keys(parts[0]).sort(), ['text', 'type']);
        assert.equal(parts[0].type, 'text');
        const flat = JSON.stringify(calls);
        assert.ok(!/reasoning/i.test(flat), 'no reasoning field may leave Today AI');
        assert.ok(!/encrypted/i.test(flat), 'no encrypted field may leave Today AI');
        assert.ok(!/messageID|parentID|history/i.test(flat), 'no replay identifiers may leave Today AI');
    });

    it('every execution opens a fresh OpenCode session (no id reuse)', async () => {
        const { OpenCodeClient } = require('../src/services/agentClient');
        const created = [];
        const client = new OpenCodeClient({ transport: 'server', serverUrl: 'http://127.0.0.1:9' });
        client.resolveTransport = async () => 'server';
        client.serverRequest = async (path, opts) => {
            if (path === '/session' && opts && opts.method === 'POST') {
                created.push(opts.body);
                return { status: 200, data: { id: `ses_fresh${created.length}` } };
            }
            return { status: 200, data: { info: {}, parts: [] } };
        };
        await client.sendPrompt('first turn');
        await client.sendPrompt('second turn');
        assert.equal(created.length, 2, 'one OpenCode session per execution');
        const flat = JSON.stringify(created);
        assert.ok(!/ses_/i.test(flat.replace(/"title"/g, '')), 'createSession must not reference a prior session id');
    });
});

describe('Inbound reasoning stays display-only', () => {
    it('server reasoning deltas are dropped once part type is known', () => {
        const { normalizeServerEvent } = require('../src/services/agentEvents');
        const pts = { prt_r: 'reasoning' };
        assert.equal(normalizeServerEvent({
            type: 'message.part.delta',
            properties: { sessionID: 's', messageID: 'm', partID: 'prt_r', field: 'text', delta: 'hmm' }
        }, pts), null, 'server reasoning deltas must be dropped');
        assert.equal(normalizeServerEvent({
            type: 'message.part.delta',
            properties: { sessionID: 's', messageID: 'm', partID: 'prt_t', field: 'text', delta: 'hi' }
        }, { prt_t: 'text' }).type, 'text.delta');
    });

    it('OBSERVATION: CLI text envelope does not discriminate part.type', () => {
        // Documents current behavior (not a replay vector: outbound and
        // history-replay paths never carry reasoning — see tests above).
        // A hypothetical {type:'text', part:{type:'reasoning', text}} event
        // WOULD surface as text.delta today. Real CLI reasoning arrives in
        // its own part shapes; server transport filters via partTypes map.
        const { normalizeOpenCodeEvent } = require('../src/services/agentEvents');
        const out = normalizeOpenCodeEvent({ type: 'text', part: { type: 'reasoning', text: 'hypothetical' } });
        assert.equal(out && out.type, 'text.delta', 'pins current pass-through behavior for review');
        assert.equal(normalizeOpenCodeEvent({ type: 'reasoning', part: { type: 'reasoning', text: 'x' } }), null);
    });

    it('persisted history rows contain plain text only', async () => {
        const db = require('../src/db/db');
        const sid = `ident-hist-${Date.now()}`;
        await db.saveLog({ sessionId: sid, role: 'ai', content: 'plain answer', prompt: 'q' });
        try {
            const hist = await db.getHistory({ sessionId: sid, limit: 5 });
            const flat = JSON.stringify(hist);
            assert.ok(!/reasoning/i.test(flat), 'stored history must not contain reasoning');
            assert.ok(!/encrypted/i.test(flat), 'stored history must not contain encrypted content');
        } finally {
            await db.deleteSession(sid).catch(() => {});
        }
    });
});
