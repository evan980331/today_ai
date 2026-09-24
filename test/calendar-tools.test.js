// P2-C Phase B: Native Calendar Tools tests (mock transport only).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const toolRegistry = require('../src/services/tools/toolRegistry');
const { registerNativeTools } = require('../src/services/tools/nativeTools');
const calTools = require('../src/services/tools/calendar');
const core = require('../src/agent/core');

const SECRET = 'ya29.cal-secret-must-not-leak';

function mockClient(overrides = {}) {
    return {
        request: async () => ({ items: [] }),
        ...overrides
    };
}

beforeEach(() => {
    toolRegistry._clearForTests();
    calTools.setCalendarClientFactory(() => mockClient({
        request: async (p, opts) => {
            if (p === '/users/me/calendarList') {
                return {
                    items: [
                        { id: 'primary', summary: 'Main', primary: true, accessRole: 'owner', timeZone: 'Asia/Taipei', extra: 'drop-me' }
                    ],
                    nextPageToken: 'tok123'
                };
            }
            if (/\/events$/.test(p)) {
                return {
                    items: [{
                        id: 'ev1', status: 'confirmed', summary: 'Standup',
                        description: 'daily', location: 'room 1',
                        start: { dateTime: '2026-09-25T09:00:00+08:00' },
                        end: { dateTime: '2026-09-25T09:30:00+08:00' },
                        htmlLink: 'https://x',
                        attendees: [{ email: 'a@x.com' }],
                        creator: { email: 'c@x.com' },
                        hangoutLink: 'https://meet/x'
                    }],
                    nextPageToken: null
                };
            }
            return {
                id: 'ev9', status: 'confirmed', summary: 'One',
                start: { date: '2026-09-26' }, end: { date: '2026-09-26' },
                attendees: [{ email: 'b@x.com' }]
            };
        }
    }));
});

afterEach(() => {
    calTools.resetCalendarClientFactory();
    toolRegistry._clearForTests();
});

describe('P2-C Phase B metadata', () => {
    it('A defineTool metadata (readOnly, no approval, frozen)', () => {
        const names = ['calendar.listCalendars', 'calendar.listEvents', 'calendar.getEvent'];
        const tools = [calTools.calendarListCalendars, calTools.calendarListEvents, calTools.calendarGetEvent];
        tools.forEach((t, i) => {
            assert.equal(t.name, names[i]);
            assert.ok(t.description && t.description.length > 0);
            assert.ok(t.inputSchema && typeof t.inputSchema === 'object');
            assert.equal(t.readOnly, true);
            assert.equal(t.needsApproval, false);
            assert.equal(typeof t.execute, 'function');
            assert.ok(Object.isFrozen(t));
        });
    });
});

describe('P2-C Phase B listCalendars', () => {
    it('B success + sanitized output + pagination', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('calendar.listCalendars', {});
        assert.deepEqual(out.result.calendars, [{
            id: 'primary', summary: 'Main', description: null,
            primary: true, accessRole: 'owner', timeZone: 'Asia/Taipei'
        }]);
        assert.equal(out.result.nextPageToken, 'tok123');
        assert.ok(out.mcpTools.includes('calendar.listCalendars'));
        assert.ok(!('extra' in out.result.calendars[0]));
    });
    it('B2 invalid input', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('calendar.listCalendars', { maxResults: 0 }), (e) => e.status === 400 && e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listCalendars', { maxResults: 251 }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listCalendars', { pageToken: 5 }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listCalendars', []), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
});

describe('P2-C Phase B listEvents', () => {
    it('C success + query params + time bounds + sanitized output', async () => {
        let seen = null;
        calTools.setCalendarClientFactory(() => mockClient({
            request: async (p, opts) => {
                seen = { p, opts };
                return { items: [] };
            }
        }));
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('calendar.listEvents', {
            calendarId: 'primary', timeMin: '2026-09-01T00:00:00Z',
            timeMax: '2026-10-01T00:00:00Z', q: 'standup',
            maxResults: 10, singleEvents: true, orderBy: 'startTime'
        });
        assert.ok(seen.p.includes('/calendars/primary/events'));
        assert.equal(seen.opts.query.q, 'standup');
        assert.equal(seen.opts.query.timeMin, '2026-09-01T00:00:00Z');
        assert.equal(out.result.calendarId, 'primary');
        assert.ok(out.mcpTools.includes('calendar.listEvents'));
    });
    it('C2 event fields sanitized (no attendees/creator/hangout)', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('calendar.listEvents', { calendarId: 'primary' });
        const ev = out.result.events[0];
        assert.equal(ev.id, 'ev1');
        assert.deepEqual(ev.start, { dateTime: '2026-09-25T09:00:00+08:00' });
        assert.ok(!('attendees' in ev) && !('creator' in ev) && !('hangoutLink' in ev));
        assert.equal(out.result.nextPageToken, null);
    });
    it('C3 invalid input', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('calendar.listEvents', {}), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listEvents', { calendarId: '' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listEvents', { calendarId: 'p', maxResults: 2501 }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listEvents', { calendarId: 'p', timeMin: 'not-a-date' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listEvents', { calendarId: 'p', orderBy: 'bogus' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.listEvents', { calendarId: 'p', singleEvents: 'yes' }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
});

describe('P2-C Phase B getEvent', () => {
    it('D success + sanitized output', async () => {
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('calendar.getEvent', { calendarId: 'primary', eventId: 'ev9' });
        assert.equal(out.result.id, 'ev9');
        assert.equal(out.result.calendarId, 'primary');
        assert.deepEqual(out.result.start, { date: '2026-09-26' });
        assert.ok(!('attendees' in out.result));
        assert.ok(out.mcpTools.includes('calendar.getEvent'));
    });
    it('D2 invalid input', async () => {
        registerNativeTools(toolRegistry);
        await assert.rejects(() => toolRegistry.execute('calendar.getEvent', {}), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.getEvent', { calendarId: 'p' }), (e) => e.code === 'TOOL_INVALID_INPUT');
        await assert.rejects(() => toolRegistry.execute('calendar.getEvent', { calendarId: 'p', eventId: '' }), (e) => e.code === 'TOOL_INVALID_INPUT');
    });
});

describe('P2-C Phase B errors + security', () => {
    it('E error propagation keeps CALENDAR_* codes', async () => {
        for (const code of ['CALENDAR_UNAUTHORIZED', 'CALENDAR_FORBIDDEN', 'CALENDAR_NOT_FOUND', 'CALENDAR_RATE_LIMITED', 'CALENDAR_UPSTREAM']) {
            calTools.setCalendarClientFactory(() => mockClient({
                request: async () => { throw Object.assign(new Error('x'), { code, status: 400 }); }
            }));
            registerNativeTools(toolRegistry);
            await assert.rejects(
                () => toolRegistry.execute('calendar.listCalendars', {}),
                (e) => e.code === code,
                code
            );
            toolRegistry._clearForTests();
        }
    });
    it('E2 ABORTED/TIMEOUT never wrapped', async () => {
        calTools.setCalendarClientFactory(() => mockClient({
            request: async () => new Promise(() => {})
        }));
        registerNativeTools(toolRegistry);
        const c = new AbortController();
        const p = toolRegistry.execute('calendar.listCalendars', {}, { signal: c.signal, timeoutMs: 5000 });
        c.abort();
        await assert.rejects(p, (e) => e.code === 'ABORTED');
        toolRegistry._clearForTests();
        registerNativeTools(toolRegistry);
        await assert.rejects(
            toolRegistry.execute('calendar.listCalendars', {}, { timeoutMs: 30 }),
            (e) => e.code === 'TIMEOUT'
        );
    });
    it('F tokens never in result; arbitrary URL not injectable', async () => {
        let seenUrl = null;
        calTools.setCalendarClientFactory(() => mockClient({
            request: async (p) => {
                seenUrl = p;
                return { items: [], summary: SECRET, description: SECRET };
            }
        }));
        registerNativeTools(toolRegistry);
        const out = await toolRegistry.execute('calendar.listEvents', { calendarId: '../../evil?x=1' });
        assert.ok(!JSON.stringify(out).includes(SECRET));
        // encodeURIComponent leaves '.' unescaped but encodes '/' and '?',
        // so the traversal collapses into a single path segment.
        assert.ok(!seenUrl.includes('../../'), 'raw traversal must not survive');
        assert.ok(seenUrl.includes('%2F'), 'slashes must be percent-encoded');
    });
});

describe('P2-C Phase B registration + core', () => {
    it('G nativeTools registers 3 calendar tools, idempotent', () => {
        const r1 = registerNativeTools(toolRegistry);
        for (const n of ['calendar.listCalendars', 'calendar.listEvents', 'calendar.getEvent']) {
            assert.ok(r1.registered.includes(n), n);
        }
        const r2 = registerNativeTools(toolRegistry);
        assert.deepEqual(r2.registered, []);
    });
    it('H Planner -> Registry -> Calendar Tool', async () => {
        registerNativeTools(toolRegistry);
        const planner = require('../src/agent/planner');
        for (const [tool, prompt, check] of [
            ['calendar.listCalendars', 'x', (o) => Array.isArray(o.result.calendars)],
            ['calendar.listEvents', 'primary', (o) => o.result.calendarId === 'primary'],
            ['calendar.getEvent', 'x', null]
        ]) {
            const steps = planner.plan({ prompt, tools: [tool] });
            assert.equal(steps[0].kind, 'tool');
            assert.equal(steps[0].name, tool);
        }
        const out = await core.run({ id: 'cal1', prompt: 'x', sessionId: 's', tools: ['calendar.listCalendars'] }, {});
        assert.ok(Array.isArray(out.result.calendars));
        assert.ok(out.mcpTools.includes('calendar.listCalendars'));
        // getEvent via core with bare prompt lacks IDs -> clean validation error, no API call
        await assert.rejects(
            () => core.run({ id: 'cal2', prompt: 'x', sessionId: 's', tools: ['calendar.getEvent'] }, {}),
            (e) => e.code === 'TOOL_INVALID_INPUT'
        );
    });
    it('core never imports calendar implementation', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'core.js'), 'utf8');
        assert.ok(!src.includes('calendar'), 'core must not reference calendar');
    });
});
