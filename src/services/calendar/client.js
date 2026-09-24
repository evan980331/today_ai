// Minimal Google Calendar REST client foundation — P2-C Phase A.
//
// Talks to the official Calendar API (https://www.googleapis.com/calendar/v3)
// over HTTPS with an OAuth2 access token from ./auth.js. No googleapis
// dependency, no protocol reimplementation. This round provides only the
// transport foundation (auth injection, base URL, request helper, abort /
// timeout propagation, status normalization, credential-safe errors) so a
// future src/services/tools/calendar.js can add listCalendars / listEvents /
// getEvent without touching this boundary.
//
// Test seam: pass { fetchFn, getToken } to createCalendarClient() to inject
// a mock transport. Production code uses global fetch + auth.getAccessToken.
//
// Security: Authorization header is built per request and never stored;
// every error message is scrubbed of token-shaped material before it leaves.
const auth = require('./auth');

const API_BASE = 'https://www.googleapis.com/calendar/v3';

function calendarError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

// Scrub anything that looks like credential material from outbound errors.
function scrub(text) {
    if (typeof text !== 'string') return 'calendar request failed';
    return text
        .replace(/ya29\.[\w\-.~+/=]+/g, '[redacted]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
        .replace(/refresh_token=[^&\s]*/gi, 'refresh_token=[redacted]')
        .replace(/client_secret=[^&\s]*/gi, 'client_secret=[redacted]')
        .slice(0, 300);
}

function mapHttpStatus(status, bodyText) {
    const detail = scrub(bodyText);
    if (status === 401) return calendarError(400, 'CALENDAR_UNAUTHORIZED', `calendar unauthorized: ${detail}`);
    if (status === 403) return calendarError(400, 'CALENDAR_FORBIDDEN', `calendar forbidden: ${detail}`);
    if (status === 404) return calendarError(400, 'CALENDAR_NOT_FOUND', `calendar resource not found: ${detail}`);
    if (status === 429) return calendarError(400, 'CALENDAR_RATE_LIMITED', `calendar rate limited: ${detail}`);
    return calendarError(400, 'CALENDAR_UPSTREAM', `calendar api error (${status}): ${detail}`);
}

function createCalendarClient(opts = {}) {
    const fetchFn = opts.fetchFn || fetch;
    const getToken = opts.getToken || ((o) => auth.getAccessToken(o));

    // request(path, { method, query, body, signal }) — path starts with '/'.
    // query is a plain object of string/number values; body is JSON-encoded.
    async function request(path, { method = 'GET', query = null, body = null, signal = null } = {}) {
        let token;
        try {
            token = await getToken({ fetchFn, signal });
        } catch (e) {
            throw e; // auth errors already carry CALENDAR_* codes
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
            res = await fetchFn(url, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(body !== null ? { 'Content-Type': 'application/json' } : {})
                },
                ...(body !== null ? { body: JSON.stringify(body) } : {}),
                signal
            });
        } catch (e) {
            if (e && (e.code === 'ABORTED' || e.name === 'AbortError' || (signal && signal.aborted))) {
                throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
            }
            throw calendarError(400, 'CALENDAR_UPSTREAM', 'calendar request failed (network)');
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
            throw calendarError(400, 'CALENDAR_UPSTREAM', 'calendar returned invalid response');
        }
    }

    return { request };
}

module.exports = { createCalendarClient, API_BASE, scrub };
