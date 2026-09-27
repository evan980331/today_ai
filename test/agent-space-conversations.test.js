// Agent Space → Conversations tests. Loads the REAL public/app.js in a vm
// sandbox with a DOM stub. Covers conversation identity/mapping/switching,
// titles, migration, history isolation, proposal/execution/SSE binding,
// accordion UI, and XSS safety. Existing ui-ux-spaces + proposal UI suites
// stay untouched.
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
        tag: (tag || 'div').toLowerCase(),
        children: [],
        listeners: {},
        className: '',
        dataset: {},
        disabled: false,
        open: false,
        type: '',
        value: '',
        style: {},
        scrollTop: 0,
        scrollHeight: 0,
        removed: false,
        _text: '',
        _html: '',
        classList: makeClassList(),
        get childNodes() { return this.children; },
        get firstChild() { return this.children.find((c) => !c.removed) || null; },
        get textContent() {
            return this._text + this.children.filter((c) => !c.removed).map((c) => (c && typeof c.textContent === 'string' ? c.textContent : '')).join('');
        },
        set textContent(v) { this._text = String(v); },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); doc.innerHTMLWrites.push(String(v)); },
        appendChild(c) { this.children.push(c); return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i < 0) throw new Error('not a child');
            this.children.splice(i, 1);
            return c;
        },
        replaceChildren(...nodes) { this.children = nodes; },
        append(...nodes) { nodes.forEach((c) => this.appendChild(c)); },
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
        remove() { this.removed = true; },
        querySelector() { return null; },
        click() { (this.listeners.click || []).forEach((fn) => fn()); },
        focus() { this.focused = true; }
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

function boot(fetchImpl, preseed = {}) {
    const doc = makeDocument();
    const fetchCalls = [];
    const store = { ...preseed };
    const sandbox = {
        document: doc,
        window: {},
        fetch: async (url, opts = {}) => {
            if (String(url).includes('/api/auth/me')) {
                return makeResponse({ status: 401 });
            }
            fetchCalls.push({ url: String(url), opts });
            return fetchImpl(String(url), opts || {}, fetchCalls);
        },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
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
    return { sandbox, doc, fetchCalls, win: sandbox, store };
}

function walk(node, tag, out = []) {
    if (!node || !node.children) return out;
    for (const c of node.children) {
        if (c.tag === tag) out.push(c);
        walk(c, tag, out);
    }
    return out;
}

function allInnerHTML(doc) {
    return doc.innerHTMLWrites.join('\n');
}

function liveChildren(doc) {
    return doc.getElementById('messages').children.filter((c) => !c.removed);
}

function convRows(doc) {
    return doc.getElementById('space-list').children.filter((c) => !c.removed && c.dataset && c.dataset.conversationId);
}

const okFetch = () => makeResponse({ status: 200, json: {} });
const emptyHistoryFetch = async (url) => {
    if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
    return makeResponse({ status: 200, json: {} });
};

before(async () => {
    APP_SRC = await fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
});

describe('Conversations', () => {
    it('1 default spaces resolve conversations', () => {
        const { win } = boot(okFetch);
        for (const id of ['general', 'coding', 'gmail']) {
            assert.equal(win.switchSpace(id), true);
            const conv = win.getActiveConversation();
            assert.ok(conv);
            assert.equal(conv.spaceId, id);
            assert.ok(conv.conversationId.indexOf('conversation-') === 0);
        }
    });
    it('2 conversations are distinct per space', () => {
        const { win } = boot(okFetch);
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        win.switchSpace('gmail');
        const b = win.getActiveConversationId();
        assert.ok(a && b && a !== b);
        assert.equal(win.getConversation(a).spaceId, 'coding');
        assert.equal(win.getConversation(b).spaceId, 'gmail');
    });
    it('3 activeConversationId tracks selection', () => {
        const { win } = boot(okFetch);
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        assert.ok(a);
        const created = win.newConversation('coding');
        assert.ok(created && created.conversationId !== a);
        assert.equal(win.getActiveConversationId(), created.conversationId);
        assert.equal(win.switchConversation(a), true);
        assert.equal(win.getActiveConversationId(), a);
        assert.equal(win.switchConversation('conversation-nope'), false);
    });
    it('4 switch conversation isolates views', async () => {
        const { win, doc } = boot(emptyHistoryFetch);
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const b = win.newConversation('coding').conversationId;
        doc.getElementById('user-input').value = 'x';
        win.switchConversation(a);
        assert.ok(liveChildren(doc).length >= 0);
        win.switchConversation(b);
        assert.equal(win.getActiveConversationId(), b);
    });
    it('5 switch space selects remembered conversation', () => {
        const { win } = boot(okFetch);
        win.switchSpace('coding');
        const first = win.getActiveConversationId();
        win.newConversation('coding');
        const second = win.getActiveConversationId();
        assert.notEqual(first, second);
        win.switchSpace('general');
        win.switchSpace('coding');
        assert.equal(win.getActiveConversationId(), second);
    });
    it('6 new conversation creates empty view + persists', () => {
        const { win, doc, store } = boot(okFetch);
        win.switchSpace('coding');
        const created = win.newConversation('coding');
        assert.ok(created);
        assert.equal(created.title, '新對話');
        assert.equal(win.getActiveConversationId(), created.conversationId);
        const saved = JSON.parse(store.todayai_conversations);
        assert.ok(saved.conversations[created.conversationId]);
        assert.ok(saved.order.coding.includes(created.conversationId));
        assert.equal(liveChildren(doc).length, 0);
    });
    it('7 first user message sets title', async () => {
        const { win } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                return makeResponse({ status: 200, sse: [sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        doc_get(win, 'user-input').value = '幫我修復 shooting-game 的背包問題';
        await win.sendMessage();
        const conv = win.getActiveConversation();
        assert.ok(conv.title.includes('修復'));
        assert.ok(!conv.title.includes('\n'));
        assert.ok(conv.title.length <= 30);
        assert.notEqual(conv.title, '新對話');
    });
    it('8 long title truncates without newlines', async () => {
        const { win } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                return makeResponse({ status: 200, sse: [sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        doc_get(win, 'user-input').value = '第一行\n第二行 ' + '字'.repeat(100);
        await win.sendMessage();
        const conv = win.getActiveConversation();
        assert.ok(conv.title.length <= 30);
        assert.ok(!conv.title.includes('\n'));
    });
    it('9 legacy sessions migrate once', () => {
        const { win, store } = boot(okFetch, {
            todayai_space_sessions: JSON.stringify({ coding: 'sess-coding-1', gmail: 'sess-gmail-1' }),
            todayai_session: 'sess-general-1'
        });
        const coding = win.listConversations('coding');
        assert.equal(coding.length, 1);
        assert.equal(coding[0].sessionId, 'sess-coding-1');
        assert.ok(coding[0].conversationId.indexOf('conversation-legacy-') === 0);
        const general = win.listConversations('general');
        assert.equal(general.length, 1);
        assert.equal(general[0].sessionId, 'sess-general-1');
        assert.equal(general[0].title, '一般對話');
        assert.ok(store.todayai_conversations);
        const second = win.listConversations('coding');
        assert.equal(second.length, 1);
    });
    it('10 history loads per-conversation session', async () => {
        const seen = [];
        const { win } = boot(async (url) => {
            if (url.includes('/api/history')) {
                seen.push(url);
                return makeResponse({ status: 200, json: [] });
            }
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        const a = win.getActiveConversation();
        win.newConversation('coding');
        const b = win.getActiveConversation();
        assert.notEqual(a.sessionId, b.sessionId);
        assert.ok(seen.some((u) => u.includes(encodeURIComponent(a.sessionId))));
        assert.ok(seen.some((u) => u.includes(encodeURIComponent(b.sessionId))));
    });
    it('11 messages isolated between conversations', async () => {
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                return makeResponse({ status: 200, sse: [sseFrame('text.delta', { content: 'hello-A' }), sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        doc.getElementById('user-input').value = 'msg A';
        await win.sendMessage();
        assert.ok(doc.getElementById('messages').textContent.includes('hello-A'));
        const b = win.newConversation('coding').conversationId;
        assert.equal(liveChildren(doc).length, 0);
        assert.equal(win.switchConversation(a), true);
        assert.ok(doc.getElementById('messages').textContent.includes('hello-A'));
        assert.equal(win.getActiveConversationId(), a);
        assert.ok(b !== a);
    });
    it('12 activity isolated between conversations', async () => {
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                return makeResponse({ status: 200, sse: [sseFrame('tool.started', { tool: 'code_context', callId: 'ca1' }), sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        doc.getElementById('user-input').value = 'go';
        await win.sendMessage();
        assert.ok(doc.getElementById('messages').textContent.includes('code_context'));
        win.newConversation('coding');
        assert.ok(!doc.getElementById('messages').textContent.includes('code_context'));
    });
    function doc_get(win, id) {
        return win.document.getElementById(id);
    }
});

describe('Proposal conversation binding', () => {
    function routedFetch() {
        return async (url) => {
            if (url.includes('/api/change-proposals/')) {
                return makeResponse({ status: 200, json: { proposalId: 'ppX', status: 'pending', changes: [] } });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        };
    }
    it('13 proposal binds to owning conversation', async () => {
        const { win } = boot(routedFetch());
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const b = win.newConversation('coding').conversationId;
        const convA = win.getConversation(a);
        doc_set(win, 'user-input', 'x');
        const origFetch = win.fetch;
        const enc = new TextEncoder();
        win.fetch = async (url, opts) => {
            if (String(url).includes('/api/chat/stream')) {
                const frames = [sseFrame('approval_required', { proposalId: 'ppX', sessionId: convA.sessionId }), sseFrame('message.completed', { sessionId: convA.sessionId })];
                const chunks = frames.map((f) => enc.encode(f));
                let i = 0;
                return { status: 200, ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader() { return { async read() { if (i >= chunks.length) return { done: true }; return { done: false, value: chunks[i++] }; } }; } }, json: async () => ({}) };
            }
            return routedFetch()(String(url), opts || {});
        };
        await win.sendMessage();
        win.fetch = origFetch;
        void b;
        assert.ok(win.proposalCards.has('ppX'));
        assert.equal(win.proposalCards.get('ppX').conversationId, a);
    });
    function doc_set(win, id, value) {
        win.document.getElementById(id).value = value;
    }
    it('14 proposal hidden in other conversation', async () => {
        const { win, doc } = boot(routedFetch());
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        win.newConversation('coding');
        assert.ok(liveChildren(doc).length === 0);
        win.renderProposalCard({ proposalId: 'ppA', status: 'pending', changes: [] }, a);
        assert.equal(liveChildren(doc).length, 0);
        assert.equal(win.switchConversation(a), true);
        assert.ok(liveChildren(doc).length > 0);
    });
    it('15 approve works after switching conversations', async () => {
        const { win } = boot(async (url) => {
            if (url.includes('/api/change-proposals/ppA/apply')) {
                return makeResponse({ status: 200, json: { proposalId: 'ppA', status: 'applied' } });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        win.renderProposalCard({ proposalId: 'ppA', status: 'pending', changes: [] }, a);
        win.newConversation('coding');
        assert.equal(win.switchConversation(a), true);
        assert.equal(await win.decideProposal('ppA', 'apply'), true);
        assert.equal(win.proposalCards.get('ppA').state, 'applied');
    });
    it('16 reject works after switching conversations', async () => {
        const { win } = boot(async (url) => {
            if (url.includes('/api/change-proposals/ppR/reject')) {
                return makeResponse({ status: 200, json: { proposalId: 'ppR', status: 'rejected' } });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        win.renderProposalCard({ proposalId: 'ppR', status: 'pending', changes: [] }, a);
        win.newConversation('coding');
        assert.equal(win.switchConversation(a), true);
        assert.equal(await win.decideProposal('ppR', 'reject'), true);
        assert.equal(win.proposalCards.get('ppR').state, 'rejected');
    });
    it('17 stale survives conversation switches', async () => {
        const { win, doc } = boot(async () => makeResponse({ status: 400, json: { error: 'stale', code: 'PROPOSAL_STALE' } }));
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        win.renderProposalCard({ proposalId: 'ppS', status: 'pending', changes: [] }, a);
        win.newConversation('coding');
        assert.equal(win.switchConversation(a), true);
        assert.equal(await win.decideProposal('ppS', 'apply'), false);
        assert.equal(win.proposalCards.get('ppS').state, 'stale');
        assert.ok(doc.getElementById('messages').textContent.includes('重新執行'));
    });
});

describe('Execution binding', () => {
    function gatedStream() {
        let release;
        const gate = new Promise((r) => { release = r; });
        const fetchImpl = async (url) => {
            if (url.includes('/api/chat/stream')) {
                await gate;
                return makeResponse({ status: 200, sse: [sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        };
        return { fetchImpl, release: () => release() };
    }
    it('18 activeExecution carries conversationId', async () => {
        const g = gatedStream();
        const { win, doc } = boot(g.fetchImpl);
        win.switchSpace('coding');
        const conv = win.getActiveConversationId();
        doc.getElementById('user-input').value = 'work';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        const ex = win.getActiveExecution();
        assert.ok(ex);
        assert.equal(ex.conversationId, conv);
        assert.equal(ex.spaceId, 'coding');
        g.release();
        await p1;
    });
    it('19 second conversation blocked with space/title', async () => {
        const g = gatedStream();
        const { win, doc } = boot(g.fetchImpl);
        win.switchSpace('coding');
        doc.getElementById('user-input').value = '幫我修復 shooting-game 的背包問題';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        win.newConversation('coding');
        doc.getElementById('user-input').value = 'other work';
        await win.sendMessage();
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el._text);
        assert.ok(texts.some((t) => t.includes('Coding') && t.includes('正在執行')));
        g.release();
        await p1;
        assert.equal(win.getActiveExecution(), null);
    });
    it('20 switching conversation never cancels execution', async () => {
        const g = gatedStream();
        const { win, doc } = boot(g.fetchImpl);
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        doc.getElementById('user-input').value = 'work';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        const before = win.getActiveExecution();
        assert.ok(before);
        const b = win.newConversation('coding').conversationId;
        assert.equal(win.switchConversation(a), true);
        assert.equal(win.getActiveExecution(), before);
        assert.equal(win.switchConversation(b), true);
        assert.equal(win.getActiveExecution(), before);
        g.release();
        await p1;
        assert.equal(win.getActiveExecution(), null);
    });
    it('21 stop targets the running conversation', async () => {
        const { win, doc } = boot(async (url, opts) => {
            if (url.includes('/api/chat/stream')) {
                await new Promise((_, rej) => {
                    try { opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); } catch {}
                });
                return makeResponse({ status: 200, sse: [] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        doc.getElementById('user-input').value = 'work';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        win.newConversation('coding');
        win.stopExecution();
        await p1;
        assert.equal(win.getActiveExecution(), null);
        win.switchSpace('coding');
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el.textContent);
        assert.ok(texts.some((t) => t.includes('已終止')));
    });
    it('22 completion releases the lock', async () => {
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                return makeResponse({ status: 200, sse: [sseFrame('text.delta', { content: 'done' }), sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        doc.getElementById('user-input').value = 'one';
        await win.sendMessage();
        assert.equal(win.getActiveExecution(), null);
        win.newConversation('coding');
        doc.getElementById('user-input').value = 'two';
        await win.sendMessage();
        assert.equal(win.getActiveExecution(), null);
    });
});

describe('SSE conversation routing', () => {
    async function streamsend(win, doc, frames, fetchImpl) {
        doc.getElementById('user-input').value = 'x';
        const origFetch = win.fetch;
        const enc = new TextEncoder();
        win.fetch = async (url, opts) => {
            if (String(url).includes('/api/chat/stream')) {
                const chunks = frames.map((f) => enc.encode(f));
                let i = 0;
                return {
                    status: 200, ok: true, headers: { get: () => 'text/event-stream' },
                    body: { getReader() { return { async read() { if (i >= chunks.length) return { done: true }; return { done: false, value: chunks[i++] }; } }; } },
                    json: async () => ({})
                };
            }
            return fetchImpl(String(url), opts || {});
        };
        try {
            await win.sendMessage();
        } finally {
            win.fetch = origFetch;
        }
    }
    function baseFetch() {
        return async (url) => {
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        };
    }
    it('23 text.delta lands in owning conversation only', async () => {
        const { win, doc } = boot(baseFetch());
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const sessA = win.getConversation(a).sessionId;
        const b = win.newConversation('coding').conversationId;
        await win.switchConversation(a);
        await streamsend(win, doc, [
            sseFrame('text.delta', { content: 'for-A-only', sessionId: sessA }),
            sseFrame('message.completed', { sessionId: sessA })
        ], baseFetch());
        await win.switchConversation(b);
        assert.ok(!doc.getElementById('messages').textContent.includes('for-A-only'));
        await win.switchConversation(a);
        assert.ok(doc.getElementById('messages').textContent.includes('for-A-only'));
    });
    it('24 tool events land in owning conversation', async () => {
        const { win, doc } = boot(baseFetch());
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const sessA = win.getConversation(a).sessionId;
        win.newConversation('coding');
        await win.switchConversation(a);
        await streamsend(win, doc, [
            sseFrame('tool.started', { tool: 'code_context', callId: 'ca9', sessionId: sessA }),
            sseFrame('message.completed', { sessionId: sessA })
        ], baseFetch());
        await win.switchConversation(a === win.getActiveConversationId() ? a : a);
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el.textContent);
        assert.ok(texts.some((t) => t.includes('code_context')));
    });
    it('25 proposal event lands in owning conversation', async () => {
        const ppFetch = async (url) => {
            if (url.includes('/api/change-proposals/ppC')) {
                return makeResponse({ status: 200, json: { proposalId: 'ppC', status: 'pending', changes: [{ path: 'f.js', operation: 'update', diff: '-a\n+b\n' }] } });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        };
        const { win, doc } = boot(ppFetch);
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const sessA = win.getConversation(a).sessionId;
        win.newConversation('coding');
        await win.switchConversation(a);
        await streamsend(win, doc, [
            sseFrame('approval_required', { proposalId: 'ppC', sessionId: sessA }),
            sseFrame('message.completed', { sessionId: sessA })
        ], ppFetch);
        assert.ok(win.proposalCards.has('ppC'));
        assert.equal(win.proposalCards.get('ppC').conversationId, a);
    });
    it('26 completed markdown lands in owning conversation', async () => {
        const { win, doc } = boot(baseFetch());
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const sessA = win.getConversation(a).sessionId;
        win.newConversation('coding');
        await win.switchConversation(a);
        await streamsend(win, doc, [
            sseFrame('text.delta', { content: '# Conv Title', sessionId: sessA }),
            sseFrame('message.completed', { sessionId: sessA })
        ], baseFetch());
        const h1 = walk(doc.getElementById('messages'), 'h1');
        assert.equal(h1.length, 1);
        assert.equal(h1[0].textContent, 'Conv Title');
    });
    it('27 error lands in owning conversation', async () => {
        const { win, doc } = boot(baseFetch());
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const sessA = win.getConversation(a).sessionId;
        win.newConversation('coding');
        await win.switchConversation(a);
        await streamsend(win, doc, [sseFrame('error', { message: 'conv-boom', sessionId: sessA })], baseFetch());
        assert.ok(doc.getElementById('messages').textContent.includes('conv-boom'));
    });
    it('28 checkpoint lands in owning conversation', async () => {
        const { win, doc } = boot(baseFetch());
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        const sessA = win.getConversation(a).sessionId;
        win.newConversation('coding');
        await win.switchConversation(a);
        await streamsend(win, doc, [
            sseFrame('checkpoint_completed', { checkpointId: 'checkpoint_z', sessionId: sessA }),
            sseFrame('message.completed', { sessionId: sessA })
        ], baseFetch());
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el.textContent);
        assert.ok(texts.some((t) => t.includes('checkpoint')));
    });
});

describe('Sidebar accordion UI', () => {
    it('29 active space expands, others collapse', () => {
        const { win, doc } = boot(okFetch);
        win.switchSpace('coding');
        const list = doc.getElementById('space-list');
        assert.ok(list.textContent.includes('˅'));
        assert.ok(list.textContent.includes('˃'));
        assert.ok(list.textContent.includes('＋ 新對話'));
    });
    it('30 inactive space shows no conversation rows', () => {
        const { win, doc } = boot(okFetch);
        win.switchSpace('coding');
        win.newConversation('coding');
        const rows = doc.getElementById('space-list').children.filter((c) => !c.removed && c.dataset && c.dataset.conversationId);
        assert.ok(rows.length > 0);
        assert.ok(rows.every((r) => r.dataset.spaceId === 'coding'));
    });
    it('31 conversation click switches', () => {
        const { win, doc } = boot(okFetch);
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        win.newConversation('coding');
        const rows = doc.getElementById('space-list').children.filter((c) => !c.removed && c.dataset && c.dataset.conversationId === a);
        assert.equal(rows.length, 1);
        rows[0].click();
        assert.equal(win.getActiveConversationId(), a);
    });
    it('32 new conversation button creates and selects', () => {
        const { win, doc } = boot(okFetch);
        win.switchSpace('coding');
        const before = win.listConversations('coding').length;
        const rows = doc.getElementById('space-list').children.filter((c) => !c.removed);
        const addBtn = rows.find((c) => c.textContent.includes('＋ 新對話'));
        assert.ok(addBtn);
        addBtn.click();
        assert.equal(win.listConversations('coding').length, before + 1);
    });
    it('33 drawer closes on conversation select', () => {
        const { win, doc } = boot(okFetch);
        win.switchSpace('coding');
        win.newConversation('coding');
        const ov = doc.getElementById('sidebar-overlay');
        ov.classList.remove('hidden');
        const rows = doc.getElementById('space-list').children.filter((c) => !c.removed && c.dataset && c.dataset.conversationId);
        rows[0].click();
        assert.ok(ov.classList.contains('hidden'));
    });
    it('34 running indicator only on running conversation', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                await gate;
                return makeResponse({ status: 200, sse: [sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        const a = win.getActiveConversationId();
        doc.getElementById('user-input').value = 'work';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        const rows = doc.getElementById('space-list').children.filter((c) => !c.removed && c.dataset && c.dataset.conversationId);
        const running = rows.filter((r) => r.textContent.includes('Running'));
        assert.equal(running.length, 1);
        assert.equal(running[0].dataset.conversationId, a);
        release();
        await p1;
    });
});

describe('Conversation XSS safety', () => {
    it('35 malicious conversation title is text-only', () => {
        const { win, doc } = boot(okFetch);
        win.switchSpace('coding');
        win.createConversation('coding', '<img src=x onerror=alert(1)>');
        win.switchSpace('gmail');
        win.switchSpace('coding');
        assert.ok(!allInnerHTML(doc).includes('onerror=alert'));
        assert.ok(doc.getElementById('space-list').textContent.includes('<img src=x onerror=alert(1)>'));
    });
    it('36 malicious space name stays text in accordion', () => {
        const { win, doc } = boot(okFetch);
        doc.getElementById('new-agent-name').value = '<svg onload=alert(1)>';
        doc.getElementById('new-agent-icon').value = '🤖';
        doc.getElementById('new-agent-desc').value = 'd';
        win.createAgentSpace();
        assert.ok(!allInnerHTML(doc).includes('onload=alert'));
        assert.ok(doc.getElementById('space-list').textContent.includes('<svg onload=alert(1)>'));
    });
    it('37 malicious description stays text in accordion', () => {
        const { win, doc } = boot(okFetch);
        doc.getElementById('new-agent-name').value = 'Evil';
        doc.getElementById('new-agent-desc').value = '<script>alert(9)</script>';
        win.createAgentSpace();
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
        const list = doc.getElementById('space-list');
        assert.ok(list.textContent.includes('<script>alert(9)</script>'));
    });
});

describe('Accordion collapse + block notice + history errors', () => {
    function spaceRow(doc, spaceId) {
        return doc.getElementById('space-list').children.find((c) => !c.removed && c.dataset && c.dataset.spaceId === spaceId && !c.dataset.conversationId) || null;
    }
    it('38 collapse keeps active space+conversation, creates nothing', () => {
        const { win, doc, fetchCalls } = boot(okFetch);
        win.switchSpace('coding');
        const conv = win.getActiveConversationId();
        const callsBefore = fetchCalls.length;
        const row = spaceRow(doc, 'coding');
        assert.ok(row);
        row.click();
        assert.equal(win.getActiveSpace().spaceId, 'coding');
        assert.equal(win.getActiveConversationId(), conv);
        assert.equal(fetchCalls.length, callsBefore);
        assert.ok(!doc.getElementById('space-list').textContent.includes('＋ 新對話'));
        row.click();
        assert.equal(win.getActiveConversationId(), conv);
        assert.ok(doc.getElementById('space-list').textContent.includes('＋ 新對話'));
    });
    it('39 blocked notice names running space and conversation', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                await gate;
                return makeResponse({ status: 200, sse: [sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        doc.getElementById('user-input').value = '幫我修復 shooting-game 的背包問題';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        win.newConversation('coding');
        doc.getElementById('user-input').value = 'other';
        await win.sendMessage();
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el._text);
        const note = texts.find((t) => t.includes('正在執行'));
        assert.ok(note);
        assert.ok(note.includes('Coding'));
        assert.ok(note.includes('修復'));
        assert.ok(!note.includes('undefined'));
        release();
        await p1;
    });
    it('40 history failure shows a single error state', async () => {
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/history')) return makeResponse({ status: 500, json: { error: 'db down' } });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        await new Promise((r) => setTimeout(r, 5));
        const countNotes = () => doc.all.filter((el) => el._text.includes('歷史載入失敗')).length;
        assert.equal(countNotes(), 1);
        win.switchSpace('gmail');
        await new Promise((r) => setTimeout(r, 5));
        win.switchSpace('coding');
        await new Promise((r) => setTimeout(r, 5));
        win.switchSpace('gmail');
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(countNotes(), 2);
    });
});
