// Gmail OAuth for Native Tools (read-only).
//
// Separate from the Gmail MCP (@klodr/gmail-mcp), which uses its own
// GMAIL_OAUTH_PATH file credential. The MCP internals are never copied:
// the Native Tool authenticates directly against Google OAuth2 with the
// long-standing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
// GOOGLE_REFRESH_TOKEN environment variables (same ones already declared
// in .env.example and checked by workerMcpConfig.mcpCredentialStatus).
//
// Scope is strictly read-only: https://www.googleapis.com/auth/gmail.readonly
// Secrets never enter source code, logs, errors, or tool results.
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// In-memory access-token cache (per process, never persisted).
let cached = null; // { token, expiresAt }

function gmailError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function isPlaceholder(v) {
    return typeof v !== 'string' || !v.trim() || v.includes('your_') || v.includes('example');
}

// Reads OAuth config from env only. Throws GMAIL_CONFIG_MISSING (status 400
// so the code survives the ToolRegistry boundary verbatim) when incomplete.
function getGmailConfig(env) {
    const e = env || process.env;
    const clientId = e.GOOGLE_CLIENT_ID;
    const clientSecret = e.GOOGLE_CLIENT_SECRET;
    const refreshToken = e.GOOGLE_REFRESH_TOKEN;
    const missing = [];
    if (isPlaceholder(clientId)) missing.push('GOOGLE_CLIENT_ID');
    if (isPlaceholder(clientSecret)) missing.push('GOOGLE_CLIENT_SECRET');
    if (isPlaceholder(refreshToken)) missing.push('GOOGLE_REFRESH_TOKEN');
    if (missing.length) {
        // Names only — never values.
        throw gmailError(400, 'GMAIL_CONFIG_MISSING', `gmail is not configured (missing: ${missing.join(', ')})`);
    }
    return { clientId: clientId.trim(), clientSecret: clientSecret.trim(), refreshToken: refreshToken.trim() };
}

function _clearTokenCacheForTests() {
    cached = null;
}

async function getAccessToken(opts = {}) {
    const fetchFn = opts.fetchFn || fetch;
    const env = opts.env || process.env;
    const now = Date.now();
    if (cached && cached.expiresAt - 60000 > now) return cached.token;
    const cfg = getGmailConfig(env);
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
        throw gmailError(400, 'GMAIL_UPSTREAM', 'gmail token refresh failed (network)');
    }
    if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
            throw gmailError(400, 'GMAIL_UNAUTHORIZED', 'gmail authorization rejected (invalid client or refresh token)');
        }
        throw gmailError(400, 'GMAIL_UPSTREAM', 'gmail token refresh failed');
    }
    let data;
    try {
        data = await res.json();
    } catch {
        throw gmailError(400, 'GMAIL_UPSTREAM', 'gmail token refresh returned invalid response');
    }
    if (!data || typeof data.access_token !== 'string' || !data.access_token) {
        throw gmailError(400, 'GMAIL_UPSTREAM', 'gmail token refresh returned no access token');
    }
    const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in * 1000 : 3600000;
    cached = { token: data.access_token, expiresAt: now + ttl };
    return cached.token;
}

module.exports = {
    TOKEN_ENDPOINT,
    GMAIL_READONLY_SCOPE,
    getGmailConfig,
    getAccessToken,
    _clearTokenCacheForTests
};
