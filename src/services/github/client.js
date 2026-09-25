// Minimal GitHub REST client foundation — P2-D Phase A.
//
// Talks to https://api.github.com over HTTPS with a bearer token from
// ./auth.js. No new dependencies. GET-only: POST/PATCH/PUT/DELETE and
// arbitrary URLs are rejected before any network call, enforcing the
// read-only contract at the transport layer.
//
// Test seam: pass { fetchFn, getHeaders } to createGitHubClient() to inject
// a mock transport. Production code uses global fetch + auth.authHeaders.
//
// Security: the token lives only inside the Authorization header; every
// error message is scrubbed of token-shaped material before it leaves.
// Responses are returned as parsed; errors never embed response dumps.
const auth = require('./auth');

const API_BASE = 'https://api.github.com';

// Path must stay inside the GitHub REST API: absolute path starting with
// '/', no scheme/host, no protocol-relative '//', no backslashes.
function assertSafePath(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw githubError(400, 'GITHUB_UPSTREAM', 'github request path must be a /-rooted API path');
    }
    if (/[\\]/.test(path) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
        throw githubError(400, 'GITHUB_UPSTREAM', 'github request path must be a /-rooted API path');
    }
    // Encoded traversal (%2e/%2f, double-encoded) is rejected too.
    let decoded = path;
    try {
        decoded = decodeURIComponent(path);
    } catch {
        throw githubError(400, 'GITHUB_UPSTREAM', 'github request path has invalid encoding');
    }
    if (/(^|\/)\.\.(\/|$)/.test(decoded)) {
        throw githubError(400, 'GITHUB_UPSTREAM', 'github request path must not contain traversal');
    }
}

function githubError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

// Scrub anything that looks like credential material from outbound errors.
function scrub(text) {
    if (typeof text !== 'string') return 'github request failed';
    return text
        .replace(/ghp_[A-Za-z0-9]{10,}/g, '[redacted]')
        .replace(/github_pat_[A-Za-z0-9_]{10,}/g, '[redacted]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
        .slice(0, 300);
}

// 403 may mean permission-denied OR rate-limit exhaustion. When response
// headers (safely) indicate an exhausted rate limit, map to RATE_LIMITED.
function mapHttpStatus(status, headers, bodyText) {
    const detail = scrub(bodyText);
    if (status === 401) return githubError(400, 'GITHUB_UNAUTHORIZED', `github unauthorized: ${detail}`);
    if (status === 403) {
        const remaining = headers && typeof headers.get === 'function'
            ? headers.get('x-ratelimit-remaining')
            : (headers ? headers['x-ratelimit-remaining'] : null);
        if (remaining === '0' || remaining === 0) {
            return githubError(400, 'GITHUB_RATE_LIMITED', `github rate limited: ${detail}`);
        }
        return githubError(400, 'GITHUB_FORBIDDEN', `github forbidden: ${detail}`);
    }
    if (status === 404) return githubError(400, 'GITHUB_NOT_FOUND', `github resource not found: ${detail}`);
    if (status === 429) return githubError(400, 'GITHUB_RATE_LIMITED', `github rate limited: ${detail}`);
    return githubError(400, 'GITHUB_UPSTREAM', `github api error (${status}): ${detail}`);
}

function createGitHubClient(opts = {}) {
    const fetchFn = opts.fetchFn || fetch;
    const getHeaders = opts.getHeaders || ((o) => auth.authHeaders(o && o.env));

    // request(path, { query, signal }) — GET only, path restricted to API paths.
    async function request(path, { query = null, signal = null, method = 'GET' } = {}) {
        if (method !== 'GET') {
            throw githubError(400, 'GITHUB_UPSTREAM', `github client is read-only (rejected ${method})`);
        }
        assertSafePath(path);
        let headers;
        try {
            headers = await getHeaders({ signal });
        } catch (e) {
            throw e; // auth errors already carry GITHUB_* codes
        }
        let url = `${API_BASE}${path}`;
        if (query && typeof query === 'object') {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
            }
            const s = qs.toString();
            if (s) url += (url.includes('?') ? '&' : '?') + s;
        }
        let res;
        try {
            res = await fetchFn(url, { method: 'GET', headers, signal });
        } catch (e) {
            if (e && (e.code === 'ABORTED' || e.name === 'AbortError' || (signal && signal.aborted))) {
                throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
            }
            throw githubError(400, 'GITHUB_UPSTREAM', 'github request failed (network)');
        }
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        if (!res.ok) {
            let text = '';
            try {
                text = await res.text();
            } catch {
                text = '';
            }
            throw mapHttpStatus(res.status, res.headers, text);
        }
        try {
            return await res.json();
        } catch {
            throw githubError(400, 'GITHUB_UPSTREAM', 'github returned invalid response');
        }
    }

    return { request };
}

module.exports = { createGitHubClient, API_BASE, scrub };
