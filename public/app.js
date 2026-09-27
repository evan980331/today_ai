function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebar-overlay');
    if (!sb || !ov) return;
    const isHidden = sb.classList.contains('hidden');
    const isTranslated = sb.classList.contains('-translate-x-full');
    const isClosed = isHidden || isTranslated;
    if (isClosed) {
        sb.classList.remove('hidden');
        sb.classList.add('flex');
        void sb.offsetWidth;
        sb.classList.remove('-translate-x-full');
        ov.classList.remove('hidden');
    } else {
        sb.classList.add('-translate-x-full');
        ov.classList.add('hidden');
        setTimeout(() => {
            const stillClosed = sb.classList.contains('-translate-x-full');
            if (stillClosed) {
                sb.classList.add('hidden');
                sb.classList.remove('flex');
            }
        }, 220);
    }
    try { if (window.lucide) lucide.createIcons(); } catch {}
}
window.toggleSidebar = toggleSidebar;
async function sendMessage() {
    const space = getActiveSpace() || getSpace('general');
    const spaceId = space ? space.spaceId : 'general';
    // Global single-flight: at most one agent execution system-wide.
    if (activeExecution) {
        const runConv = getConversation(activeExecution.conversationId);
        const runLabel = runConv
            ? `${getSpaceName(runConv.spaceId)}／${runConv.title}`
            : `${getSpaceName(activeExecution.spaceId)} 正在執行`;
        appendSystemMessage(activeConversationId, `目前 ${runLabel} 正在執行，請等待完成或停止目前任務。`);
        updateWelcomeVisibility();
        return;
    }
    if (isRunning) return; // transitional guard, kept in sync with activeExecution
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 8000) {
        appendMessage('ai', '訊息過長 (max 8000)', activeConversationId);
        return;
    }

    const conv = ensureConversation(spaceId);
    if (!conv) return;
    setActiveConversationId(conv.conversationId);
    convStore.active[spaceId] = conv.conversationId;
    saveConversationStore();
    autoTitleFromMessage(conv.conversationId, text);
    refreshSpaces();

    welcomeSection.classList.add('hidden');
    appendMessage('user', text, conv.conversationId);
    input.value = '';

    // The controller belongs to the execution, not to the visible
    // conversation: switching never cancels it.
    const controller = new AbortController();
    const execution = {
        executionId: 'ex-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36),
        spaceId,
        conversationId: conv.conversationId,
        sessionId: conv.sessionId,
        controller,
        status: 'running'
    };
    activeExecution = execution;
    currentStreamController = controller;
    setRunning(true);
    refreshSpaces();

    const loadingId = appendLoading(conv.conversationId);
    try {
        const streamed = await sendMessageStream(text, loadingId, controller, execution);
        if (streamed) return;
        // Fallback: legacy non-streaming endpoint (kept for compatibility).
        await sendMessageLegacy(text, loadingId, controller.signal, execution);
    } finally {
        removeLoading(loadingId);
        if (activeExecution && activeExecution.executionId === execution.executionId) activeExecution = null;
        if (currentStreamController === controller) currentStreamController = null;
        setRunning(false);
        refreshSpaces();
        try { input.disabled = false; } catch {}
        // Do not steal focus if user is typing, but ensure input is usable
        try { if (document.activeElement !== input) input.focus(); } catch {}
    }
}

// User-pressed Stop: aborts the active execution wherever it runs, not
// merely whatever space is on screen. Proposals stay untouched.
function stopExecution() {
    const ex = activeExecution;
    if (!ex) {
        const c = currentStreamController;
        if (!c || !isRunning) return;
        setStopping(true);
        try { c.abort(); } catch {}
        return;
    }
    ex.status = 'stopping';
    setStopping(true);
    refreshSpaces();
    try { ex.controller.abort(); } catch {}
}
window.stopExecution = stopExecution;

function setRunning(on) {
    isRunning = on;
    try {
        const sendBtn = document.getElementById('send-button');
        const stopBtn = document.getElementById('stop-button');
        if (sendBtn) {
            sendBtn.disabled = on;
            sendBtn.style.display = on ? 'none' : '';
            sendBtn.classList.toggle('flex', !on);
        }
        if (stopBtn) {
            stopBtn.style.display = on ? 'flex' : 'none';
            stopBtn.disabled = false;
            stopBtn.innerHTML = '<i data-lucide="square" class="w-4 h-4">■</i>';
            if (window.lucide) lucide.createIcons();
        }
        if (input) input.disabled = on;
    } catch {}
}

function setStopping() {
    try {
        const stopBtn = document.getElementById('stop-button');
        if (stopBtn) {
            stopBtn.disabled = true;
            stopBtn.innerHTML = '<span class="text-xs font-medium px-1">停止中…</span>';
        }
    } catch {}
}

// Streaming path: POST /api/chat/stream (SSE). Events belong to a
// conversation (resolved via execution/conversationId/session, never
// activeConversationId); DOM updates land in #messages only when that
// conversation is on screen, otherwise they accumulate on detached nodes
// shown on switch-back.
async function sendMessageStream(text, loadingId, controller, execution) {
    if (!controller) return false;
    const execConvId = (execution && execution.conversationId) || activeConversationId;
    let bubble = null;
    let fullText = '';
    let handled = false;
    // Set once any tool/command activity arrives. The first text chunk after
    // activity starts the final answer: separate it from earlier status
    // narration with one blank line (consumed after a single use, so later
    // chunks and multi-line Markdown pass through untouched).
    let sawToolActivity = false;
    // P1-1 activity state: dedupe by callId/partId
    let activityBox = null;
    let activityList = null;
    const activityMap = new Map();
    function ensureActivityBox() {
        if (activityBox) return;
        const wrap = document.createElement('div');
        wrap.className = 'flex justify-start';
        activityBox = document.createElement('div');
        activityBox.className = 'bg-slate-900/60 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-slate-400 max-w-xl w-full leading-relaxed shadow-sm space-y-1 overflow-hidden';
        activityBox.innerHTML = '<div class="flex items-center gap-2 text-[11px] tracking-wider text-slate-500 uppercase"><span class="w-2 h-2 rounded-full bg-amber-400/60 animate-pulse shrink-0"></span>背景活動</div>';
        activityList = document.createElement('div');
        activityList.className = 'space-y-1 pt-1';
        activityBox.appendChild(activityList);
        wrap.appendChild(activityBox);
        convAppend(execConvId, wrap);
        activityBox._wrap = wrap;
    }
    function upsertActivity(obj) {
        const key = obj.callId || obj.partId || obj.tool || JSON.stringify(obj).slice(0,80);
        if (activityMap.has(key)) {
            const el = activityMap.get(key);
            el.textContent = formatActivity(obj);
            return;
        }
        ensureActivityBox();
        const el = document.createElement('div');
        el.className = 'flex items-start gap-2 text-xs text-slate-400 break-words';
        el.style.overflowWrap = 'anywhere';
        el.dataset.key = key;
        el.textContent = formatActivity(obj);
        activityList.appendChild(el);
        activityMap.set(key, el);
        scrollToBottom();
    }
    function formatActivity(o) {
        const t = (o.tool || o.type || 'tool').toLowerCase();
        const id = o.callId ? ` · ${o.callId.slice(0,8)}` : '';
        if (o.type === 'tool.completed') return `✓ ${t}${id}`;
        if (typeof o.type === 'string' && o.type.indexOf('checkpoint_') === 0) {
            const label = o.type.slice('checkpoint_'.length);
            const cp = o.checkpointId ? ` · ${String(o.checkpointId).slice(0, 13)}` : '';
            return `◈ checkpoint ${label}${cp}`;
        }
        return `▸ ${t}${id}`;
    }
    function finalizeActivity(aborted) {
        if (!activityBox) return;
        const header = activityBox.querySelector('div');
        if (aborted) {
            if (header) header.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-500 shrink-0 inline-block"></span> 已終止';
        } else if (header) header.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400/60 shrink-0 inline-block"></span> 已完成 · ' + activityMap.size + ' 項活動';
        // keep as history, slightly dim
        activityBox.classList.add('opacity-80');
    }
    try {
        const res = await fetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: controller.signal,
            body: JSON.stringify({ prompt: text, sessionId: (execution && execution.sessionId) || null })
        });
        if (res.status === 401) {
            removeLoading(loadingId);
            loginOverlay.classList.remove('hidden');
            appendMessage('ai', '未授權 (401)：請先登入', execConvId);
            return true;
        }
        const ctype = res.headers.get('content-type') || '';
        if (!res.ok || !ctype.includes('text/event-stream') || !res.body) {
            return false; // let legacy path handle it
        }
        handled = true;
        removeLoading(loadingId);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const flushEvents = () => {
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
                let ev = 'message';
                let data = '';
                for (const line of part.split('\n')) {
                    if (line.startsWith('event:')) ev = line.slice(6).trim();
                    else if (line.startsWith('data:')) data += line.slice(5).trim();
                }
                if (!data) continue;
                let obj;
                try { obj = JSON.parse(data); } catch { continue; }
                // Route every event to its owning conversation: explicit
                // conversationId/sessionId first, then existing proposal
                // cards, then this execution. Never activeConversationId.
                // Background conversations accumulate state; only the
                // active conversation touches #messages.
                const targetConv = resolveEventConversation(obj, execution);
                const isLive = targetConv === activeConversationId;
                if (ev === 'text.delta' && obj.content) {
                    let chunk = obj.content;
                    if (!bubble) {
                        bubble = appendStreamingMessage(targetConv);
                        sawToolActivity = false; // nothing narrated yet: no separator needed
                    } else if (sawToolActivity && /\S/.test(bubble.textContent) && /\S/.test(chunk) &&
                        !bubble.textContent.endsWith('\n\n') && !/^\s/.test(chunk)) {
                        chunk = '\n\n' + chunk;
                        sawToolActivity = false;
                    }
                    fullText += chunk;
                    bubble.textContent = fullText;
                    if (isLive) scrollToBottom();
                } else if (ev === 'tool.started' || ev === 'tool.completed' || ev === 'command.started' || ev === 'command.completed') {
                    sawToolActivity = true;
                    upsertActivity(obj);
                } else if (ev === 'proposal_created' || ev === 'approval_required') {
                    // P3-7: agent asks a human to review a change proposal.
                    // The agent run is NOT complete while cards are pending.
                    sawToolActivity = true;
                    if (obj.proposalId) {
                        if (obj.changes && obj.changes.length) renderProposalCard(obj, targetConv);
                        else fetchProposalAndRender(obj.proposalId, targetConv);
                    }
                } else if (ev === 'changes_applied' || ev === 'proposal_approved' || ev === 'proposal_rejected' || ev === 'proposal_stale') {
                    sawToolActivity = true;
                    updateProposalCard(obj);
                } else if (typeof ev === 'string' && ev.indexOf('checkpoint_') === 0) {
                    sawToolActivity = true;
                    appendCheckpointActivity(targetConv, ev, obj);
                } else if (ev === 'message.completed' || ev === 'done') {
                    finalizeActivity();
                    if (!bubble && fullText) bubble = appendStreamingMessage(targetConv);
                    // Streaming showed plain text; the final render is Markdown.
                    if (bubble && fullText) renderMarkdownInto(bubble, fullText);
                    else if (bubble) bubble.textContent = fullText || bubble.textContent;
                    let pendingCards = 0;
                    try {
                        proposalCards.forEach((entry) => { if (entry.state === 'pending' && entry.conversationId === targetConv) pendingCards += 1; });
                    } catch {}
                    if (pendingCards > 0) {
                        const note = `有 ${pendingCards} 項修改等待批准，請在上方卡片中批准或拒絕。`;
                        let duplicate = false;
                        try {
                            const scan = (nodes) => {
                                for (const node of nodes) {
                                    if (node && node.textContent === note) { duplicate = true; break; }
                                }
                            };
                            scan(messagesDiv.childNodes || []);
                            // Background conversations stash their nodes;
                            // scan the target stash too so a repeated
                            // completed/done pair cannot double-append.
                            if (targetConv !== activeConversationId) {
                                try { scan((convView(targetConv) || {}).nodes || []); } catch {}
                            }
                        } catch {}
                        if (!duplicate) appendMessage('ai', note, targetConv);
                    }
                    refreshSpaces();
                } else if (ev === 'error') {
                    const aborted = obj.code === 'ABORTED' || obj.message === 'aborted';
                    finalizeActivity(aborted);
                    if (!bubble) bubble = appendStreamingMessage(targetConv);
                    bubble.textContent = aborted ? '已終止。' : `錯誤：${obj.message || '未知錯誤'}`;
                }
            }
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            flushEvents();
        }
        buf += decoder.decode();
        flushEvents();
        if (!bubble && !fullText) {
            appendMessage('ai', '執行完成，但沒有收到回應內容。', execConvId);
        }
        return true;
    } catch (err) {
        if (err && err.name === 'AbortError') {
            removeLoading(loadingId);
            finalizeActivity(true);
            appendMessage('ai', '已終止。', execConvId);
            return true;
        }
        if (!handled) return false; // network-level failure: try legacy path
        removeLoading(loadingId);
        if (!bubble) appendMessage('ai', '連線失敗，請確認後端 Bridge Server 是否已啟動。', execConvId);
        return true;
    } finally {
        if (currentStreamController === controller) currentStreamController = null;
    }
}

async function sendMessageLegacy(text, loadingId, signal, execution) {
    const convId = (execution && execution.conversationId) || activeConversationId;
    const sessionId = (execution && execution.sessionId) || null;
    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: signal || undefined,
            body: JSON.stringify({ prompt: text, sessionId })
        });
        const data = await res.json().catch(() => ({}));
        removeLoading(loadingId);
        if (!res.ok) {
            if (res.status === 401) {
                loginOverlay.classList.remove('hidden');
                appendMessage('ai', '未授權 (401)：請先登入', convId);
                return;
            }
            let msg = `錯誤 ${res.status}: ${escapeHtml(data.error || '未知錯誤')}`;
            if (res.status === 429) msg = '請求過於頻繁 (429)：請稍後再試';
            else if (res.status === 504) msg = 'OpenCode 超時 (504)：請稍後重試';
            else if (res.status === 503) msg = 'OpenCode runtime 暫時不可用 (503)：請稍後重試';
            else if (res.status === 500) msg = `執行失敗 (500)：${escapeHtml((data.details || data.error || '').slice(0,300))}`;
            else if (data.details) msg += `\n${escapeHtml(data.details.slice(0,300))}`;
            appendMessage('ai', msg, convId);
            return;
        }
        if (data.result) {
            appendMessage('ai', data.result, convId);
            refreshSpaces();
        } else {
            appendMessage('ai', '執行失敗：' + escapeHtml(data.error || '無回應'), convId);
        }
    } catch (err) {
        removeLoading(loadingId);
        if (err && err.name === 'AbortError') {
            appendMessage('ai', '已終止。', convId);
            return;
        }
        appendMessage('ai', '連線失敗，請確認後端 Bridge Server 是否已啟動。', convId);
    }
}
window.sendMessage = sendMessage;
window.usePrompt = function(t) { if (isRunning) return; const el=document.getElementById('user-input'); if(el){el.value=t; window.sendMessage();} };
try { if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons(); } catch {}

try { if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons(); } catch {}
try {
const _cd = document.getElementById('current-date');
if (_cd) _cd.innerText = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
});
} catch {}

// Space identity/session regexes live here (before first use at load
// time) so top-level initialization never hits TDZ in any host.
const SPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SPACE_SESSION_RE = /^[a-zA-Z0-9._\-]{1,128}$/;
const SPACE_UUID_RE = /^[0-9a-fA-F-]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

let spaceSessions = loadSpaceSessions();
let activeSpaceId = loadActiveSpaceId();

// --- Auth (Cookie Session, HttpOnly) ---
const loginOverlay = document.getElementById('login-overlay');
const loginUserEl = document.getElementById('login-username');
const loginPassEl = document.getElementById('login-password');
const loginErrorEl = document.getElementById('login-error');

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (res.ok) {
            loginOverlay.classList.add('hidden');
            return true;
        }
    } catch {}
    loginOverlay.classList.remove('hidden');
    return false;
}

async function doLogin() {
    const username = (loginUserEl.value || '').trim();
    const password = loginPassEl.value || '';
    loginErrorEl.classList.add('hidden');
    if (!username || !password) {
        loginErrorEl.textContent = '請輸入帳號與密碼';
        loginErrorEl.classList.remove('hidden');
        return;
    }
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            loginErrorEl.textContent = res.status === 429 ? '登入過於頻繁，請稍後再試' : '帳號或密碼錯誤';
            loginErrorEl.classList.remove('hidden');
            return;
        }
        loginPassEl.value = '';
        loginOverlay.classList.add('hidden');
        // Verify session
        const me = await fetch('/api/auth/me', { credentials: 'include' });
        if (me.ok) {
            refreshSpaces();
            loadHistoryForSpace(activeSpaceId);
        }
    } catch (e) {
        loginErrorEl.textContent = '連線失敗';
        loginErrorEl.classList.remove('hidden');
    }
}
window.doLogin = doLogin;

async function doLogout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {}
    // Reset per-conversation UI state (spaces/sessions/conversations
    // persist for next login).
    try {
        activeExecution = null;
        currentStreamController = null;
        for (const k of Object.keys(convViews)) delete convViews[k];
        proposalCards.clear();
        clearContainer(messagesDiv);
    } catch {}
    messagesDiv.innerHTML = '';
    welcomeSection.classList.remove('hidden');
    loginOverlay.classList.remove('hidden');
    loginUserEl.value = '';
    loginPassEl.value = '';
    refreshSpaces();
}
window.doLogout = doLogout;

// Allow Enter on login inputs
if (loginUserEl && loginPassEl) {
    [loginUserEl, loginPassEl].forEach(el => el.addEventListener('keydown', e => {
        if (e.key === 'Enter') doLogin();
    }));
}

const input = document.getElementById('user-input');
const messagesDiv = document.getElementById('messages');
const welcomeSection = document.getElementById('welcome-section');

try {
if (input) input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isRunning) window.sendMessage();
    }
});
} catch {}

function usePrompt(text) {
    input.value = text;
    sendMessage();
}
window.usePrompt = usePrompt;

function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebar-overlay');
    if (!sb || !ov) return;
    const isHidden = sb.classList.contains('hidden');
    const isTranslated = sb.classList.contains('-translate-x-full');
    const isClosed = isHidden || isTranslated;
    if (isClosed) {
        sb.classList.remove('hidden');
        sb.classList.add('flex');
        void sb.offsetWidth;
        sb.classList.remove('-translate-x-full');
        ov.classList.remove('hidden');
    } else {
        sb.classList.add('-translate-x-full');
        ov.classList.add('hidden');
        setTimeout(() => {
            const stillClosed = sb.classList.contains('-translate-x-full');
            if (stillClosed) {
                sb.classList.add('hidden');
                sb.classList.remove('flex');
            }
        }, 220);
    }
    try { if (window.lucide) lucide.createIcons(); } catch {}
}
window.toggleSidebar = toggleSidebar;

let currentStreamController = null;
let isRunning = false;



// Streaming AI bubble: same styling as appendMessage('ai'), but returns the
// bubble element so chunks can update it incrementally (textContent during
// streaming; Markdown only on message.completed). Nodes route to the
// owning conversation; only the active one touches #messages.
function appendStreamingMessage(convId) {
    const target = convId || activeConversationId;
    const wrapper = document.createElement('div');
    wrapper.className = 'flex justify-start min-w-0';
    const bubble = document.createElement('div');
    bubble.className = 'bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-tl-none px-4 py-3 text-sm max-w-[min(36rem,85vw)] md:max-w-xl leading-relaxed shadow-md whitespace-pre-wrap break-words overflow-wrap-anywhere min-w-0';
    bubble.style.overflowWrap = 'anywhere';
    bubble.textContent = '';
    wrapper.appendChild(bubble);
    convAppend(target, wrapper);
    if (target === activeConversationId) scrollToBottom();
    return bubble;
}

function appendMessage(role, content, convId) {
    const target = convId || activeConversationId;
    const wrapper = document.createElement('div');
    if (role === 'user') {
        wrapper.className = 'justify-end flex min-w-0';
        const div = document.createElement('div');
        div.className = 'bg-indigo-600 text-white rounded-2xl rounded-tr-none px-4 py-3 text-sm max-w-[min(28rem,85vw)] md:max-w-lg shadow-md whitespace-pre-wrap break-words min-w-0';
        div.style.overflowWrap = 'anywhere';
        div.textContent = content;
        wrapper.appendChild(div);
    } else if (role === 'system') {
        wrapper.className = 'flex justify-center min-w-0';
        const div = document.createElement('div');
        div.className = 'text-xs text-slate-500 px-3 py-1.5 max-w-[min(36rem,85vw)] text-center break-words';
        div.style.overflowWrap = 'anywhere';
        div.textContent = content;
        wrapper.appendChild(div);
    } else {
        wrapper.className = 'justify-start flex min-w-0';
        const bubble = document.createElement('div');
        bubble.className = 'bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-tl-none px-4 py-3 text-sm max-w-[min(36rem,85vw)] md:max-w-xl leading-relaxed shadow-md whitespace-pre-wrap break-words min-w-0';
        bubble.style.overflowWrap = 'anywhere';
        // AI content renders as Markdown; user/system stay plain text.
        renderMarkdownInto(bubble, content);
        wrapper.appendChild(bubble);
    }
    convAppend(target, wrapper);
    if (target === activeConversationId) scrollToBottom();
}

function appendLoading(convId) {
    const id = 'loading-' + Date.now();
    const wrapper = document.createElement('div');
    wrapper.id = id;
    wrapper.className = 'flex justify-start';
    wrapper.innerHTML = `
        <div class="bg-slate-900 border border-slate-800 text-slate-400 rounded-2xl rounded-tl-none px-4 py-3 text-sm flex items-center space-x-2">
            <span class="animate-pulse">OpenCode 正在處理並調用 MCP 工具...</span>
        </div>
    `;
    loadingNodes[id] = wrapper;
    convAppend(convId || activeConversationId, wrapper);
    if ((convId || activeConversationId) === activeConversationId) scrollToBottom();
    return id;
}

const loadingNodes = {};

function removeLoading(id) {
    const tracked = loadingNodes[id];
    if (tracked) {
        try { tracked.remove(); } catch {}
        try { delete loadingNodes[id]; } catch {}
        return;
    }
    try {
        const el = document.getElementById(id);
        if (el) el.remove();
    } catch {}
}

async function loadHistory() {
    return loadHistoryForSpace(activeSpaceId);
}

function switchSession(id) {
    // Legacy single-session API kept as a shim: route to the conversation
    // that owns the session, or fall back to the active conversation.
    try {
        if (typeof id === 'string' && id) {
            const conv = conversationBySession(id);
            if (conv && conv.conversationId !== activeConversationId) { switchConversation(conv.conversationId); return; }
            const sp = spaceBySession(id);
            if (sp && sp !== activeSpaceId) { switchSpace(sp); return; }
        }
    } catch {}
    const active = getActiveConversation();
    if (active) loadHistoryForConversation(active.conversationId);
    refreshSpaces();
}
window.switchSession = switchSession;

function createNewSession() {
    // Legacy "new chat" maps to a fresh conversation in the active space.
    newConversation(activeSpaceId);
}
window.createNewSession = createNewSession;

async function deleteSession() {
    // Server-side session deletion is out of scope for Spaces; clearing
    // the active view is the safe local equivalent. Kept for compat.
    createNewSession();
}
window.deleteSession = deleteSession;
window.clearChat = createNewSession;

async function loadSessions() {
    // Sidebar no longer lists server sessions (Spaces own the identity);
    // keep the name as a harmless refresh hook.
    refreshSpaces();
}

checkAuth().then(ok => {
    refreshSpaces();
    updateActiveSpaceHeader();
    if (ok) {
        switchSpace(activeSpaceId);
    }
});

function scrollToBottom() {
    const container = document.getElementById('chat-container');
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- Safe Markdown renderer (no dependencies) ---
// Builds DOM exclusively with createElement + textContent: model/user
// text is NEVER assigned to innerHTML and never parsed as HTML, so raw
// <script>/<img onerror>/<div onclick> payloads render as inert text.
// Returns an Array of nodes (stub-DOM compatible, no DocumentFragment).
function mdText(str) {
    if (typeof document.createTextNode === 'function') {
        try { return document.createTextNode(str); } catch {}
    }
    const s = document.createElement('span');
    s.textContent = str;
    return s;
}

function mdEl(tag, cls, parent) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
}

// Only these schemes may become clickable links. Everything else
// (javascript:, data:, vbscript:, file:, ...) renders as plain text.
function isSafeMarkdownUrl(url) {
    if (typeof url !== 'string') return false;
    const u = url.trim();
    return /^(https?:\/\/|mailto:)/i.test(u);
}

// Inline: `code`, **bold**, *italic*, [text](url). Single pass over a
// token regex; unmatched text stays verbatim. Link text recurses one
// level for nested bold/italic/code.
function renderInlineInto(parent, str) {
    const src = String(str == null ? '' : str);
    const parts = src.split('\n');
    for (let li = 0; li < parts.length; li++) {
        if (li > 0) parent.appendChild(document.createElement('br'));
        renderInlineTokens(parent, parts[li]);
    }
}

function renderInlineTokens(parent, str) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
        if (m.index > last) parent.appendChild(mdText(str.slice(last, m.index)));
        const tok = m[0];
        if (tok.charAt(0) === '`') {
            const code = mdEl('code', 'bg-slate-950 border border-slate-800 rounded px-1 font-mono text-[12px]', parent);
            code.textContent = tok.slice(1, -1);
        } else if (tok.charAt(0) === '*' && tok.charAt(1) === '*') {
            const b = mdEl('strong', '', parent);
            renderInlinePlain(b, tok.slice(2, -2));
        } else if (tok.charAt(0) === '*') {
            const em = mdEl('em', '', parent);
            renderInlinePlain(em, tok.slice(1, -1));
        } else {
            appendMarkdownLink(parent, tok);
        }
        last = m.index + tok.length;
    }
    if (last < str.length) parent.appendChild(mdText(str.slice(last)));
}

// Plain pass for nested content: bold/italic/code only, no links.
function renderInlinePlain(parent, str) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
        if (m.index > last) parent.appendChild(mdText(str.slice(last, m.index)));
        const tok = m[0];
        if (tok.charAt(0) === '`') {
            const code = mdEl('code', 'bg-slate-950 border border-slate-800 rounded px-1 font-mono text-[12px]', parent);
            code.textContent = tok.slice(1, -1);
        } else if (tok.charAt(0) === '*' && tok.charAt(1) === '*') {
            const b = mdEl('strong', '', parent);
            b.textContent = tok.slice(2, -2);
        } else {
            const em = mdEl('em', '', parent);
            em.textContent = tok.slice(1, -1);
        }
        last = m.index + tok.length;
    }
    if (last < str.length) parent.appendChild(mdText(str.slice(last)));
}

function appendMarkdownLink(parent, tok) {
    const m = tok.match(/^\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (!m || !isSafeMarkdownUrl(m[2])) {
        parent.appendChild(mdText(tok));
        return;
    }
    const a = document.createElement('a');
    a.className = 'text-indigo-300 underline break-words';
    try {
        a.href = m[2].trim();
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    } catch {}
    renderInlinePlain(a, m[1]);
    parent.appendChild(a);
}

function mdHeadingCls(level) {
    if (level === 1) return 'text-lg font-bold text-slate-100 mt-1 mb-1';
    if (level === 2) return 'text-base font-bold text-slate-100 mt-1 mb-1';
    return 'text-sm font-bold text-slate-100 mt-1 mb-1';
}

function buildCodeBlock(code, lang) {
    const wrap = document.createElement('div');
    wrap.className = 'my-2 min-w-0';
    const bar = document.createElement('div');
    bar.className = 'flex items-center justify-between bg-slate-950 border border-slate-800 border-b-0 rounded-t-lg px-2 py-1';
    const langEl = document.createElement('span');
    langEl.className = 'text-[11px] text-slate-500 font-mono';
    langEl.textContent = (lang || '').trim() || 'code';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'text-[11px] text-slate-300 bg-slate-800 hover:bg-slate-700 rounded px-3 min-h-[44px]';
    copyBtn.textContent = '複製';
    copyBtn.addEventListener('click', () => {
        try {
            const clip = (typeof navigator !== 'undefined' && navigator.clipboard) ? navigator.clipboard : null;
            if (clip && typeof clip.writeText === 'function') {
                const done = clip.writeText(code);
                if (done && typeof done.catch === 'function') done.catch(() => {});
            }
        } catch {}
    });
    bar.appendChild(langEl);
    bar.appendChild(copyBtn);
    wrap.appendChild(bar);
    const pre = document.createElement('pre');
    pre.className = 'bg-slate-950 border border-slate-800 rounded-b-lg p-2 overflow-x-auto max-w-full font-mono text-[12px] leading-relaxed';
    pre.style.whiteSpace = 'pre';
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    wrap.appendChild(pre);
    return wrap;
}

function isMdBlockStart(line, nextLine) {
    if (/^```\w*\s*$/.test(line)) return true;
    if (/^#{1,3}\s+/.test(line)) return true;
    if (/^>\s?/.test(line)) return true;
    if (/^([-*+])\s+/.test(line)) return true;
    if (/^\d+[.)]\s+/.test(line)) return true;
    if (line.includes('|') && typeof nextLine === 'string' && /-/.test(nextLine) && /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(nextLine)) return true;
    return false;
}

function buildMdTable(headerLine, bodyLines) {
    const splitRow = (l) => {
        let t = l.trim();
        if (t.charAt(0) === '|') t = t.slice(1);
        if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
        return t.split('|').map((c) => c.trim());
    };
    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto max-w-full my-2';
    const table = document.createElement('table');
    table.className = 'text-xs border-collapse min-w-full';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const cell of splitRow(headerLine)) {
        const th = document.createElement('th');
        th.className = 'border border-slate-700 bg-slate-800 px-2 py-1 text-left font-semibold whitespace-nowrap';
        th.textContent = cell;
        hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const bl of bodyLines) {
        const tr = document.createElement('tr');
        for (const cell of splitRow(bl)) {
            const td = document.createElement('td');
            td.className = 'border border-slate-800 px-2 py-1 whitespace-nowrap';
            td.textContent = cell;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
}

// Block parser: headings, ul/ol, blockquote, table, fenced code,
// paragraphs. Returns an Array of nodes.
function renderMarkdown(text) {
    const nodes = [];
    const lines = String(text == null ? '' : text).split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*$/.test(line)) { i++; continue; }
        let m;
        if ((m = line.match(/^```(\w*)\s*$/))) {
            const buf = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++;
            nodes.push(buildCodeBlock(buf.join('\n'), m[1]));
            continue;
        }
        if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
            const h = document.createElement('h' + m[1].length);
            h.className = mdHeadingCls(m[1].length);
            renderInlineInto(h, m[2]);
            nodes.push(h);
            i++;
            continue;
        }
        if (/^>\s?/.test(line)) {
            const buf = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
            const q = document.createElement('blockquote');
            q.className = 'border-l-2 border-slate-600 pl-2 text-slate-300 my-1';
            renderInlineInto(q, buf.join('\n'));
            nodes.push(q);
            continue;
        }
        if (/^([-*+])\s+/.test(line)) {
            const ul = document.createElement('ul');
            ul.className = 'list-disc pl-5 my-1 space-y-0.5';
            while (i < lines.length) {
                const lm = lines[i].match(/^([-*+])\s+(.*)$/);
                if (!lm) break;
                const li = document.createElement('li');
                renderInlineInto(li, lm[2]);
                ul.appendChild(li);
                i++;
            }
            nodes.push(ul);
            continue;
        }
        if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) {
            const ol = document.createElement('ol');
            ol.className = 'list-decimal pl-5 my-1 space-y-0.5';
            while (i < lines.length) {
                const lm = lines[i].match(/^\d+[.)]\s+(.*)$/);
                if (!lm) break;
                const li = document.createElement('li');
                renderInlineInto(li, lm[1]);
                ol.appendChild(li);
                i++;
            }
            nodes.push(ol);
            continue;
        }
        if (line.includes('|') && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(lines[i + 1])) {
            const body = [];
            i += 2;
            while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
            nodes.push(buildMdTable(line, body));
            continue;
        }
        const buf = [line];
        i++;
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !isMdBlockStart(lines[i], lines[i + 1])) { buf.push(lines[i]); i++; }
        const p = document.createElement('p');
        p.className = 'my-1';
        renderInlineInto(p, buf.join('\n'));
        nodes.push(p);
    }
    return nodes;
}

// Replace container content with rendered Markdown. Works with stub DOM
// (no replaceChildren/removeChild required) and never uses innerHTML.
function renderMarkdownInto(container, text) {
    const nodes = renderMarkdown(text);
    try { container.textContent = ''; } catch {}
    try {
        if (typeof container.replaceChildren === 'function') { container.replaceChildren(...nodes); return; }
    } catch {}
    try {
        while (container.firstChild) {
            try { container.removeChild(container.firstChild); } catch { break; }
        }
    } catch {}
    for (const nd of nodes) {
        try { container.appendChild(nd); } catch {}
    }
}
window.renderMarkdown = renderMarkdown;
window.renderMarkdownInto = renderMarkdownInto;

function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --- P3-7 Proposal Approval UI ---
// Agent -> approval_required -> Proposal Card -> human Approve/Reject ->
// API -> card status update. Cards live in #messages next to chat bubbles
// but never inside them; the chat/activity/Stop flows are untouched.
// All untrusted strings (path/diff/message/proposalId) go through
// textContent only — innerHTML is never assigned proposal data.
const proposalCards = new Map(); // proposalId -> { root, statusEl, approveBtn, rejectBtn, state }

function proposalOpLabel(op) {
    if (op === 'create') return '建立';
    if (op === 'delete') return '刪除';
    return '更新';
}

function proposalOpBadgeClass(op) {
    if (op === 'create') return 'text-emerald-300 border-emerald-700 bg-emerald-950';
    if (op === 'delete') return 'text-red-300 border-red-700 bg-red-950';
    return 'text-amber-300 border-amber-700 bg-amber-950';
}

function renderDiffLine(line) {
    const div = document.createElement('div');
    const first = line.charAt(0);
    if (first === '+' && line.charAt(1) !== '+') div.className = 'text-emerald-300';
    else if (first === '-' && line.charAt(1) !== '-') div.className = 'text-red-300';
    else if (first === '@') div.className = 'text-slate-500';
    else div.className = 'text-slate-400';
    div.textContent = line;
    return div;
}

function renderProposalCard(payload, convId) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const proposalId = typeof data.proposalId === 'string' ? data.proposalId : '';
    if (!proposalId) return null;
    if (proposalCards.has(proposalId)) return proposalCards.get(proposalId).root;
    // Conversation binding: explicit arg wins, then payload, then the
    // session mapping, then the visible conversation. Approval later uses
    // the card's own sessionId — never the then-active conversation.
    let targetConv = (typeof convId === 'string' && getConversation(convId)) ? convId : null;
    if (!targetConv && typeof data.conversationId === 'string' && getConversation(data.conversationId)) {
        targetConv = data.conversationId;
    }
    if (!targetConv && typeof data.sessionId === 'string') {
        const mapped = conversationBySession(data.sessionId);
        if (mapped) targetConv = mapped.conversationId;
        else {
            const bySpace = spaceBySession(data.sessionId);
            if (bySpace) {
                const ensured = ensureConversation(bySpace);
                if (ensured) targetConv = ensured.conversationId;
            }
        }
    }
    if (!targetConv) {
        const active = getActiveConversation() || ensureConversation(activeSpaceId);
        targetConv = active ? active.conversationId : activeConversationId;
        // Nothing is active yet (e.g. first render on a fresh view):
        // adopt the fallback conversation so the card is visible.
        if (targetConv && !activeConversationId && getConversation(targetConv)) {
            setActiveConversationId(targetConv);
            try {
                convStore.active[getConversation(targetConv).spaceId] = targetConv;
                saveConversationStore();
            } catch {}
        }
    }
    const targetSpace = getConversation(targetConv) ? getConversation(targetConv).spaceId : activeSpaceId;
    const cardSession = (typeof data.sessionId === 'string' && validSessionId(data.sessionId))
        ? data.sessionId
        : (getConversation(targetConv) ? getConversation(targetConv).sessionId : null);
    const changes = Array.isArray(data.changes) ? data.changes : [];

    const wrapper = document.createElement('div');
    wrapper.className = 'flex justify-start min-w-0';
    wrapper.dataset.proposalId = proposalId;
    const card = document.createElement('div');
    card.className = 'bg-slate-900 border border-indigo-500/40 text-slate-200 rounded-2xl px-4 py-3 text-sm max-w-[min(36rem,92vw)] md:max-w-xl leading-relaxed shadow-md w-full min-w-0';
    wrapper.appendChild(card);

    const title = document.createElement('div');
    title.className = 'font-semibold text-slate-100 mb-1';
    // P3-8: correction proposals reuse the same card; only the title
    // distinguishes the attempt number. correctionAttempt arrives via the
    // approval_required / proposal_created event, never from user input.
    const attempt = Number.isInteger(data.correctionAttempt) && data.correctionAttempt > 0 ? data.correctionAttempt : null;
    title.textContent = attempt === null
        ? `需要批准修改（${changes.length} 個檔案）`
        : `需要批准修改（修正 #${attempt}，${changes.length} 個檔案）`;
    card.appendChild(title);

    const idLine = document.createElement('div');
    idLine.className = 'text-[11px] text-slate-500 mb-2 break-all';
    idLine.textContent = proposalId;
    card.appendChild(idLine);

    for (const ch of changes) {
        const item = ch && typeof ch === 'object' ? ch : {};
        const fileBox = document.createElement('details');
        fileBox.className = 'mb-2 bg-slate-950 border border-slate-800 rounded-lg';
        fileBox.open = true;
        const summary = document.createElement('summary');
        summary.className = 'cursor-pointer px-2 py-1.5 text-xs flex items-center gap-2 min-h-[44px]';
        const pathEl = document.createElement('span');
        pathEl.className = 'font-mono break-all flex-1';
        pathEl.textContent = typeof item.path === 'string' ? item.path : '(unknown)';
        const badge = document.createElement('span');
        badge.className = `text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${proposalOpBadgeClass(item.operation)}`;
        badge.textContent = proposalOpLabel(item.operation);
        summary.appendChild(pathEl);
        summary.appendChild(badge);
        fileBox.appendChild(summary);
        const diffBox = document.createElement('div');
        diffBox.className = 'px-2 pb-2 overflow-auto max-h-64 font-mono text-[11px] leading-relaxed whitespace-pre';
        const diffText = typeof item.diff === 'string' ? item.diff : '';
        for (const line of diffText.split('\n')) {
            diffBox.appendChild(renderDiffLine(line));
        }
        fileBox.appendChild(diffBox);
        card.appendChild(fileBox);
    }

    const statusEl = document.createElement('div');
    statusEl.className = 'text-xs text-amber-300 mb-2';
    statusEl.textContent = '等待批准';
    card.appendChild(statusEl);

    const btnRow = document.createElement('div');
    btnRow.className = 'flex gap-2';
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium py-2 px-3 rounded-xl transition min-h-[44px] disabled:opacity-50';
    rejectBtn.textContent = '拒絕';
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2 px-3 rounded-xl transition min-h-[44px] disabled:opacity-50';
    approveBtn.textContent = '批准並套用';
    rejectBtn.addEventListener('click', () => decideProposal(proposalId, 'reject'));
    approveBtn.addEventListener('click', () => decideProposal(proposalId, 'apply'));
    btnRow.appendChild(rejectBtn);
    btnRow.appendChild(approveBtn);
    card.appendChild(btnRow);

    convAppend(targetConv, wrapper);
    if (targetConv === activeConversationId) scrollToBottom();
    proposalCards.set(proposalId, { root: wrapper, statusEl, approveBtn, rejectBtn, state: 'pending', spaceId: targetSpace, conversationId: targetConv, sessionId: cardSession, payload: data });
    return wrapper;
}

function setProposalState(proposalId, state, message) {
    const entry = proposalCards.get(proposalId);
    if (!entry) return false;
    entry.state = state;
    if (message !== undefined && message !== null) entry.statusEl.textContent = message;
    const done = state === 'applied' || state === 'rejected' || state === 'stale' || state === 'error';
    if (done) {
        entry.approveBtn.disabled = true;
        entry.rejectBtn.disabled = true;
    }
    if (state === 'applied') entry.statusEl.className = 'text-xs text-emerald-300 mb-2';
    else if (state === 'rejected') entry.statusEl.className = 'text-xs text-slate-400 mb-2';
    else if (state === 'stale' || state === 'error') entry.statusEl.className = 'text-xs text-red-300 mb-2';
    scrollToBottom();
    return true;
}

// Human decision: exactly one API call per proposal (busy guard +
// disabled buttons). Never modifies files locally, never auto-reruns.
async function decideProposal(proposalId, action) {
    const entry = proposalCards.get(proposalId);
    if (!entry || entry.state !== 'pending') return false;
    entry.state = 'busy';
    entry.approveBtn.disabled = true;
    entry.rejectBtn.disabled = true;
    const verb = action === 'apply' ? 'apply' : 'reject';
    entry.statusEl.textContent = action === 'apply' ? '套用中…' : '拒絕中…';
    try {
        const res = await fetch(`/api/change-proposals/${encodeURIComponent(proposalId)}/${verb}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ sessionId: entry.sessionId || null })
        });
        if (res.status === 401) {
            try { loginOverlay.classList.remove('hidden'); } catch {}
            entry.state = 'pending';
            entry.approveBtn.disabled = false;
            entry.rejectBtn.disabled = false;
            entry.statusEl.textContent = '未授權 (401)：請先登入後再試';
            return false;
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && (data.status === 'applied' || data.status === 'rejected')) {
            setProposalState(proposalId, data.status, data.status === 'applied' ? '已套用' : '已拒絕');
            return true;
        }
        const code = (data && (data.code || data.causeCode)) || '';
        if (code === 'PROPOSAL_STALE' || code === 'PROPOSAL_EXPIRED' || code === 'PROPOSAL_NOT_PENDING') {
            setProposalState(proposalId, 'stale', '檔案已變更，無法套用。請重新執行 Agent 產生新的修改提案。');
            return false;
        }
        const msg = (data && data.error) || `請求失敗 (${res.status})`;
        setProposalState(proposalId, 'error', `錯誤：${msg}`);
        return false;
    } catch (err) {
        entry.state = 'pending';
        entry.approveBtn.disabled = false;
        entry.rejectBtn.disabled = false;
        entry.statusEl.textContent = '連線失敗，請稍後再試';
        return false;
    }
}

async function fetchProposalAndRender(proposalId, convId) {
    if (!proposalId || proposalCards.has(proposalId)) return proposalCards.get(proposalId) || null;
    let targetConv = (typeof convId === 'string' && getConversation(convId)) ? convId : null;
    if (!targetConv) {
        const active = getActiveConversation();
        targetConv = active ? active.conversationId : activeConversationId;
    }
    try {
        const conv = getConversation(targetConv);
        const sess = conv ? conv.sessionId : null;
        const qs = sess ? `?sessionId=${encodeURIComponent(sess)}` : '';
        const res = await fetch(`/api/change-proposals/${encodeURIComponent(proposalId)}${qs}`, { credentials: 'include' });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        if (!data || data.proposalId !== proposalId) return null;
        renderProposalCard(data, targetConv);
        if (data.status && data.status !== 'pending') {
            setProposalState(proposalId, data.status, data.status === 'applied' ? '已套用' : data.status === 'rejected' ? '已拒絕' : `狀態：${data.status}`);
        }
        return proposalCards.get(proposalId) || null;
    } catch {
        return null;
    }
}

function updateProposalCard(obj) {
    const o = obj && typeof obj === 'object' ? obj : {};
    if (!o.proposalId || !proposalCards.has(o.proposalId)) return false;
    if (o.type === 'changes_applied' || o.type === 'proposal_approved') {
        setProposalState(o.proposalId, 'applied', '已套用');
    } else if (o.type === 'proposal_rejected') {
        setProposalState(o.proposalId, 'rejected', '已拒絕');
    } else if (o.type === 'proposal_stale') {
        setProposalState(o.proposalId, 'stale', '檔案已變更，無法套用。請重新執行 Agent 產生新的修改提案。');
    }
    return true;
}
window.renderProposalCard = renderProposalCard;
window.decideProposal = decideProposal;
window.updateProposalCard = updateProposalCard;
window.fetchProposalAndRender = fetchProposalAndRender;
window.setProposalState = setProposalState;
window.proposalCards = proposalCards;

// --- Multi-Agent Spaces ---
// One global agent execution at most; each Space owns an independent
// conversation (session), message view, and proposal state. Backend is
// untouched: routing is done frontend-side via sessionId mapping.
const DEFAULT_SPACES = [
    { spaceId: 'general', name: 'General', icon: '🏠', description: '日常對話與綜合任務', builtin: true },
    { spaceId: 'coding', name: 'Coding', icon: '💻', description: '程式開發與除錯', builtin: true },
    { spaceId: 'gmail', name: 'Gmail', icon: '📧', description: '郵件處理', builtin: true },
    { spaceId: 'calendar', name: 'Calendar', icon: '📅', description: '行事曆', builtin: true },
    { spaceId: 'morning', name: '早報', icon: '📰', description: '晨間摘要', builtin: true },
    { spaceId: 'evening', name: '晚報', icon: '🌙', description: '晚間摘要', builtin: true }
];
function validSessionId(v) {
    return typeof v === 'string' && (SPACE_UUID_RE.test(v) || SPACE_SESSION_RE.test(v));
}

function loadCustomSpaces() {
    try {
        const raw = localStorage.getItem('todayai_spaces');
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter((s) => s && typeof s === 'object'
            && typeof s.spaceId === 'string' && SPACE_ID_RE.test(s.spaceId)
            && typeof s.name === 'string' && s.name.trim().length >= 1 && s.name.trim().length <= 40
            && (s.icon === undefined || (typeof s.icon === 'string' && s.icon.length <= 8))
            && (s.description === undefined || (typeof s.description === 'string' && s.description.length <= 120)));
    } catch { return []; }
}

function saveCustomSpaces(list) {
    try { localStorage.setItem('todayai_spaces', JSON.stringify(list)); } catch {}
}

function allSpaces() {
    return DEFAULT_SPACES.concat(loadCustomSpaces());
}

function getSpace(spaceId) {
    if (typeof spaceId !== 'string') return null;
    return allSpaces().find((s) => s.spaceId === spaceId) || null;
}

function getSpaceName(spaceId) {
    const s = getSpace(spaceId);
    return s ? s.name : String(spaceId == null ? '' : spaceId);
}

// Per-space sessions, persisted. Legacy single `todayai_session` migrates
// once into General so existing conversations survive the upgrade.
function loadSpaceSessions() {
    let map = {};
    try {
        const raw = localStorage.getItem('todayai_space_sessions');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
        }
    } catch {}
    const clean = {};
    for (const k of Object.keys(map)) {
        if (SPACE_ID_RE.test(k) && validSessionId(map[k])) clean[k] = map[k];
    }
    try {
        const legacy = localStorage.getItem('todayai_session');
        if (legacy && validSessionId(legacy) && !clean.general) {
            clean.general = legacy;
            try { localStorage.removeItem('todayai_session'); } catch {}
            // Persist immediately: the conversation migration below runs
            // after us and must still see this session.
            try { localStorage.setItem('todayai_space_sessions', JSON.stringify(clean)); } catch {}
        }
    } catch {}
    return clean;
}

function saveSpaceSessions() {
    try { localStorage.setItem('todayai_space_sessions', JSON.stringify(spaceSessions)); } catch {}
}

function getSpaceSession(spaceId) {
    if (spaceSessions[spaceId] && validSessionId(spaceSessions[spaceId])) return spaceSessions[spaceId];
    let id = null;
    try { id = crypto.randomUUID(); } catch {}
    if (!validSessionId(id)) id = 'space-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    spaceSessions[spaceId] = id;
    saveSpaceSessions();
    return id;
}

function spaceBySession(sessionId) {
    if (!validSessionId(sessionId)) return null;
    for (const s of allSpaces()) {
        if (spaceSessions[s.spaceId] === sessionId) return s.spaceId;
    }
    return null;
}

// SSE identity: explicit conversationId first, then sessionId mapping
// (conversation, then legacy space), then an existing proposal card,
// then the running execution. Never activeConversationId on its own.
function resolveEventConversation(obj, execution) {
    try {
        if (obj && typeof obj.conversationId === 'string' && getConversation(obj.conversationId)) {
            return obj.conversationId;
        }
        if (obj && typeof obj.sessionId === 'string') {
            const conv = conversationBySession(obj.sessionId);
            if (conv) return conv.conversationId;
            const bySpace = spaceBySession(obj.sessionId);
            if (bySpace) {
                const c = ensureConversation(bySpace);
                if (c) return c.conversationId;
            }
        }
        if (obj && obj.proposalId && proposalCards.has(obj.proposalId)) {
            const cid = proposalCards.get(obj.proposalId).conversationId;
            if (cid) return cid;
        }
    } catch {}
    if (execution && execution.conversationId) return execution.conversationId;
    const active = getActiveConversation();
    if (active) return active.conversationId;
    return activeConversationId;
}

// Checkpoint status lines always land in the owning conversation's view
// (live or stashed), independent of which stream is running.
function appendCheckpointActivity(convId, ev, obj) {
    const o = (obj && typeof obj === 'object') ? obj : {};
    const label = String(ev).slice('checkpoint_'.length);
    const cp = o.checkpointId ? ` · ${String(o.checkpointId).slice(0, 13)}` : '';
    const div = document.createElement('div');
    div.className = 'flex items-start gap-2 text-xs text-slate-400 break-words';
    try { div.style.overflowWrap = 'anywhere'; } catch {}
    div.textContent = `◈ checkpoint ${label}${cp}`;
    convAppend(convId, div);
    if (convId === activeConversationId) {
        try { scrollToBottom(); } catch {}
    }
    return div;
}

function loadActiveSpaceId() {
    try {
        const v = localStorage.getItem('todayai_active_space');
        if (v && getSpace(v)) return v;
    } catch {}
    return 'general';
}

function setActiveSpaceId(id) {
    activeSpaceId = id;
    try { localStorage.setItem('todayai_active_space', id); } catch {}
}

function getActiveSpace() {
    return getSpace(activeSpaceId) || getSpace('general');
}

// --- Space → Conversations ---
// A Space owns an ordered list of Conversations; each Conversation owns
// exactly one chat session. Message/activity/proposal views are keyed by
// conversation, never by space. Agent runtime stays global (one flight).
const CONVERSATION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CONVERSATION_TITLE_MAX = 40;
const CONVERSATION_AUTO_TITLE_MAX = 30;
const DEFAULT_CONVERSATION_TITLE = '新對話';

function newConversationId() {
    let id = null;
    try { id = crypto.randomUUID(); } catch {}
    if (typeof id === 'string' && id) return 'conversation-' + id.slice(0, 8);
    return 'conversation-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

function newSessionId() {
    let id = null;
    try { id = crypto.randomUUID(); } catch {}
    if (validSessionId(id)) return id;
    return 'space-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

function validConversation(c) {
    return c && typeof c === 'object' && !Array.isArray(c)
        && typeof c.conversationId === 'string' && CONVERSATION_ID_RE.test(c.conversationId)
        && typeof c.spaceId === 'string' && getSpace(c.spaceId)
        && typeof c.sessionId === 'string' && validSessionId(c.sessionId)
        && typeof c.title === 'string' && c.title.length >= 1 && c.title.length <= CONVERSATION_TITLE_MAX;
}

function emptyConversationStore() {
    return { version: 1, conversations: {}, order: {}, active: {} };
}

function loadConversationStore() {
    let parsed = null;
    try {
        const raw = localStorage.getItem('todayai_conversations');
        if (raw) parsed = JSON.parse(raw);
    } catch {}
    if (parsed && typeof parsed === 'object' && parsed.conversations && typeof parsed.conversations === 'object') {
        const store = emptyConversationStore();
        for (const id of Object.keys(parsed.conversations)) {
            const c = parsed.conversations[id];
            if (validConversation(c) && c.conversationId === id) store.conversations[id] = { ...c };
        }
        const order = (parsed.order && typeof parsed.order === 'object') ? parsed.order : {};
        for (const sid of Object.keys(order)) {
            if (getSpace(sid) && Array.isArray(order[sid])) {
                store.order[sid] = order[sid].filter((id) => store.conversations[id] && store.conversations[id].spaceId === sid);
            }
        }
        const active = (parsed.active && typeof parsed.active === 'object') ? parsed.active : {};
        for (const sid of Object.keys(active)) {
            if (getSpace(sid) && store.conversations[active[sid]] && store.conversations[active[sid]].spaceId === sid) {
                store.active[sid] = active[sid];
            }
        }
        return store;
    }
    // One-time legacy migration (key absence = not migrated yet):
    // todayai_space_sessions { spaceId: sessionId } and the older
    // todayai_session singular become one conversation per space, keeping
    // the original sessionIds so existing histories survive.
    const store = emptyConversationStore();
    let legacyMap = {};
    try {
        const raw = localStorage.getItem('todayai_space_sessions');
        if (raw) {
            const p = JSON.parse(raw);
            if (p && typeof p === 'object' && !Array.isArray(p)) legacyMap = p;
        }
    } catch {}
    for (const sid of Object.keys(legacyMap)) {
        const space = getSpace(sid);
        if (!space || !validSessionId(legacyMap[sid])) continue;
        if ((store.order[sid] || []).length > 0) continue;
        const cid = 'conversation-legacy-' + sid;
        const title = sid === 'general' ? '一般對話' : space.name.slice(0, CONVERSATION_TITLE_MAX);
        store.conversations[cid] = { conversationId: cid, spaceId: sid, sessionId: legacyMap[sid], title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        store.order[sid] = [cid];
        store.active[sid] = cid;
    }
    try {
        const singular = localStorage.getItem('todayai_session');
        if (singular && validSessionId(singular) && (store.order.general || []).length === 0) {
            const cid = 'conversation-legacy-general';
            store.conversations[cid] = { conversationId: cid, spaceId: 'general', sessionId: singular, title: '一般對話', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            store.order.general = [cid];
            store.active.general = cid;
        }
    } catch {}
    saveConversationStore(store);
    return store;
}

function saveConversationStore(store) {
    try { localStorage.setItem('todayai_conversations', JSON.stringify(store || convStore)); } catch {}
}

let convStore = loadConversationStore();
let activeConversationId = null;
try {
    const v = localStorage.getItem('todayai_active_conversation');
    if (v && convStore.conversations[v]) activeConversationId = v;
} catch {}

function setActiveConversationId(id) {
    activeConversationId = id;
    try {
        if (id) localStorage.setItem('todayai_active_conversation', id);
        else localStorage.removeItem('todayai_active_conversation');
    } catch {}
}

function listConversations(spaceId) {
    const ids = (convStore.order[spaceId] || []).filter((id) => convStore.conversations[id]);
    return ids.map((id) => convStore.conversations[id]);
}

function getConversation(convId) {
    if (typeof convId !== 'string') return null;
    return convStore.conversations[convId] || null;
}

function createConversation(spaceId, title) {
    const space = getSpace(spaceId);
    if (!space) return null;
    const name = (typeof title === 'string' && title.trim()) ? title.trim().slice(0, CONVERSATION_TITLE_MAX) : DEFAULT_CONVERSATION_TITLE;
    let cid = newConversationId();
    if (!CONVERSATION_ID_RE.test(cid) || convStore.conversations[cid]) {
        cid = 'conversation-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    }
    const now = new Date().toISOString();
    const conv = { conversationId: cid, spaceId, sessionId: newSessionId(), title: name, createdAt: now, updatedAt: now };
    convStore.conversations[cid] = conv;
    if (!Array.isArray(convStore.order[spaceId])) convStore.order[spaceId] = [];
    convStore.order[spaceId].push(cid);
    convStore.active[spaceId] = cid;
    saveConversationStore();
    return conv;
}

function touchConversation(convId) {
    const c = getConversation(convId);
    if (!c) return;
    c.updatedAt = new Date().toISOString();
    saveConversationStore();
}

function setConversationTitle(convId, title) {
    const c = getConversation(convId);
    if (!c || typeof title !== 'string') return false;
    const t = title.replace(/\s+/g, ' ').trim().slice(0, CONVERSATION_TITLE_MAX);
    if (!t) return false;
    c.title = t;
    c.updatedAt = new Date().toISOString();
    saveConversationStore();
    return true;
}

function autoTitleFromMessage(convId, text) {
    const c = getConversation(convId);
    if (!c || c.title !== DEFAULT_CONVERSATION_TITLE) return;
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, CONVERSATION_AUTO_TITLE_MAX);
    if (t) setConversationTitle(convId, t);
}

function getActiveConversation() {
    if (activeConversationId && convStore.conversations[activeConversationId]) {
        return convStore.conversations[activeConversationId];
    }
    return null;
}

// Every space always resolves to a conversation: last-active, first, or
// a freshly created empty one ("新對話").
function ensureConversation(spaceId) {
    const space = getSpace(spaceId);
    if (!space) return null;
    const last = convStore.active[spaceId];
    if (last && convStore.conversations[last] && convStore.conversations[last].spaceId === spaceId) {
        return convStore.conversations[last];
    }
    const list = listConversations(spaceId);
    if (list.length > 0) {
        convStore.active[spaceId] = list[0].conversationId;
        saveConversationStore();
        return list[0];
    }
    return createConversation(spaceId, DEFAULT_CONVERSATION_TITLE);
}

function conversationBySession(sessionId) {
    if (!validSessionId(sessionId)) return null;
    for (const id of Object.keys(convStore.conversations)) {
        if (convStore.conversations[id].sessionId === sessionId) return convStore.conversations[id];
    }
    return null;
}

// Per-conversation detached DOM stash (replaces space-level stash:
// a Space is a navigation container, the Conversation owns the view).
const convViews = {}; // conversationId -> { nodes: [], historyLoaded: false }
function convView(convId) {
    if (!convViews[convId]) convViews[convId] = { nodes: [], historyLoaded: false };
    return convViews[convId];
}

function convAppend(convId, node) {
    if (!node) return null;
    if (convId === activeConversationId) {
        try { messagesDiv.appendChild(node); } catch { return null; }
    } else {
        convView(convId).nodes.push(node);
    }
    try { scrollToBottom(); } catch {}
    return node;
}

function clearContainer(el) {
    if (!el) return;
    try {
        if (typeof el.replaceChildren === 'function') { el.replaceChildren(); return; }
    } catch {}
    try {
        while (el.firstChild) {
            try { el.removeChild(el.firstChild); } catch { break; }
        }
    } catch {}
}

// Global single-flight execution. activeSpaceId/activeConversationId only
// describe "what the user looks at"; activeExecution is "what is running".
// They are independent.
let activeExecution = null; // { executionId, spaceId, conversationId, sessionId, controller, status }

function refreshSpaces() {
    renderSpaceList();
    updateActiveSpaceHeader();
}

function renderSpaceList() {
    let listEl = null;
    try { listEl = document.getElementById('space-list'); } catch {}
    if (!listEl) return;
    clearContainer(listEl);
    for (const s of allSpaces()) {
        const isActiveSpace = s.spaceId === activeSpaceId;
        const expanded = isActiveSpace && !collapsedSpaces.has(s.spaceId);
        const row = document.createElement('div');
        row.className = `flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition min-h-[44px] ${isActiveSpace ? 'bg-slate-800 text-indigo-300 border border-slate-700' : 'hover:bg-slate-800/60 text-slate-400 hover:text-slate-200'}`;
        row.dataset.spaceId = s.spaceId;
        const icon = document.createElement('span');
        icon.className = 'text-base leading-none shrink-0';
        icon.textContent = (typeof s.icon === 'string' && s.icon) ? s.icon : '🤖';
        const nameWrap = document.createElement('div');
        nameWrap.className = 'flex-1 min-w-0 text-left';
        const nameEl = document.createElement('div');
        nameEl.className = 'text-xs font-medium truncate';
        nameEl.textContent = s.name;
        nameWrap.appendChild(nameEl);
        if (s.description) {
            const desc = document.createElement('div');
            desc.className = 'text-[10px] opacity-60 truncate';
            desc.textContent = s.description;
            nameWrap.appendChild(desc);
        }
        row.appendChild(icon);
        row.appendChild(nameWrap);
        const caret = document.createElement('span');
        caret.className = 'text-[10px] text-slate-500 shrink-0';
        caret.textContent = expanded ? '˅' : '˃';
        row.appendChild(caret);
        row.addEventListener('click', () => onSpaceRowClick(s.spaceId));
        try { listEl.appendChild(row); } catch {}
        if (!expanded) continue;
        const convs = listConversations(s.spaceId);
        for (const c of convs) {
            const isActiveConv = c.conversationId === activeConversationId;
            const isRunning = !!activeExecution && activeExecution.conversationId === c.conversationId;
            const crow = document.createElement('div');
            crow.className = `flex items-center gap-2 pl-8 pr-2.5 py-1.5 rounded-lg cursor-pointer transition min-h-[36px] ${isActiveConv ? 'bg-slate-800/80 text-indigo-200 border border-slate-700/60' : 'hover:bg-slate-800/40 text-slate-400 hover:text-slate-200'}`;
            crow.dataset.conversationId = c.conversationId;
            crow.dataset.spaceId = s.spaceId;
            const title = document.createElement('div');
            title.className = 'text-xs truncate flex-1 min-w-0 text-left';
            title.textContent = c.title;
            crow.appendChild(title);
            if (isRunning) {
                const dot = document.createElement('span');
                dot.className = 'text-[10px] text-emerald-300 shrink-0';
                dot.textContent = '● Running';
                crow.appendChild(dot);
            }
            crow.addEventListener('click', () => switchConversation(c.conversationId));
            try { listEl.appendChild(crow); } catch {}
        }
        const addRow = document.createElement('div');
        addRow.className = 'flex items-center gap-2 pl-8 pr-2.5 py-1.5 rounded-lg cursor-pointer transition min-h-[44px] text-slate-500 hover:text-slate-300 hover:bg-slate-800/40';
        const addLabel = document.createElement('div');
        addLabel.className = 'text-xs';
        addLabel.textContent = '＋ 新對話';
        addRow.appendChild(addLabel);
        addRow.addEventListener('click', () => newConversation(s.spaceId));
        try { listEl.appendChild(addRow); } catch {}
    }
    try { if (window.lucide) lucide.createIcons(); } catch {}
}

// Collapsed state never changes the active space/conversation: it only
// hides the list. Persisted per boot (in-memory).
const collapsedSpaces = new Set();

function onSpaceRowClick(spaceId) {
    if (spaceId !== activeSpaceId) {
        switchSpace(spaceId);
        return;
    }
    if (collapsedSpaces.has(spaceId)) collapsedSpaces.delete(spaceId);
    else collapsedSpaces.add(spaceId);
    renderSpaceList();
}

function updateActiveSpaceHeader() {
    const space = getActiveSpace();
    try {
        const iconEl = document.getElementById('active-space-icon');
        if (iconEl) iconEl.textContent = (space && space.icon) || '🏠';
        const nameEl = document.getElementById('active-space-name');
        if (nameEl) nameEl.textContent = (space && space.name) || 'General';
    } catch {}
}

function closeDrawer() {
    try {
        const sb = document.getElementById('sidebar');
        const ov = document.getElementById('sidebar-overlay');
        if (!sb || !ov) return;
        sb.classList.add('-translate-x-full');
        ov.classList.add('hidden');
    } catch {}
}

function switchSpace(spaceId) {
    const space = getSpace(spaceId);
    if (!space) return false;
    if (spaceId !== activeSpaceId) {
        setActiveSpaceId(spaceId);
        collapsedSpaces.delete(spaceId);
    }
    const conv = ensureConversation(spaceId);
    if (!conv) return false;
    return renderConversation(conv.conversationId, true);
}

function switchConversation(convId) {
    const conv = getConversation(convId);
    if (!conv) return false;
    if (conv.spaceId !== activeSpaceId) {
        setActiveSpaceId(conv.spaceId);
        collapsedSpaces.delete(conv.spaceId);
    }
    return renderConversation(convId, true);
}

// Render one conversation: stash the outgoing view, restore the target
// view, load server history on first visit. Never creates execution.
function renderConversation(convId, closeAfter) {
    const conv = getConversation(convId);
    if (!conv) return false;
    const prev = activeConversationId;
    if (prev && prev !== convId) {
        try {
            const current = [];
            try {
                const kids = messagesDiv.childNodes;
                for (let i = 0; i < kids.length; i++) current.push(kids[i]);
            } catch {}
            convView(prev).nodes = current;
        } catch {}
    }
    clearContainer(messagesDiv);
    setActiveConversationId(convId);
    convStore.active[conv.spaceId] = convId;
    saveConversationStore();
    const view = convView(convId);
    for (const nd of view.nodes) {
        try { messagesDiv.appendChild(nd); } catch {}
    }
    view.nodes = [];
    updateActiveSpaceHeader();
    renderSpaceList();
    if (view.nodes.length === 0 && !view.historyLoaded) {
        loadHistoryForConversation(convId);
    } else {
        updateWelcomeVisibility();
    }
    if (closeAfter !== false) {
        try { closeDrawer(); } catch {}
    }
    try { scrollToBottom(); } catch {}
    return true;
}

function newConversation(spaceId) {
    const target = getSpace(spaceId) ? spaceId : activeSpaceId;
    const conv = createConversation(target, DEFAULT_CONVERSATION_TITLE);
    if (!conv) return null;
    if (target !== activeSpaceId) {
        setActiveSpaceId(target);
        collapsedSpaces.delete(target);
    }
    renderConversation(conv.conversationId, false);
    try { closeDrawer(); } catch {}
    try { if (input) input.focus(); } catch {}
    return conv;
}

function updateWelcomeVisibility() {
    try {
        const hasNodes = messagesDiv.childNodes && messagesDiv.childNodes.length > 0;
        if (hasNodes) welcomeSection.classList.add('hidden');
        else welcomeSection.classList.remove('hidden');
    } catch {}
}

async function loadHistoryForConversation(convId) {
    const conv = getConversation(convId);
    if (!conv) return;
    const view = convView(convId);
    try {
        const res = await fetch(`/api/history?sessionId=${encodeURIComponent(conv.sessionId)}&limit=100`, { credentials: 'include' });
        if (res.status === 401) { try { loginOverlay.classList.remove('hidden'); } catch {} return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        view.historyLoaded = true;
        if (Array.isArray(rows) && rows.length > 0) {
            for (const r of rows) appendMessage(r.role === 'user' ? 'user' : 'ai', r.content, convId);
            if (convId === activeConversationId) updateWelcomeVisibility();
        } else if (convId === activeConversationId) {
            updateWelcomeVisibility();
        }
    } catch (e) {
        try { console.warn('history load failed', e); } catch {}
        // Error state, shown once and only while this conversation is
        // still the visible empty view (stale fetches after a switch
        // stay silent; the next visit retries).
        try {
            if (convId !== activeConversationId) return;
            const kids = messagesDiv.childNodes || [];
            for (const k of kids) {
                if (k && !k.removed) return;
            }
            appendMessage('system', '歷史載入失敗，請切換後再試。', convId);
        } catch {}
    }
}

async function loadHistoryForSpace(spaceId) {
    const conv = ensureConversation(spaceId);
    if (conv) return loadHistoryForConversation(conv.conversationId);
}

function toggleNewAgentForm() {
    try {
        const f = document.getElementById('new-agent-form');
        if (f) f.classList.toggle('hidden');
    } catch {}
}

function createAgentSpace() {
    let name = '';
    let icon = '';
    let desc = '';
    try {
        name = (document.getElementById('new-agent-name').value || '').trim();
        icon = (document.getElementById('new-agent-icon').value || '').trim();
        desc = (document.getElementById('new-agent-desc').value || '').trim();
    } catch {}
    if (!name || name.length > 40) {
        try {
            const active = getActiveConversation();
            appendSystemMessage(active ? active.conversationId : activeConversationId, '名稱不可為空（最多 40 字）。');
        } catch {}
        return false;
    }
    if (icon && icon.length > 8) icon = icon.slice(0, 8);
    if (desc.length > 120) desc = desc.slice(0, 120);
    let spaceId = 'custom-' + Date.now().toString(36);
    if (!SPACE_ID_RE.test(spaceId) || getSpace(spaceId)) {
        spaceId = 'custom-' + Math.floor(Math.random() * 1e9).toString(36);
    }
    const list = loadCustomSpaces();
    list.push({ spaceId, name, icon: icon || '🤖', description: desc, createdAt: new Date().toISOString() });
    saveCustomSpaces(list);
    getSpaceSession(spaceId);
    try {
        document.getElementById('new-agent-name').value = '';
        document.getElementById('new-agent-icon').value = '';
        document.getElementById('new-agent-desc').value = '';
        document.getElementById('new-agent-form').classList.add('hidden');
    } catch {}
    switchSpace(spaceId);
    return true;
}

function appendSystemMessage(convId, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex justify-center min-w-0';
    const div = document.createElement('div');
    div.className = 'text-xs text-slate-500 px-3 py-1.5 max-w-[min(36rem,85vw)] text-center break-words';
    div.style.overflowWrap = 'anywhere';
    div.textContent = text;
    wrapper.appendChild(div);
    convAppend(convId, wrapper);
    if ((convId || activeConversationId) === activeConversationId) {
        try { scrollToBottom(); } catch {}
    }
    return wrapper;
}

window.switchSpace = switchSpace;
window.switchConversation = switchConversation;
window.newConversation = newConversation;
window.createConversation = createConversation;
window.getConversation = getConversation;
window.getActiveConversation = getActiveConversation;
window.getActiveConversationId = function () { return activeConversationId; };
window.listConversations = listConversations;
window.conversationBySession = conversationBySession;
window.createAgentSpace = createAgentSpace;
window.toggleNewAgentForm = toggleNewAgentForm;
window.getActiveSpace = getActiveSpace;
window.allSpaces = allSpaces;
window.getSpaceSession = getSpaceSession;
window.getActiveExecution = function () { return activeExecution; };
window.renderProposalCard = renderProposalCard;
window.decideProposal = decideProposal;
window.updateProposalCard = updateProposalCard;
window.fetchProposalAndRender = fetchProposalAndRender;
window.setProposalState = setProposalState;
window.proposalCards = proposalCards;
