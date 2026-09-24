// Minimal Gmail REST client for Native Tools (read-only).
//
// Talks to the official Gmail API (https://gmail.googleapis.com) over HTTPS
// with an OAuth2 access token from ./auth.js. No googleapis dependency, no
// Gmail protocol reimplementation — only the three read-only endpoints the
// tools need: messages.list (search), messages.get, threads.list.
//
// Test seam: pass { fetchFn, getToken } to createGmailClient() to inject a
// mock transport. Production code uses global fetch + auth.getAccessToken.
//
// Security: Authorization header is built per request and never stored;
// every error message is scrubbed of token-shaped material before it leaves.
const auth = require('./auth');

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function gmailError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

// Scrub anything that looks like credential material from outbound errors.
function scrub(text) {
    if (typeof text !== 'string') return 'gmail request failed';
    return text
        .replace(/ya29\.[\w\-.~+/=]+/g, '[redacted]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
        .replace(/refresh_token=[^&\s]*/gi, 'refresh_token=[redacted]')
        .replace(/client_secret=[^&\s]*/gi, 'client_secret=[redacted]')
        .slice(0, 300);
}

function mapHttpStatus(status, bodyText) {
    const detail = scrub(bodyText);
    if (status === 401) return gmailError(400, 'GMAIL_UNAUTHORIZED', `gmail unauthorized: ${detail}`);
    if (status === 403) return gmailError(400, 'GMAIL_FORBIDDEN', `gmail forbidden: ${detail}`);
    if (status === 404) return gmailError(400, 'GMAIL_NOT_FOUND', `gmail resource not found: ${detail}`);
    if (status === 429) return gmailError(400, 'GMAIL_RATE_LIMITED', `gmail rate limited: ${detail}`);
    return gmailError(400, 'GMAIL_UPSTREAM', `gmail api error (${status}): ${detail}`);
}

function createGmailClient(opts = {}) {
    const fetchFn = opts.fetchFn || fetch;
    const getToken = opts.getToken || ((o) => auth.getAccessToken(o));

    async function request(path, { signal = null } = {}) {
        let token;
        try {
            token = await getToken({ fetchFn, signal });
        } catch (e) {
            throw e; // auth errors already carry GMAIL_* codes
        }
        let res;
        try {
            res = await fetchFn(`${API_BASE}${path}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal
            });
        } catch (e) {
            if (e && (e.code === 'ABORTED' || e.name === 'AbortError' || (signal && signal.aborted))) {
                throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
            }
            throw gmailError(400, 'GMAIL_UPSTREAM', 'gmail request failed (network)');
        }
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        if (!res.ok) {
            let text = '';
            try {
                text = await res.text();
            } catch {
                text = '';
            }
            throw mapHttpStatus(res.status, text);
        }
        try {
            return await res.json();
        } catch {
            throw gmailError(400, 'GMAIL_UPSTREAM', 'gmail returned invalid response');
        }
    }

    return {
        // Search = messages.list with q. Returns raw { messages, resultSizeEstimate }.
        async searchMessages({ query, maxResults = 10, signal = null } = {}) {
            const q = encodeURIComponent(query);
            return request(`/messages?q=${q}&maxResults=${maxResults}`, { signal });
        },
        async getMessage({ messageId, signal = null } = {}) {
            const id = encodeURIComponent(messageId);
            return request(`/messages/${id}?format=full`, { signal });
        },
        async listThreads({ query = '', maxResults = 10, signal = null } = {}) {
            const q = query ? `q=${encodeURIComponent(query)}&` : '';
            return request(`/threads?${q}maxResults=${maxResults}`, { signal });
        }
    };
}

module.exports = { createGmailClient, API_BASE, scrub };
