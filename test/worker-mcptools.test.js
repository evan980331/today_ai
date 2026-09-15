// P1: mcpTools reporting regression tests.
//
// Bug: POST /workers/:id/execute returned mcpTools=[] even when the turn
// really called MCP tools, because extractServerMessage() only scans the
// POST /message response parts. Fix: merge SSE-observed tools (via the
// single normalizeServerEvent parser) into both /execute and
// /execute/stream results.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const aw = require('../src/services/agentWorker');
const { createToolCollector, mergeMcpTools } = require('../src/services/agentEvents');

const SECRET = 'test-mcptools-secret';
const savedEnv = {};
function setEnv(patch) {
    for (const k of Object.keys(patch)) {
        if (!(k in savedEnv)) savedEnv[k] = process.env[k];
        if (patch[k] === undefined) delete process.env[k];
        else process.env[k] = patch[k];
    }
}
function restoreEnv() {
    for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
        delete savedEnv[k];
    }
}
afterEach(() => {
    aw._clearForTests();
    restoreEnv();
});

const TOOL_EV = {
    type: 'message.part.updated',
    properties: { sessionID: 'ses_m', part: { id: 'pt1', type: 'tool', tool: 'GitHub_Search', callID: 'c1' } }
};
const TEXT_EV = {
    type: 'message.part.delta',
    properties: { sessionID: 'ses_m', messageID: 'm', partID: 'px', field: 'text', delta: 'uses gmail_search heavily' }
};
const IDLE_EV = { type: 'session.idle', properties: { sessionID: 'ses_m' } };

describe('P1 tool collector + merge', () => {
    it('collects SSE tool events, dedupes repeats', () => {
        const c = createToolCollector();
        c.onRawEvent(TOOL_EV);
        c.onRawEvent(TOOL_EV);
        c.onRawEvent({ ...TOOL_EV, properties: { sessionID: 'ses_m', part: { id: 'pt2', type: 'tool', tool: 'gmail_search', callID: 'c2' } } });
        assert.deepEqual(c.tools(), ['github_search', 'gmail_search']);
    });

    it('ignores text, idle, malformed events (no false tools)', () => {
        const c = createToolCollector();
        c.onRawEvent(TEXT_EV);
        c.onRawEvent(IDLE_EV);
        c.onRawEvent(null);
        c.onRawEvent({ nope: true });
        c.onRawEvent({ type: 'message.part.delta', properties: { field: 'reasoning', delta: 'x' } });
        assert.deepEqual(c.tools(), []);
    });

    it('mergeMcpTools unions, lowercases, drops non-strings', () => {
        assert.deepEqual(mergeMcpTools(['B'], ['b', 'A', null, 42, '']), ['b', 'a']);
        assert.deepEqual(mergeMcpTools(null, undefined, []), []);
        assert.deepEqual(mergeMcpTools({}), []);
    });
});

describe('P1 worker routes report SSE tools consistently', () => {
    const orig = {};
    beforeEach(() => {
        setEnv({ WORKER_SHARED_SECRET: SECRET, MOCK_OPENCODE: 'true', NODE_ENV: undefined });
        for (const k of ['getWorker', 'workerClient', 'markRunning', 'markIdle']) orig[k] = aw[k];
        aw.getWorker = () => ({ workerId: 'wrk_m', status: 'ready' });
        aw.markRunning = () => ({});
        aw.markIdle = () => ({});
        aw.workerClient = () => ({
            createSession: async () => ({ id: 'ses_m' }),
            subscribeSessionEvents: async (sid, opts) => {
                const cb = opts && opts.onRawEvent;
                if (typeof cb === 'function') {
                    cb(TOOL_EV);
                    cb(TOOL_EV); // duplicate must not duplicate output
                    cb(TEXT_EV); // text must never become a tool
                }
                return { ended: 'idle' };
            },
            promptSession: async () => ({ result: 'did stuff', mcpTools: ['gmail_search'] })
        });
    });
    afterEach(() => {
        for (const k of Object.keys(orig)) aw[k] = orig[k];
    });

    function buildApp() {
        delete require.cache[require.resolve('../src/routes/workers.js')];
        const app = express();
        app.use(express.json());
        app.use('/', require('../src/routes/workers.js'));
        return app;
    }

    it('execute merges response parts + SSE tools, deduped', async () => {
        const app = buildApp();
        const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
        try {
            const r = await fetch(`http://127.0.0.1:${s.address().port}/workers/wrk_m/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET },
                body: JSON.stringify({ prompt: 'do it' })
            });
            assert.equal(r.status, 200);
            assert.deepEqual((await r.json()).mcpTools, ['gmail_search', 'github_search']);
        } finally {
            if (s.closeAllConnections) s.closeAllConnections();
            await new Promise((r) => s.close(r));
        }
    });

    it('execute/stream done carries the same merged tools', async () => {
        const app = buildApp();
        const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
        try {
            const r = await fetch(`http://127.0.0.1:${s.address().port}/workers/wrk_m/execute/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET },
                body: JSON.stringify({ prompt: 'do it' })
            });
            assert.equal(r.status, 200);
            const text = await r.text();
            const doneLine = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('github_search'));
            assert.ok(doneLine, 'done event must carry merged tools');
            assert.deepEqual(JSON.parse(doneLine.slice('data: '.length)).mcpTools, ['gmail_search', 'github_search']);
        } finally {
            if (s.closeAllConnections) s.closeAllConnections();
            await new Promise((r) => s.close(r));
        }
    });

    it('no tool events still yields response-parts tools (possibly [])', async () => {
        aw.workerClient = () => ({
            createSession: async () => ({ id: 'ses_m' }),
            subscribeSessionEvents: async (sid, opts) => {
                if (opts && typeof opts.onRawEvent === 'function') opts.onRawEvent(TEXT_EV);
                return { ended: 'idle' };
            },
            promptSession: async () => ({ result: 'plain', mcpTools: [] })
        });
        const app = buildApp();
        const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
        try {
            const r = await fetch(`http://127.0.0.1:${s.address().port}/workers/wrk_m/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Worker-Auth': SECRET },
                body: JSON.stringify({ prompt: 'do it' })
            });
            assert.equal(r.status, 200);
            assert.deepEqual((await r.json()).mcpTools, []);
        } finally {
            if (s.closeAllConnections) s.closeAllConnections();
            await new Promise((r) => s.close(r));
        }
    });
});
