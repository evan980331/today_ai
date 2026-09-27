// P3-7 frontend approval UI tests. Loads the REAL public/app.js in a
// vm sandbox with a minimal DOM stub, then drives the actual
// renderProposalCard / decideProposal / sendMessage (SSE) code paths.
// No framework, no jsdom: only node:test + vm.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

let APP_SRC = '';

function makeClassList() {
    const set = new Set();
    return {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        toggle: (c) => { if (set.has(c)) set.delete(c); else set.add(c); },
        contains: (c) => set.has(c)
    };
}

function makeElement(tag, doc) {
    const el = {
        tag,
        children: [],
        listeners: {},
        className: '',
        dataset: {},
        disabled: false,
        open: false,
        type: '',
        style: {},
        scrollTop: 0,
        scrollHeight: 0,
        value: '',
        _text: '',
        _html: '',
        classList: makeClassList(),
        get childNodes() { return this.children; },
        get textContent() {
            return this._text + this.children.map((c) => (c && typeof c.textContent === 'string' ? c.textContent : '')).join('');
        },
        set textContent(v) { this._text = String(v); },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); doc.innerHTMLWrites.push(String(v)); },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
        remove() { this.removed = true; },
        querySelector() { return null; },
        click() { (this.listeners.click || []).forEach((fn) => fn()); }
    };
    doc.all.push(el);
    return el;
}

function makeDocument() {
    const doc = {
        all: [],
        innerHTMLWrites: [],
        byId: {},
        createElement(tag) { return makeElement(tag, doc); },
        getElementById(id) {
            if (!doc.byId[id]) doc.byId[id] = makeElement('div', doc);
            return doc.byId[id];
        }
    };
    return doc;
}

function makeResponse({ status = 200, json = null, sse = null } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => (sse ? 'text/event-stream' : (/json/i.test(k) ? 'application/json' : '')) },
        body: sse ? { getReader() { return sseReader(sse); } } : null,
        json: async () => JSON.parse(JSON.stringify(json))
    };
}

function sseReader(frames) {
    const enc = new TextEncoder();
    const chunks = frames.map((f) => enc.encode(f));
    let i = 0;
    return {
        async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
        }
    };
}

const sseFrame = (ev, obj) => `event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`;

// Boot a fresh sandbox per test group. fetchCalls logs every request;
// fetchImpl routes it (set by each test).
function boot(fetchImpl) {
    const doc = makeDocument();
    const fetchCalls = [];
    const store = {};
    const sandbox = {
        document: doc,
        window: {},
        fetch: async (url, opts = {}) => {
            // Logged-out baseline: no background history/session fetches.
            if (String(url).includes('/api/auth/me')) {
                return makeResponse({ status: 401 });
            }
            fetchCalls.push({ url: String(url), opts });
            return fetchImpl(String(url), opts || {}, fetchCalls);
        },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); }
        },
        crypto: require('node:crypto'),
        AbortController,
        TextDecoder,
        TextEncoder,
        setTimeout: (fn) => 0,
        clearTimeout: () => {},
        console
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(APP_SRC, sandbox, { filename: 'app.js' });
    return { sandbox, doc, fetchCalls, win: sandbox };
}

const PROPOSAL = {
    proposalId: 'prop_abc123',
    status: 'pending',
    workspaceId: 'ws_1',
    changes: [
        { path: 'src/foo.js', operation: 'update', diff: '--- a/src/foo.js\n+++ b/src/foo.js\n@@ -1,1 +1,1 @@\n-old line\n+new line\n' },
        { path: 'src/bar.js', operation: 'create', diff: '--- a/src/bar.js\n+++ b/src/bar.js\n@@ -0,0 +1,1 @@\n+new file\n' },
        { path: 'src/gone.js', operation: 'delete', diff: '--- a/src/gone.js\n+++ b/src/gone.js\n@@ -1,1 +0,0 @@\n-gone\n' }
    ]
};

const okFetch = () => makeResponse({ status: 200, json: {} });

before(async () => {
    APP_SRC = await fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
});

function findCard(doc, id) {
    return doc.all.find((el) => el.dataset && el.dataset.proposalId === id) || null;
}

function allInnerHTML(doc) {
    return doc.innerHTMLWrites.join('\n');
}

describe('P3-7 proposal card rendering', () => {
    it('1 approval payload renders a card', () => {
        const { win, doc } = boot(okFetch);
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const card = findCard(doc, 'prop_abc123');
        assert.ok(card);
        assert.ok(card.textContent.includes('需要批准修改'));
        assert.ok(card.textContent.includes('3 個檔案'));
        assert.ok(win.proposalCards.has('prop_abc123'));
    });
    it('2 multi-file diffs render per file', () => {
        const { win, doc } = boot(okFetch);
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const card = findCard(doc, 'prop_abc123');
        assert.ok(card.textContent.includes('src/foo.js'));
        assert.ok(card.textContent.includes('src/bar.js'));
        assert.ok(card.textContent.includes('src/gone.js'));
        assert.ok(card.textContent.includes('-old line'));
        assert.ok(card.textContent.includes('+new line'));
    });
    it('3 create/update/delete badges render', () => {
        const { win, doc } = boot(okFetch);
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const card = findCard(doc, 'prop_abc123');
        assert.ok(card.textContent.includes('更新'));
        assert.ok(card.textContent.includes('建立'));
        assert.ok(card.textContent.includes('刪除'));
    });
    it('4 XSS diff never executes', () => {
        const { win, doc } = boot(okFetch);
        const evil = JSON.parse(JSON.stringify(PROPOSAL));
        evil.changes[0].diff = '- x\n+ <script>alert(1)</script>\n';
        win.renderProposalCard(evil);
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
        const card = findCard(doc, 'prop_abc123');
        assert.ok(card.textContent.includes('<script>alert(1)</script>'));
    });
    it('5 XSS path never executes', () => {
        const { win, doc } = boot(okFetch);
        const evil = JSON.parse(JSON.stringify(PROPOSAL));
        evil.changes[0].path = '<img src=x onerror=alert(1)>';
        win.renderProposalCard(evil);
        assert.ok(!allInnerHTML(doc).includes('onerror=alert'));
        assert.ok(findCard(doc, 'prop_abc123').textContent.includes('<img src=x onerror=alert(1)>'));
    });
    it('6 XSS proposalId never executes', () => {
        const { win, doc } = boot(okFetch);
        const evil = JSON.parse(JSON.stringify(PROPOSAL));
        evil.proposalId = 'prop_"><script>alert(1)</script>';
        win.renderProposalCard(evil);
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
    });
    it('7 XSS error message never executes', async () => {
        const { win, doc } = boot(async () => makeResponse({ status: 500, json: { error: '<script>alert(1)</script>' } }));
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        await win.decideProposal('prop_abc123', 'apply');
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
        assert.ok(findCard(doc, 'prop_abc123').textContent.includes('<script>alert(1)</script>'));
    });
    it('8 server paths and secrets are never rendered', () => {
        const { win, doc } = boot(okFetch);
        const hostile = { ...JSON.parse(JSON.stringify(PROPOSAL)), rootPath: '/tmp/secret-root', owner: 'alice', env: { DATABASE_URL: 'x' }, workerSecret: 's3cr3t' };
        win.renderProposalCard(hostile);
        const text = findCard(doc, 'prop_abc123').textContent;
        assert.ok(!text.includes('/tmp/secret-root'));
        assert.ok(!text.includes('s3cr3t'));
        assert.ok(!text.includes('DATABASE_URL'));
    });
});

describe('P3-7 approve / reject flows', () => {
    it('9 approve posts to the apply endpoint', async () => {
        let seen = null;
        const { win } = boot(async (url, opts) => {
            seen = { url, opts };
            return makeResponse({ status: 200, json: { proposalId: 'prop_abc123', status: 'applied' } });
        });
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const ok = await win.decideProposal('prop_abc123', 'apply');
        assert.equal(ok, true);
        assert.ok(seen.url.includes('/api/change-proposals/prop_abc123/apply'));
        assert.equal(seen.opts.method, 'POST');
        assert.ok(JSON.parse(seen.opts.body).sessionId !== undefined);
        assert.equal(seen.opts.credentials, 'include');
    });
    it('10 approve double-click sends once', async () => {
        let count = 0;
        const { win } = boot(async () => {
            count += 1;
            await new Promise((r) => setTimeout(r, 5));
            return makeResponse({ status: 200, json: { proposalId: 'prop_abc123', status: 'applied' } });
        });
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const [a, b] = await Promise.all([win.decideProposal('prop_abc123', 'apply'), win.decideProposal('prop_abc123', 'apply')]);
        assert.equal(count, 1);
        assert.ok(a === true || b === true);
    });
    it('11 approve success disables buttons', async () => {
        const { win } = boot(async () => makeResponse({ status: 200, json: { proposalId: 'prop_abc123', status: 'applied' } }));
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        await win.decideProposal('prop_abc123', 'apply');
        const entry = win.proposalCards.get('prop_abc123');
        assert.equal(entry.state, 'applied');
        assert.equal(entry.approveBtn.disabled, true);
        assert.equal(entry.rejectBtn.disabled, true);
        assert.ok(entry.statusEl.textContent.includes('已套用'));
    });
    it('12 reject posts and disables', async () => {
        let seen = null;
        const { win } = boot(async (url, opts) => {
            seen = { url, opts };
            return makeResponse({ status: 200, json: { proposalId: 'prop_abc123', status: 'rejected' } });
        });
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const ok = await win.decideProposal('prop_abc123', 'reject');
        assert.equal(ok, true);
        assert.ok(seen.url.includes('/api/change-proposals/prop_abc123/reject'));
        const entry = win.proposalCards.get('prop_abc123');
        assert.equal(entry.state, 'rejected');
        assert.ok(entry.statusEl.textContent.includes('已拒絕'));
    });
    it('13 reject double-click sends once', async () => {
        let count = 0;
        const { win } = boot(async () => {
            count += 1;
            return makeResponse({ status: 200, json: { proposalId: 'prop_abc123', status: 'rejected' } });
        });
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        await Promise.all([win.decideProposal('prop_abc123', 'reject'), win.decideProposal('prop_abc123', 'reject')]);
        assert.equal(count, 1);
    });
    it('14 stale response disables approve without rerunning', async () => {
        let count = 0;
        const { win } = boot(async () => {
            count += 1;
            return makeResponse({ status: 400, json: { error: 'stale', code: 'PROPOSAL_STALE' } });
        });
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const ok = await win.decideProposal('prop_abc123', 'apply');
        assert.equal(ok, false);
        assert.equal(count, 1);
        const entry = win.proposalCards.get('prop_abc123');
        assert.equal(entry.state, 'stale');
        assert.equal(entry.approveBtn.disabled, true);
        assert.ok(entry.statusEl.textContent.includes('重新執行'));
    });
    it('15 error response shows the message', async () => {
        const { win } = boot(async () => makeResponse({ status: 500, json: { error: 'boom happened' } }));
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const ok = await win.decideProposal('prop_abc123', 'apply');
        assert.equal(ok, false);
        const entry = win.proposalCards.get('prop_abc123');
        assert.equal(entry.state, 'error');
        assert.ok(entry.statusEl.textContent.includes('boom happened'));
    });
    it('16 pending state keeps buttons enabled', () => {
        const { win } = boot(okFetch);
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const entry = win.proposalCards.get('prop_abc123');
        assert.equal(entry.state, 'pending');
        assert.equal(entry.approveBtn.disabled, false);
        assert.equal(entry.rejectBtn.disabled, false);
        assert.ok(entry.statusEl.textContent.includes('等待批准'));
    });
});

describe('P3-7 stream + safety behaviors', () => {
    async function streamWith(frames, fetchImpl) {
        const seen = [];
        const { win, doc } = boot(async (url, opts) => {
            seen.push(String(url));
            return fetchImpl(String(url), opts || {});
        });
        doc.getElementById('user-input').value = 'fix it';
        await win.sendMessage();
        return { win, doc, seen };
    }
    const streamFetch = (extra = {}) => async (url) => {
        if (url.includes('/api/chat/stream')) {
            return makeResponse({
                status: 200, sse: [
                    sseFrame('approval_required', { proposalId: 'prop_sse', ...(extra.approvalPayload || {}) }),
                    sseFrame('message.completed', { sessionId: 's' })
                ]
            });
        }
        if (url.includes('/api/change-proposals/prop_sse')) {
            return makeResponse({ status: 200, json: { proposalId: 'prop_sse', status: 'pending', changes: [{ path: 'x.js', operation: 'update', diff: '-a\n+b\n' }] } });
        }
        if (url.includes('/api/sessions')) return makeResponse({ status: 200, json: [] });
        return makeResponse({ status: 200, json: {} });
    };
    it('17 SSE approval_required (id only) fetches and renders', async () => {
        const { win, seen } = await streamWith(null, streamFetch());
        assert.ok(win.proposalCards.has('prop_sse'));
        assert.ok(seen.some((u) => u.includes('/api/change-proposals/prop_sse')));
    });
    it('18 SSE changes_applied updates the card', async () => {
        const { win } = boot(okFetch);
        win.renderProposalCard({ proposalId: 'prop_x', status: 'pending', changes: [] });
        win.updateProposalCard({ type: 'changes_applied', proposalId: 'prop_x' });
        assert.equal(win.proposalCards.get('prop_x').state, 'applied');
        win.updateProposalCard({ type: 'proposal_stale', proposalId: 'prop_x' });
        assert.equal(win.proposalCards.get('prop_x').state, 'stale');
    });
    it('19 pending cards show a waiting note, not completion', async () => {
        const { win, doc } = await streamWith(null, streamFetch());
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el._text);
        assert.ok(texts.some((t) => t.includes('等待批准')));
    });
    it('20 Stop never applies anything', async () => {
        const { win } = boot(async () => {
            throw new Error('fetch must not run on stop');
        });
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        win.stopExecution();
        assert.equal(win.proposalCards.get('prop_abc123').state, 'pending');
    });
    it('21 mobile-safe diff overflow classes', () => {
        const { win, doc } = boot(okFetch);
        win.renderProposalCard(JSON.parse(JSON.stringify(PROPOSAL)));
        const card = findCard(doc, 'prop_abc123');
        const dump = JSON.stringify(card, (k, v) => (k === 'children' ? v : (k === 'listeners' ? undefined : v)));
        assert.ok(dump.includes('overflow-auto'));
        assert.ok(dump.includes('max-h-64'));
        assert.ok(dump.includes('min-h-[44px]'));
    });
    it('22 no duplicate waiting note across streams', async () => {
        const maker = (url) => streamFetch({
            approvalPayload: { proposalId: 'prop_sse', status: 'pending', changes: [{ path: 'x.js', operation: 'update', diff: '-a\n+b\n' }] }
        })(url);
        const { win, doc } = await streamWith(null, maker);
        const countNotes = () => doc.all.filter((el) => el._text.includes('等待批准') && el.tag === 'div').length;
        const before = countNotes();
        assert.ok(before >= 1);
        doc.getElementById('user-input').value = 'again';
        await win.sendMessage();
        assert.equal(countNotes(), before);
    });
});
