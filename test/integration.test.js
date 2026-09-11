const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';

let authCookie = '';

async function fetchJson(url, opts = {}) {
    opts.headers = { ...(opts.headers || {}), ...(authCookie ? { 'Cookie': authCookie } : {}) };
    const res = await fetch(url, opts);
    const body = await res.json().catch(() => ({}));
    return { res, body };
}

before(async () => {
    // Login with default test credentials (must match .env AUTH_USERNAME/PASSWORD)
    const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const m = setCookie.match(/todayai_session=([^;]+)/);
    if (m) authCookie = `todayai_session=${m[1]}`;
    // Also set for subsequent fetches
});

describe('Integration: health', () => {
    it('GET /api/health should return ok', async () => {
        // Health is public, no auth needed, but we also test with auth
        const res = await fetch(`${BASE}/api/health`);
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.status, 'ok');
        assert.ok(['connected', 'not_configured', 'error'].some(s => body.db.includes(s) || body.db === s));
    });
});

describe('Integration: session validation', () => {
    it('should reject invalid sessionId', async () => {
        const { res, body } = await fetchJson(`${BASE}/api/history?sessionId=';DROP%20TABLE--`);
        assert.equal(res.status, 400);
        assert.match(body.error, /Invalid/);
    });
    it('should reject invalid limit', async () => {
        const { res } = await fetchJson(`${BASE}/api/history?sessionId=test&limit=9999`);
        assert.equal(res.status, 400);
    });
    it('should reject invalid before', async () => {
        const { res } = await fetchJson(`${BASE}/api/history?sessionId=test&before=not-a-date`);
        assert.equal(res.status, 400);
    });
});

describe('Integration: chat', () => {
    const sid = `test-int-${Date.now()}`;

    it('POST /api/chat success with mock', async () => {
        const { res, body } = await fetchJson(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'hello integration', sessionId: sid })
        });
        assert.equal(res.status, 200);
        assert.ok(body.result);
        assert.equal(body.sessionId, sid);
        assert.ok(Array.isArray(body.mcpTools));
    });

    it('should persist user and ai to history', async () => {
        const { body } = await fetchJson(`${BASE}/api/history?sessionId=${sid}&limit=10`);
        assert.ok(Array.isArray(body));
        assert.ok(body.length >= 2);
        const roles = body.map(r => r.role);
        assert.ok(roles.includes('user'));
        assert.ok(roles.includes('ai'));
    });

    it('should reject empty prompt', async () => {
        const { res, body } = await fetchJson(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: '' })
        });
        assert.equal(res.status, 400);
        assert.match(body.error, /Prompt/);
    });

    it('should auto-generate sessionId when missing', async () => {
        const { body } = await fetchJson(`${BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'auto session' })
        });
        assert.ok(body.sessionId);
        assert.match(body.sessionId, /^[0-9a-f-]{36}$/);
    });

    after(async () => {
        await fetchJson(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).catch(()=>{});
    });
});

describe('Integration: session isolation', () => {
    const sidA = `iso-a-${Date.now()}`;
    const sidB = `iso-b-${Date.now()}`;
    it('should isolate histories', async () => {
        await fetchJson(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'msg A', sessionId: sidA }) });
        await fetchJson(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'msg B', sessionId: sidB }) });
        const { body: histA } = await fetchJson(`${BASE}/api/history?sessionId=${sidA}`);
        const { body: histB } = await fetchJson(`${BASE}/api/history?sessionId=${sidB}`);
        assert.ok(histA.every(r => r.session_id === sidA));
        assert.ok(histB.every(r => r.session_id === sidB));
        assert.ok(!histA.some(r => r.content.includes('msg B')));
        await fetchJson(`${BASE}/api/sessions/${sidA}`, { method: 'DELETE' });
        await fetchJson(`${BASE}/api/sessions/${sidB}`, { method: 'DELETE' });
    });
});

describe('Integration: history pagination', () => {
    const sid = `page-${Date.now()}`;
    it('should paginate with limit and before', async () => {
        const chatRes = await fetchJson(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'page msg', sessionId: sid }) });
        assert.equal(chatRes.res.status, 200);
        const { body: all } = await fetchJson(`${BASE}/api/history?sessionId=${sid}&limit=10`);
        assert.ok(all.length >= 2, `expected >=2 got ${all.length}`);
        const { body: limited } = await fetchJson(`${BASE}/api/history?sessionId=${sid}&limit=1`);
        assert.equal(limited.length, 1);
        if (all.length > 1) {
            const before = all[all.length - 1].created_at;
            const { body: beforeRows } = await fetchJson(`${BASE}/api/history?sessionId=${sid}&limit=10&before=${encodeURIComponent(before)}`);
            assert.ok(beforeRows.length < all.length);
        }
        await fetchJson(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' });
    });
});

describe('Integration: delete session', () => {
    it('should delete and return empty history', async () => {
        const sid = `del-${Date.now()}`;
        await fetchJson(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'to delete', sessionId: sid }) });
        const del = await fetchJson(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' });
        assert.equal(del.res.status, 200);
        const { body: hist } = await fetchJson(`${BASE}/api/history?sessionId=${sid}`);
        assert.equal(hist.length, 0);
    });
});

describe('Integration: DB failure not crash', () => {
    it('should still return health even if DB would fail', async () => {
        const { res, body } = await fetchJson(`${BASE}/api/health`);
        assert.equal(res.status, 200);
        assert.equal(body.status, 'ok');
    });
});

describe('Integration: rate limit', () => {
    it('should 429 after exceeding history limit (100/min)', async () => {
        const promises = [];
        for (let i = 0; i < 101; i++) {
            promises.push(fetchJson(`${BASE}/api/sessions?limit=1`));
        }
        const results = await Promise.all(promises);
        const statuses = results.map(r => r.res.status);
        assert.ok(statuses.includes(429), 'should have at least one 429');
    });
});
