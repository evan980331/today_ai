// UI/UX refactor tests: safe Markdown, Multi-Agent Spaces, single-flight
// execution, SSE routing, P3 regression. Loads the REAL public/app.js in a
// vm sandbox with an extended DOM stub (adds firstChild/removeChild/
// replaceChildren for view switching).
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

function renderToHost(doc, win, text) {
    const host = doc.createElement('div');
    win.renderMarkdownInto(host, text);
    return host;
}

const okFetch = () => makeResponse({ status: 200, json: {} });

before(async () => {
    APP_SRC = await fsp.readFile(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
});

describe('Markdown blocks', () => {
    it('M1 headings h1-h3', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '# H1\n## H2\n### H3');
        const h1 = walk(host, 'h1');
        const h2 = walk(host, 'h2');
        const h3 = walk(host, 'h3');
        assert.equal(h1.length, 1);
        assert.equal(h1[0].textContent, 'H1');
        assert.equal(h2[0].textContent, 'H2');
        assert.equal(h3[0].textContent, 'H3');
    });
    it('M2 bold and italic inline', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '這是 **粗體** 與 *斜體* 文字');
        assert.equal(walk(host, 'strong')[0].textContent, '粗體');
        assert.equal(walk(host, 'em')[0].textContent, '斜體');
        assert.ok(host.textContent.includes('這是'));
    });
    it('M3 unordered and ordered lists', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '- a\n- b\n\n1. one\n2. two');
        assert.equal(walk(host, 'ul').length, 1);
        assert.equal(walk(host, 'ol').length, 1);
        assert.equal(walk(host, 'li').length, 4);
        assert.equal(walk(host, 'li')[2].textContent, 'one');
    });
    it('M4 inline code', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '執行 `npm test` 看看');
        assert.equal(walk(host, 'code')[0].textContent, 'npm test');
    });
    it('M5 fenced code block with lang + inert content', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '```js\nconst x = "<script>alert(1)</script>";\n```');
        const pres = walk(host, 'pre');
        assert.equal(pres.length, 1);
        assert.ok(pres[0].className.includes('overflow-x-auto'));
        assert.ok(walk(host, 'code')[0].textContent.includes('<script>alert(1)</script>'));
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
        assert.ok(host.textContent.includes('js'));
    });
    it('M6 blockquote', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '> quoted **bold**');
        const qs = walk(host, 'blockquote');
        assert.equal(qs.length, 1);
        assert.ok(qs[0].textContent.includes('quoted'));
        assert.equal(walk(host, 'strong').length, 1);
    });
    it('M7 table structure + scroll wrapper, injection safe', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '| Name | Value |\n|---|---|\n| A<script> | 1 |\n| B | 2 |');
        assert.equal(walk(host, 'table').length, 1);
        assert.equal(walk(host, 'th').length, 2);
        assert.equal(walk(host, 'td').length, 4);
        assert.ok(walk(host, 'td')[0].textContent.includes('<script>'));
        assert.ok(!allInnerHTML(doc).includes('<script>'));
        const dump = JSON.stringify(host);
        assert.ok(dump.includes('overflow-x-auto'));
        assert.ok(dump.includes('max-w-full') || dump.includes('max-w-'));
    });
});

describe('Markdown links, raw HTML, URLs', () => {
    it('M8 https link gets target/rel', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '看 [文件](https://example.com/a?b=1) 吧');
        const as = walk(host, 'a');
        assert.equal(as.length, 1);
        assert.equal(as[0].href, 'https://example.com/a?b=1');
        assert.equal(as[0].target, '_blank');
        assert.equal(as[0].rel, 'noopener noreferrer');
        assert.equal(as[0].textContent, '文件');
    });
    it('M9 mailto link allowed', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '[寫信](mailto:a@b.com)');
        assert.equal(walk(host, 'a').length, 1);
    });
    it('M10 javascript: URL blocked as text', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '[x](javascript:alert(1))');
        assert.equal(walk(host, 'a').length, 0);
        assert.ok(host.textContent.includes('javascript:alert(1)'));
        assert.ok(!allInnerHTML(doc).includes('<a'));
    });
    it('M11 data: URL blocked as text', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '[x](data:text/html,<script>alert(1)</script>)');
        assert.equal(walk(host, 'a').length, 0);
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
    });
    it('M12 raw script tag is inert text', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, 'hi <script>alert(1)</script> bye');
        assert.ok(host.textContent.includes('<script>alert(1)</script>'));
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
    });
    it('M13 img onerror is inert text', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '<img src=x onerror=alert(1)>');
        assert.ok(host.textContent.includes('onerror=alert(1)'));
        assert.ok(!allInnerHTML(doc).includes('onerror=alert'));
    });
    it('M14 onclick div is inert text', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '<div onclick="alert(1)">test</div>');
        assert.ok(host.textContent.includes('test'));
        assert.ok(!allInnerHTML(doc).includes('onclick='));
    });
    it('M15 mixed inline formatting', () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '這是一段 **粗體**、`code` 與 [link](https://e.com)。');
        assert.equal(walk(host, 'strong')[0].textContent, '粗體');
        assert.equal(walk(host, 'code')[0].textContent, 'code');
        assert.equal(walk(host, 'a')[0].textContent, 'link');
    });
    it('M16 copy button copies raw code, min touch size', async () => {
        const { win, doc } = boot(okFetch);
        const host = renderToHost(doc, win, '```js\nconst a = 1;\n```');
        const btns = walk(host, 'button');
        assert.equal(btns.length, 1);
        assert.ok(btns[0].className.includes('min-h-[44px]'));
        let copied = null;
        win.navigator = { clipboard: { writeText: async (t) => { copied = t; } } };
        btns[0].click();
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(copied, 'const a = 1;');
    });
});

describe('Spaces', () => {
    it('S1 six default spaces with stable ids', () => {
        const { win } = boot(okFetch);
        // Array.from: vm-realm arrays fail cross-realm deepStrictEqual.
        assert.deepEqual(Array.from(win.allSpaces().map((s) => s.spaceId)), ['general', 'coding', 'gmail', 'calendar', 'morning', 'evening']);
    });
    it('S2 active space defaults to general', () => {
        const { win } = boot(okFetch);
        assert.equal(win.getActiveSpace().spaceId, 'general');
    });
    it('S3 per-space sessions distinct and persisted', () => {
        const { win, store } = boot(okFetch);
        const g = win.getSpaceSession('general');
        const c = win.getSpaceSession('coding');
        assert.ok(g && c && g !== c);
        const saved = JSON.parse(store.todayai_space_sessions);
        assert.equal(saved.general, g);
        assert.equal(saved.coding, c);
        assert.equal(win.getSpaceSession('general'), g);
    });
    it('S4 switch isolates messages per space', () => {
        const { win, doc } = boot(okFetch);
        const messages = doc.getElementById('messages');
        assert.equal(win.switchSpace('coding'), true);
        assert.equal(win.getActiveSpace().spaceId, 'coding');
        win.renderProposalCard({ proposalId: 'p1', status: 'pending', changes: [] });
        assert.ok(messages.children.length > 0);
        assert.equal(win.switchSpace('general'), true);
        assert.equal(messages.children.length, 0);
        assert.equal(win.switchSpace('coding'), true);
        assert.ok(messages.children.length > 0);
        assert.ok(win.proposalCards.get('p1').spaceId === 'coding');
    });
    it('S5 custom space create + validation', () => {
        const { win, doc } = boot(okFetch);
        assert.equal(win.allSpaces().length, 6);
        doc_set(win, doc, 'new-agent-name', 'Review');
        doc_set(win, doc, 'new-agent-icon', '🔍');
        doc_set(win, doc, 'new-agent-desc', 'code review');
        assert.equal(win.createAgentSpace(), true);
        assert.equal(win.allSpaces().length, 7);
        const created = win.allSpaces()[6];
        assert.ok(created.spaceId.indexOf('custom-') === 0);
        assert.equal(win.getActiveSpace().spaceId, created.spaceId);
        doc_set(win, doc, 'new-agent-name', '');
        assert.equal(win.createAgentSpace(), false);
        assert.equal(win.allSpaces().length, 7);
    });
    it('S6 malicious space name and description are text-only', () => {
        const { win, doc } = boot(okFetch);
        doc_set(win, doc, 'new-agent-name', '<img src=x onerror=alert(1)>');
        doc_set(win, doc, 'new-agent-desc', '<script>alert(2)</script>');
        win.createAgentSpace();
        assert.ok(!allInnerHTML(doc).includes('onerror=alert'));
        assert.ok(!allInnerHTML(doc).includes('<script>alert'));
        const list = doc.getElementById('space-list');
        assert.ok(list.textContent.includes('<img src=x onerror=alert(1)>'));
    });
    it('S7 legacy session migrates to General', () => {
        const { win, store } = boot(okFetch, { todayai_session: 'legacy-1' });
        assert.equal(win.getSpaceSession('general'), 'legacy-1');
        assert.ok(!('todayai_session' in store));
    });
    it('S8 rename keeps identity via spaceId', () => {
        const { win, doc } = boot(okFetch);
        doc_set(win, doc, 'new-agent-name', 'Dev');
        win.createAgentSpace();
        const id = win.getActiveSpace().spaceId;
        assert.equal(win.getActiveSpace().name, 'Dev');
        assert.ok(id.indexOf('custom-') === 0);
    });
});

function doc_set(win, doc, id, value) {
    doc.getElementById(id).value = value;
}

describe('Single execution', () => {
    function streamFetch(frames, extra = {}) {
        return async (url) => {
            if (url.includes('/api/chat/stream')) return makeResponse({ status: 200, sse: frames });
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        };
    }
    it('E1 second execution blocked with running space name', async () => {
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
        doc.getElementById('user-input').value = 'first';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        assert.ok(win.getActiveExecution());
        assert.equal(win.getActiveExecution().spaceId, 'general');
        doc.getElementById('user-input').value = 'second';
        await win.sendMessage();
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el._text);
        assert.ok(texts.some((t) => t.includes('General') && t.includes('正在執行')));
        release();
        await p1;
        assert.equal(win.getActiveExecution(), null);
    });
    it('E2 switch does not cancel execution', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const { win } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                await gate;
                return makeResponse({ status: 200, sse: [sseFrame('text.delta', { content: 'hi' }), sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        doc_get(win, 'user-input').value = 'work';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        const before = win.getActiveExecution();
        assert.ok(before);
        assert.equal(win.switchSpace('coding'), true);
        assert.equal(win.getActiveExecution(), before);
        assert.equal(win.getActiveExecution().spaceId, 'general');
        release();
        await p1;
        assert.equal(win.getActiveExecution(), null);
    });
    function doc_get(win, id) {
        return win.document.getElementById(id);
    }
    it('E3 stop targets the running execution after switch', async () => {
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
        doc.getElementById('user-input').value = 'work';
        const p1 = win.sendMessage();
        await new Promise((r) => setTimeout(r, 5));
        win.switchSpace('gmail');
        assert.equal(win.getActiveSpace().spaceId, 'gmail');
        win.stopExecution();
        await p1;
        assert.equal(win.getActiveExecution(), null);
        win.switchSpace('general');
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el.textContent);
        assert.ok(texts.some((t) => t.includes('已終止')));
    });
    it('E4 completion releases the lock', async () => {
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                return makeResponse({ status: 200, sse: [sseFrame('text.delta', { content: 'done' }), sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        doc.getElementById('user-input').value = 'one';
        await win.sendMessage();
        assert.equal(win.getActiveExecution(), null);
        doc.getElementById('user-input').value = 'two';
        await win.sendMessage();
        assert.equal(win.getActiveExecution(), null);
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el.textContent);
        assert.ok(texts.filter((t) => t.includes('two')).length >= 1);
    });
    it('E5 user message stays plain text', async () => {
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/chat/stream')) {
                return makeResponse({ status: 200, sse: [sseFrame('message.completed', { sessionId: 'x' })] });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        doc.getElementById('user-input').value = '**not bold**';
        await win.sendMessage();
        const wrappers = doc.all.filter((el) => el.className && el.className.includes('justify-end'));
        assert.ok(wrappers.length >= 1);
        assert.ok(wrappers[0].textContent.includes('**not bold**'));
        assert.equal(walk(wrappers[0], 'strong').length, 0);
    });
});

describe('SSE routing', () => {
    function routedFetch() {
        return async (url) => {
            if (url.includes('/api/change-proposals/pp1')) {
                return makeResponse({ status: 200, json: { proposalId: 'pp1', status: 'pending', sessionId: 'SESS', changes: [] } });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        };
    }
    it('R1 text.delta goes to execution space only', async () => {
        const { win, doc } = boot(routedFetch());
        const codingSession = win.getSpaceSession('coding');
        doc.getElementById('user-input').value = 'go coding';
        win.switchSpace('coding');
        const p1 = streamsend(win, doc, [
            sseFrame('text.delta', { content: 'coding says hi', sessionId: codingSession }),
            sseFrame('message.completed', { sessionId: codingSession })
        ], routedFetch());
        void p1;
        win.switchSpace('general');
        const generalTexts = doc.getElementById('messages').textContent;
        assert.ok(!generalTexts.includes('coding says hi'));
        await p1;
        win.switchSpace('coding');
        assert.ok(doc.getElementById('messages').textContent.includes('coding says hi'));
    });
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
    it('R2 tool events route by session', async () => {
        const { win, doc } = boot(routedFetch());
        const codingSession = win.getSpaceSession('coding');
        doc.getElementById('user-input').value = 'go';
        await streamsend(win, doc, [
            sseFrame('tool.started', { tool: 'code_context', callId: 'c1', sessionId: codingSession }),
            sseFrame('message.completed', { sessionId: codingSession })
        ], routedFetch());
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el.textContent);
        assert.ok(texts.some((t) => t.includes('code_context')));
    });
    it('R3 proposal routes to owning space, hidden elsewhere', async () => {
        const { win, doc } = boot(routedFetch());
        const codingSession = win.getSpaceSession('coding');
        doc.getElementById('user-input').value = 'go';
        await streamsend(win, doc, [
            sseFrame('approval_required', { proposalId: 'pp1', sessionId: codingSession }),
            sseFrame('message.completed', { sessionId: codingSession })
        ], routedFetch());
        assert.ok(win.proposalCards.has('pp1'));
        assert.equal(win.proposalCards.get('pp1').spaceId, 'coding');
        // The execution ran in general, so its own user/fallback messages
        // stay visible there; only the card must be hidden.
        const visible = doc.getElementById('messages').children.filter((c) => !c.removed);
        assert.ok(!visible.some((c) => c.dataset && c.dataset.proposalId === 'pp1'));
        assert.ok(visible.some((c) => c.className && c.className.includes('justify-end')));
        win.switchSpace('coding');
        const restored = doc.getElementById('messages').children.filter((c) => !c.removed);
        assert.ok(restored.length > 0);
        assert.ok(restored.some((c) => c.dataset && c.dataset.proposalId === 'pp1'));
    });
    it('R4 completed renders markdown in the right space', async () => {
        const { win, doc } = boot(routedFetch());
        doc.getElementById('user-input').value = 'go';
        await streamsend(win, doc, [
            sseFrame('text.delta', { content: '# Title here' }),
            sseFrame('message.completed', { sessionId: 'x' })
        ], routedFetch());
        const h1 = walk(doc.getElementById('messages'), 'h1');
        assert.equal(h1.length, 1);
        assert.equal(h1[0].textContent, 'Title here');
    });
    it('R5 error routes without crashing', async () => {
        const { win, doc } = boot(routedFetch());
        doc.getElementById('user-input').value = 'go';
        await streamsend(win, doc, [sseFrame('error', { message: 'boom happened' })], routedFetch());
        assert.ok(doc.getElementById('messages').textContent.includes('boom happened'));
    });
    it('R6 checkpoint events become activity', async () => {
        const { win, doc } = boot(routedFetch());
        doc.getElementById('user-input').value = 'go';
        await streamsend(win, doc, [
            sseFrame('checkpoint_created', { checkpointId: 'checkpoint_abc', sessionId: 'SESS' }),
            sseFrame('checkpoint_completed', { checkpointId: 'checkpoint_abc', sessionId: 'SESS' }),
            sseFrame('message.completed', { sessionId: 'SESS' })
        ], routedFetch());
        const texts = doc.all.filter((el) => el.tag === 'div').map((el) => el.textContent);
        assert.ok(texts.some((t) => t.includes('checkpoint')));
    });
});

describe('P3 regression under Spaces', () => {
    it('P1 approval flow works inside a space', async () => {
        const { win, doc } = boot(async (url) => {
            if (url.includes('/api/change-proposals/prop_abc123/apply')) {
                return makeResponse({ status: 200, json: { proposalId: 'prop_abc123', status: 'applied' } });
            }
            if (url.includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        });
        win.switchSpace('coding');
        win.renderProposalCard({ proposalId: 'prop_abc123', status: 'pending', changes: [] });
        assert.equal(win.proposalCards.get('prop_abc123').spaceId, 'coding');
        assert.equal(await win.decideProposal('prop_abc123', 'apply'), true);
        assert.equal(win.proposalCards.get('prop_abc123').state, 'applied');
        win.switchSpace('general');
        win.switchSpace('coding');
        assert.equal(win.proposalCards.get('prop_abc123').state, 'applied');
    });
    it('P2 correction title survives space switch', () => {
        const { win, doc } = boot(okFetch);
        win.renderProposalCard({ proposalId: 'pc1', status: 'pending', changes: [], correctionAttempt: 3 });
        assert.ok(doc.getElementById('messages').textContent.includes('修正 #3'));
        win.switchSpace('gmail');
        win.switchSpace('general');
        assert.ok(doc.getElementById('messages').textContent.includes('修正 #3'));
    });
    it('P3 checkpoint events never crash without cards', async () => {
        const { win, doc } = boot(okFetch);
        doc.getElementById('user-input').value = 'go';
        const enc = new TextEncoder();
        const frames = [
            sseFrame('checkpoint_waiting_approval', { checkpointId: 'c1' }),
            sseFrame('message.completed', { sessionId: 'x' })
        ];
        const origFetch = win.fetch;
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
            if (String(url).includes('/api/history')) return makeResponse({ status: 200, json: [] });
            return makeResponse({ status: 200, json: {} });
        };
        await win.sendMessage();
        win.fetch = origFetch;
        assert.equal(win.getActiveExecution(), null);
    });
    it('P4 stop never applies a proposal', async () => {
        const { win } = boot(async () => {
            throw new Error('fetch must not run on stop');
        });
        win.renderProposalCard({ proposalId: 'prop_abc123', status: 'pending', changes: [] });
        win.stopExecution();
        assert.equal(win.proposalCards.get('prop_abc123').state, 'pending');
    });
});
