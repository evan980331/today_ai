// Calendar Native Tools (read-only): calendar.listCalendars /
// calendar.listEvents / calendar.getEvent.
//
// Built with defineTool() per the P2-A contract. Uses only the Phase A
// foundation (src/services/calendar/auth.js + client.js) — no second OAuth
// stack, no refresh-token handling here, no Calendar MCP involvement. Error
// mapping (CALENDAR_* / ABORTED / TIMEOUT) lives in the client and passes
// through untouched.
//
// The Agent Core never imports this file — tools reach execution only via
// Planner -> ToolRegistry.
//
// Test seam: setCalendarClientFactory(fn) injects a mock client factory;
// resetCalendarClientFactory() restores the real Calendar REST client.
const { defineTool } = require('./tool');

let clientFactory = null;

function setCalendarClientFactory(fn) {
    clientFactory = fn;
}

function resetCalendarClientFactory() {
    clientFactory = null;
}

function getClient() {
    if (clientFactory) return clientFactory();
    const { createCalendarClient } = require('../calendar/client');
    return createCalendarClient();
}

function inputError(toolName, message) {
    return Object.assign(new Error(`${toolName}: ${message}`), { status: 400, code: 'TOOL_INVALID_INPUT' });
}

function checkAborted(ctx) {
    if (ctx && ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
}

function asObject(toolName, input) {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw inputError(toolName, 'input must be an object');
    }
    return input;
}

function checkMaxResults(toolName, value, def, min, max) {
    if (value === undefined || value === null) return def;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw inputError(toolName, `maxResults must be an integer between ${min} and ${max}`);
    }
    return value;
}

function checkPageToken(toolName, value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !value) {
        throw inputError(toolName, 'pageToken must be a non-empty string when provided');
    }
    return value;
}

function checkId(toolName, field, value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw inputError(toolName, `${field} must be a non-empty string`);
    }
    return value.trim();
}

function checkTimeBound(toolName, field, value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value.trim()))) {
        throw inputError(toolName, `${field} must be an ISO date-time string when provided`);
    }
    return value.trim();
}

function pickStartEnd(ev) {
    const start = ev && typeof ev.start === 'object' && ev.start !== null ? ev.start : null;
    const end = ev && typeof ev.end === 'object' && ev.end !== null ? ev.end : null;
    return { start, end };
}

// --- Tool definitions -----------------------------------------------------

const calendarListCalendars = defineTool({
    name: 'calendar.listCalendars',
    capabilities: ['calendar.read'],
    description: 'List Google Calendars visible to the user (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            maxResults: { type: 'number', description: 'max calendars to return (1-250)' },
            pageToken: { type: 'string', description: 'pagination token from a previous call' }
        }
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: the deterministic planner passes the raw prompt string
        // as step input; listCalendars takes no required input, so a bare
        // string is treated as {} (ignored).
        if (typeof input === 'string') input = {};
        const obj = asObject('calendar.listCalendars', input);
        const maxResults = checkMaxResults('calendar.listCalendars', obj.maxResults, undefined, 1, 250);
        const pageToken = checkPageToken('calendar.listCalendars', obj.pageToken);
        const client = getClient();
        const data = await client.request('/users/me/calendarList', {
            query: { maxResults, pageToken },
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const calendars = Array.isArray(data && data.items)
            ? data.items.map((c) => ({
                id: typeof c.id === 'string' ? c.id : '',
                summary: typeof c.summary === 'string' ? c.summary : '',
                description: typeof c.description === 'string' ? c.description : null,
                primary: c.primary === true,
                accessRole: typeof c.accessRole === 'string' ? c.accessRole : '',
                timeZone: typeof c.timeZone === 'string' ? c.timeZone : ''
            }))
            : [];
        return {
            result: {
                calendars,
                nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null
            },
            mcpTools: ['calendar.listCalendars']
        };
    }
});

const calendarListEvents = defineTool({
    name: 'calendar.listEvents',
    capabilities: ['calendar.read', 'calendar.search'],
    description: 'List events on a Google Calendar (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            calendarId: { type: 'string', description: 'calendar id, e.g. primary' },
            timeMin: { type: 'string', description: 'RFC3339 lower bound, e.g. 2026-09-01T00:00:00Z' },
            timeMax: { type: 'string', description: 'RFC3339 upper bound' },
            q: { type: 'string', description: 'free-text search query' },
            maxResults: { type: 'number', description: 'max events to return (1-2500, default 25)' },
            pageToken: { type: 'string', description: 'pagination token from a previous call' },
            singleEvents: { type: 'boolean', description: 'expand recurring events (default true)' },
            orderBy: { type: 'string', description: 'startTime or updated' }
        },
        required: ['calendarId']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        // Shorthand: a bare string is treated as { calendarId: input }.
        if (typeof input === 'string') input = { calendarId: input };
        const obj = asObject('calendar.listEvents', input);
        const calendarId = checkId('calendar.listEvents', 'calendarId', obj.calendarId);
        const timeMin = checkTimeBound('calendar.listEvents', 'timeMin', obj.timeMin);
        const timeMax = checkTimeBound('calendar.listEvents', 'timeMax', obj.timeMax);
        let q;
        if (obj.q !== undefined && obj.q !== null) {
            if (typeof obj.q !== 'string' || !obj.q.trim()) {
                throw inputError('calendar.listEvents', 'q must be a non-empty string when provided');
            }
            q = obj.q.trim().slice(0, 500);
        }
        const maxResults = checkMaxResults('calendar.listEvents', obj.maxResults, 25, 1, 2500);
        const pageToken = checkPageToken('calendar.listEvents', obj.pageToken);
        let singleEvents = true;
        if (obj.singleEvents !== undefined && obj.singleEvents !== null) {
            if (typeof obj.singleEvents !== 'boolean') {
                throw inputError('calendar.listEvents', 'singleEvents must be a boolean when provided');
            }
            singleEvents = obj.singleEvents;
        }
        let orderBy;
        if (obj.orderBy !== undefined && obj.orderBy !== null) {
            if (obj.orderBy !== 'startTime' && obj.orderBy !== 'updated') {
                throw inputError('calendar.listEvents', 'orderBy must be startTime or updated when provided');
            }
            orderBy = obj.orderBy;
        }
        const client = getClient();
        const data = await client.request(`/calendars/${encodeURIComponent(calendarId)}/events`, {
            query: { timeMin, timeMax, q, maxResults, pageToken, singleEvents, orderBy },
            signal: ctx && ctx.signal ? ctx.signal : null
        });
        checkAborted(ctx);
        const events = Array.isArray(data && data.items)
            ? data.items.map((ev) => {
                const { start, end } = pickStartEnd(ev);
                return {
                    id: typeof ev.id === 'string' ? ev.id : '',
                    status: typeof ev.status === 'string' ? ev.status : '',
                    summary: typeof ev.summary === 'string' ? ev.summary : '',
                    description: typeof ev.description === 'string' ? ev.description : null,
                    location: typeof ev.location === 'string' ? ev.location : null,
                    start,
                    end,
                    htmlLink: typeof ev.htmlLink === 'string' ? ev.htmlLink : null
                };
            })
            : [];
        return {
            result: {
                calendarId,
                events,
                nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null
            },
            mcpTools: ['calendar.listEvents']
        };
    }
});

const calendarGetEvent = defineTool({
    name: 'calendar.getEvent',
    capabilities: ['calendar.read'],
    description: 'Get a single Google Calendar event by id (read-only)',
    inputSchema: {
        type: 'object',
        properties: {
            calendarId: { type: 'string', description: 'calendar id, e.g. primary' },
            eventId: { type: 'string', description: 'event id' }
        },
        required: ['calendarId', 'eventId']
    },
    readOnly: true,
    needsApproval: false,
    execute: async (input, ctx) => {
        checkAborted(ctx);
        const obj = asObject('calendar.getEvent', input);
        const calendarId = checkId('calendar.getEvent', 'calendarId', obj.calendarId);
        const eventId = checkId('calendar.getEvent', 'eventId', obj.eventId);
        const client = getClient();
        const ev = await client.request(
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
            { signal: ctx && ctx.signal ? ctx.signal : null }
        );
        checkAborted(ctx);
        const { start, end } = pickStartEnd(ev);
        return {
            result: {
                id: typeof ev.id === 'string' ? ev.id : '',
                status: typeof ev.status === 'string' ? ev.status : '',
                summary: typeof ev.summary === 'string' ? ev.summary : '',
                description: typeof ev.description === 'string' ? ev.description : null,
                location: typeof ev.location === 'string' ? ev.location : null,
                start,
                end,
                htmlLink: typeof ev.htmlLink === 'string' ? ev.htmlLink : null,
                calendarId
            },
            mcpTools: ['calendar.getEvent']
        };
    }
});

module.exports = {
    calendarListCalendars,
    calendarListEvents,
    calendarGetEvent,
    setCalendarClientFactory,
    resetCalendarClientFactory
};
