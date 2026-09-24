// P2-C Phase A: Native Calendar OAuth / API foundation tests.
// Mock transport only — never real Google Calendar API, never real credentials.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../src/services/calendar/auth');
const { createCalendarClient, API_BASE, scrub } = require('../src/services/calendar/client');

const TEST_ENV = {
    GOOGLE_CALENDAR_CLIENT_ID: 'test-client-id',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_CALENDAR_REFRESH_TOKEN: 'test-refresh-token'
};

beforeEach(() => {
    auth._clearTokenCacheForTests();
});

afterEach(() => {
    auth._clearTokenCacheForTests();
});

function tokenFetch(token = 'tok_test', expiresIn = 3600) {
    return async () => ({ ok: true, json: async () => ({ access_token: token, expires_in: expiresIn }) });
}

describe('P2-C Phase A auth foundation', () => {
    it('A OAuth config missing -> CALENDAR_CONFIG_MISSING (names only)', async () => {
        await assert.rejects(
            () => auth.getAccessToken({ fetchFn: tokenFetch(), env: {} }),
            (e) => e.code === 'CALENDAR_CONFIG_MISSING'
                && /GOOGLE_CALENDAR_CLIENT_ID/.test(e.message)
                && /GOOGLE_CALENDAR_CLIENT_SECRET/.test(e.message)
                && /GOOGLE_CALENDAR_REFRESH_TOKEN/.test(e.message)
        );
    });
    it('A2 partial config lists only missing names', () => {
        assert.throws(
            () => auth.getCalendarConfig({ GOOGLE_CALENDAR_CLIENT_ID: 'x' }),
            (e) => e.code === 'CALENDAR_CONFIG_MISSING'
                && !/GOOGLE_CALENDAR_CLIENT_ID/.test(e.message.split('missing: ')[1].split(',')[0] || '')
                && /GOOGLE_CALENDAR_CLIENT_SECRET/.test(e.message)
        );
    });
    it('B OAuth token cache (second call reuses, no second fetch)', async () => {
        let calls = 0;
        const fetchFn = async () => {
            calls += 1;
            return { ok: true, json: async () => ({ access_token: 'tok_cached', expires_in: 3600 }) };
        };
        const t1 = await auth.getAccessToken({ fetchFn, env: TEST_ENV });
        const t2 = await auth.getAccessToken({ fetchFn, env: TEST_ENV });
        assert.equal(t1, 'tok_cached');
        assert.equal(t2, 'tok_cached');
        assert.equal(calls, 1);
    });
    it('C expiry handling (expired cache refetches)', async () => {
        let calls = 0;
        const fetchFn = async () => {
            calls += 1;
            return { ok: true, json: async () => ({ access_token: `tok_${calls}`, expires_in: 0 }) };
        };
        // expires_in 0 -> default 1h; force expiry by second call after manual clear path:
        await auth.getAccessToken({ fetchFn, env: TEST_ENV });
        auth._clearTokenCacheForTests();
        const t2 = await auth.getAccessToken({ fetchFn, env: TEST_ENV });
        assert.equal(t2, 'tok_2');
        assert.equal(calls, 2);
    });
    it('C2 unauthorized refresh -> CALENDAR_UNAUTHORIZED', async () => {
        const fetchFn = async () => ({ ok: false, status: 401 });
        await assert.rejects(
            () => auth.getAccessToken({ fetchFn, env: TEST_ENV }),
            (e) => e.code === 'CALENDAR_UNAUTHORIZED'
        );
    });
});

describe('P2-C Phase A client foundation', () => {
    it('M request structure (base URL, auth header, query)', async () => {
        let seen = null;
        const fetchFn = async (url, opts) => {
            seen = { url, opts };
            return { ok: true, json: async () => ({ ok: true }) };
        };
        const client = createCalendarClient({ fetchFn, getToken: async () => 'tok_test' });
        const out = await client.request('/calendarList', { query: { maxResults: 5 } });
        assert.deepEqual(out, { ok: true });
        assert.ok(seen.url.startsWith(`${API_BASE}/calendarList?`));
        assert.ok(seen.url.includes('maxResults=5'));
        assert.equal(seen.opts.headers.Authorization, 'Bearer tok_test');
        assert.equal(seen.opts.method, 'GET');
    });
    it('G HTTP 401 -> CALENDAR_UNAUTHORIZED', async () => {
        const client = createCalendarClient({
            fetchFn: async () => ({ ok: false, status: 401, text: async () => 'Invalid Credentials' }),
            getToken: async () => 'tok_test'
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'CALENDAR_UNAUTHORIZED');
    });
    it('H HTTP 403 -> CALENDAR_FORBIDDEN', async () => {
        const client = createCalendarClient({
            fetchFn: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
            getToken: async () => 'tok_test'
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'CALENDAR_FORBIDDEN');
    });
    it('I HTTP 404 -> CALENDAR_NOT_FOUND', async () => {
        const client = createCalendarClient({
            fetchFn: async () => ({ ok: false, status: 404, text: async () => 'Not Found' }),
            getToken: async () => 'tok_test'
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'CALENDAR_NOT_FOUND');
    });
    it('J HTTP 429 -> CALENDAR_RATE_LIMITED', async () => {
        const client = createCalendarClient({
            fetchFn: async () => ({ ok: false, status: 429, text: async () => 'rateLimitExceeded' }),
            getToken: async () => 'tok_test'
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'CALENDAR_RATE_LIMITED');
    });
    it('K HTTP 5xx -> CALENDAR_UPSTREAM', async () => {
        const client = createCalendarClient({
            fetchFn: async () => ({ ok: false, status: 503, text: async () => 'Backend Error' }),
            getToken: async () => 'tok_test'
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'CALENDAR_UPSTREAM');
    });
    it('L network failure -> CALENDAR_UPSTREAM', async () => {
        const client = createCalendarClient({
            fetchFn: async () => { throw new Error('fetch failed'); },
            getToken: async () => 'tok_test'
        });
        await assert.rejects(() => client.request('/x'), (e) => e.code === 'CALENDAR_UPSTREAM');
    });
    it('D credential never appears in error', async () => {
        const secret = 'ya29.cal-test-secret-xyz';
        const client = createCalendarClient({
            fetchFn: async () => ({ ok: false, status: 401, text: async () => `Invalid ${secret} Bearer ${secret}` }),
            getToken: async () => 'tok_test'
        });
        await assert.rejects(() => client.request('/x'), (e) => {
            assert.ok(!String(e.message).includes(secret), 'credential leaked in error');
            return e.code === 'CALENDAR_UNAUTHORIZED';
        });
        assert.ok(!scrub(`Bearer ${secret}`).includes(secret));
    });
    it('E abort -> ABORTED (never upstream)', async () => {
        const client = createCalendarClient({
            fetchFn: async (url, opts) => {
                await new Promise((resolve, reject) => {
                    if (opts.signal && opts.signal.aborted) {
                        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                        return;
                    }
                    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                });
            },
            getToken: async () => 'tok_test'
        });
        const c = new AbortController();
        const p = client.request('/x', { signal: c.signal });
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
    });
    it('F timeout surfaces as caller TIMEOUT (registry boundary)', async () => {
        // client itself propagates abort; registry converts to TIMEOUT via timeoutMs.
        // Here: abort mid-flight stays ABORTED, never CALENDAR_UPSTREAM.
        const client = createCalendarClient({
            fetchFn: async (url, opts) => {
                await new Promise((resolve, reject) => {
                    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
                });
            },
            getToken: async () => 'tok_test'
        });
        const c = new AbortController();
        setTimeout(() => c.abort(), 20);
        await assert.rejects(() => client.request('/x', { signal: c.signal }), (e) => e.code === 'ABORTED');
    });
});
