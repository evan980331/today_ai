// Calendar OAuth for Native Tools (read-only) — P2-C Phase A foundation.
//
// Option A (independent credential): the Calendar MCP (@cocal/
// google-calendar-mcp) authenticates via GOOGLE_OAUTH_CREDENTIALS, which is
// an MCP-internal credential *file path* — its format belongs to the MCP
// and must never be copied or converted. The Gmail native credential
// (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN) carries only the gmail.readonly
// scope and must not be silently widened. Therefore the Native Calendar
// Tool uses its own namespaced variables:
//
//   GOOGLE_CALENDAR_CLIENT_ID
//   GOOGLE_CALENDAR_CLIENT_SECRET
//   GOOGLE_CALENDAR_REFRESH_TOKEN
//
// Scope is strictly read-only:
//   https://www.googleapis.com/auth/calendar.readonly
// Secrets never enter source code, logs, errors, or tool results.
// No dependency on @cocal/google-calendar-mcp or OpenCode MCP.
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

// In-memory access-token cache (per process, never persisted).
let cached = null; // { token, expiresAt }

function calendarError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function isPlaceholder(v) {
    return typeof v !== 'string' || !v.trim() || v.includes('your_') || v.includes('example');
}

// Reads OAuth config from env only. Throws CALENDAR_CONFIG_MISSING
// (status 400 so the code survives the ToolRegistry boundary verbatim)
// when incomplete. Names only in the message — never values.
function getCalendarConfig(env) {
    const e = env || process.env;
    const clientId = e.GOOGLE_CALENDAR_CLIENT_ID;
    const clientSecret = e.GOOGLE_CALENDAR_CLIENT_SECRET;
    const refreshToken = e.GOOGLE_CALENDAR_REFRESH_TOKEN;
    const missing = [];
    if (isPlaceholder(clientId)) missing.push('GOOGLE_CALENDAR_CLIENT_ID');
    if (isPlaceholder(clientSecret)) missing.push('GOOGLE_CALENDAR_CLIENT_SECRET');
    if (isPlaceholder(refreshToken)) missing.push('GOOGLE_CALENDAR_REFRESH_TOKEN');
    if (missing.length) {
        throw calendarError(400, 'CALENDAR_CONFIG_MISSING', `calendar is not configured (missing: ${missing.join(', ')})`);
    }
    return { clientId: clientId.trim(), clientSecret: clientSecret.trim(), refreshToken: refreshToken.trim() };
}

function _clearTokenCacheForTests() {
    cached = null;
}

// Test seam: { fetchFn, env, signal }. Returns a cached token when fresh.
async function getAccessToken(opts = {}) {
    const fetchFn = opts.fetchFn || fetch;
    const env = opts.env || process.env;
    const now = Date.now();
    if (cached && cached.expiresAt - 60000 > now) return cached.token;
    const cfg = getCalendarConfig(env);
    let res;
    try {
        res = await fetchFn(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: cfg.clientId,
                client_secret: cfg.clientSecret,
                refresh_token: cfg.refreshToken,
                grant_type: 'refresh_token'
            }).toString(),
            signal: opts.signal || null
        });
    } catch (e) {
        if (e && (e.code === 'ABORTED' || e.name === 'AbortError')) {
            throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        }
        throw calendarError(400, 'CALENDAR_UPSTREAM', 'calendar token refresh failed (network)');
    }
    if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
            throw calendarError(400, 'CALENDAR_UNAUTHORIZED', 'calendar authorization rejected (invalid client or refresh token)');
        }
        throw calendarError(400, 'CALENDAR_UPSTREAM', 'calendar token refresh failed');
    }
    let data;
    try {
        data = await res.json();
    } catch {
        throw calendarError(400, 'CALENDAR_UPSTREAM', 'calendar token refresh returned invalid response');
    }
    if (!data || typeof data.access_token !== 'string' || !data.access_token) {
        throw calendarError(400, 'CALENDAR_UPSTREAM', 'calendar token refresh returned no access token');
    }
    const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in * 1000 : 3600000;
    cached = { token: data.access_token, expiresAt: now + ttl };
    return cached.token;
}

module.exports = {
    TOKEN_ENDPOINT,
    CALENDAR_READONLY_SCOPE,
    getCalendarConfig,
    getAccessToken,
    _clearTokenCacheForTests
};
