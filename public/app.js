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
    if (isRunning) return; // running lock: one execution at a time
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 8000) {
        appendMessage('ai', '訊息過長 (max 8000)');
        return;
    }

    welcomeSection.classList.add('hidden');
    appendMessage('user', text);
    input.value = '';

    // Single controller per execution; Stop button aborts this one.
    const controller = new AbortController();
    currentStreamController = controller;
    setRunning(true);

    const loadingId = appendLoading();
    try {
        const streamed = await sendMessageStream(text, loadingId, controller);
        if (streamed) return;
        // Fallback: legacy non-streaming endpoint (kept for compatibility).
        await sendMessageLegacy(text, loadingId, controller.signal);
    } finally {
        removeLoading(loadingId);
        setRunning(false);
        if (currentStreamController === controller) currentStreamController = null;
        try { input.disabled = false; } catch {}
        // Do not steal focus if user is typing, but ensure input is usable
        try { if (document.activeElement !== input) input.focus(); } catch {}
    }
}

// User-pressed Stop: abort the in-flight request/stream only.
// Cleanup + state restore happen in sendMessage's finally.
function stopExecution() {
    const c = currentStreamController;
    if (!c || !isRunning) return;
    setStopping(true);
    try { c.abort(); } catch {}
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

// Streaming path: POST /api/chat/stream (SSE). Returns true when the
// stream endpoint handled the request (success or clean error).
async function sendMessageStream(text, loadingId, controller) {
    if (!controller) return false;
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
        messagesDiv.appendChild(wrap);
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
            body: JSON.stringify({ prompt: text, sessionId: currentSessionId })
        });
        if (res.status === 401) {
            removeLoading(loadingId);
            loginOverlay.classList.remove('hidden');
            appendMessage('ai', '未授權 (401)：請先登入');
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
                if (ev === 'text.delta' && obj.content) {
                    let chunk = obj.content;
                    if (!bubble) {
                        bubble = appendStreamingMessage();
                        sawToolActivity = false; // nothing narrated yet: no separator needed
                    } else if (sawToolActivity && /\S/.test(bubble.textContent) && /\S/.test(chunk) &&
                        !bubble.textContent.endsWith('\n\n') && !/^\s/.test(chunk)) {
                        chunk = '\n\n' + chunk;
                        sawToolActivity = false;
                    }
                    fullText += chunk;
                    bubble.textContent = fullText;
                    scrollToBottom();
                } else if (ev === 'tool.started' || ev === 'tool.completed' || ev === 'command.started' || ev === 'command.completed') {
                    sawToolActivity = true;
                    upsertActivity(obj);
                } else if (ev === 'proposal_created' || ev === 'approval_required') {
                    // P3-7: agent asks a human to review a change proposal.
                    // The agent run is NOT complete while cards are pending.
                    sawToolActivity = true;
                    if (obj.proposalId) {
                        if (obj.changes && obj.changes.length) renderProposalCard(obj);
                        else fetchProposalAndRender(obj.proposalId);
                    }
                } else if (ev === 'changes_applied' || ev === 'proposal_approved' || ev === 'proposal_rejected' || ev === 'proposal_stale') {
                    sawToolActivity = true;
                    updateProposalCard(obj);
                } else if (ev === 'message.completed' || ev === 'done') {
                    finalizeActivity();
                    if (!bubble && fullText) bubble = appendStreamingMessage();
                    if (bubble) bubble.textContent = fullText || bubble.textContent;
                    let pendingCards = 0;
                    try {
                        proposalCards.forEach((entry) => { if (entry.state === 'pending') pendingCards += 1; });
                    } catch {}
                    if (pendingCards > 0) {
                        const note = `有 ${pendingCards} 項修改等待批准，請在上方卡片中批准或拒絕。`;
                        let duplicate = false;
                        try {
                            messagesDiv.childNodes.forEach((node) => { if (node.textContent === note) duplicate = true; });
                        } catch {}
                        if (!duplicate) appendMessage('ai', note);
                    }
                    loadSessions();
                } else if (ev === 'error') {
                    const aborted = obj.code === 'ABORTED' || obj.message === 'aborted';
                    finalizeActivity(aborted);
                    if (!bubble) bubble = appendStreamingMessage();
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
            appendMessage('ai', '執行完成，但沒有收到回應內容。');
        }
        return true;
    } catch (err) {
        if (err && err.name === 'AbortError') {
            removeLoading(loadingId);
            finalizeActivity(true);
            appendMessage('ai', '已終止。');
            return true;
        }
        if (!handled) return false; // network-level failure: try legacy path
        removeLoading(loadingId);
        if (!bubble) appendMessage('ai', '連線失敗，請確認後端 Bridge Server 是否已啟動。');
        return true;
    } finally {
        if (currentStreamController === controller) currentStreamController = null;
    }
}

async function sendMessageLegacy(text, loadingId, signal) {
    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: signal || undefined,
            body: JSON.stringify({ prompt: text, sessionId: currentSessionId })
        });
        const data = await res.json().catch(() => ({}));
        removeLoading(loadingId);
        if (!res.ok) {
            if (res.status === 401) {
                loginOverlay.classList.remove('hidden');
                appendMessage('ai', '未授權 (401)：請先登入');
                return;
            }
            let msg = `錯誤 ${res.status}: ${escapeHtml(data.error || '未知錯誤')}`;
            if (res.status === 429) msg = '請求過於頻繁 (429)：請稍後再試';
            else if (res.status === 504) msg = 'OpenCode 超時 (504)：請稍後重試';
            else if (res.status === 503) msg = 'OpenCode runtime 暫時不可用 (503)：請稍後重試';
            else if (res.status === 500) msg = `執行失敗 (500)：${escapeHtml((data.details || data.error || '').slice(0,300))}`;
            else if (data.details) msg += `\n${escapeHtml(data.details.slice(0,300))}`;
            appendMessage('ai', msg);
            if (data.sessionId) {
                currentSessionId = data.sessionId;
                localStorage.setItem('todayai_session', currentSessionId);
            }
            return;
        }
        if (data.result) {
            appendMessage('ai', data.result);
            if (data.sessionId && data.sessionId !== currentSessionId) {
                currentSessionId = data.sessionId;
                localStorage.setItem('todayai_session', currentSessionId);
            }
            loadSessions();
        } else {
            appendMessage('ai', '執行失敗：' + escapeHtml(data.error || '無回應'));
        }
    } catch (err) {
        removeLoading(loadingId);
        if (err && err.name === 'AbortError') {
            appendMessage('ai', '已終止。');
            return;
        }
        appendMessage('ai', '連線失敗，請確認後端 Bridge Server 是否已啟動。');
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

let currentSessionId;
try {
currentSessionId = (() => {
    const v = localStorage.getItem('todayai_session');
    // Validate stored sessionId is UUID or safe
    if (v && /^[0-9a-fA-F-]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) return v;
    if (v && /^[a-zA-Z0-9._\-]{1,128}$/.test(v)) return v;
    const id = crypto.randomUUID();
    localStorage.setItem('todayai_session', id);
    return id;
})();
if (!localStorage.getItem('todayai_session')) localStorage.setItem('todayai_session', currentSessionId);
} catch(e) { console.warn('init error', e); }

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
            loadHistory();
            loadSessions();
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
    // Clear UI state but not password
    messagesDiv.innerHTML = '';
    welcomeSection.classList.remove('hidden');
    loginOverlay.classList.remove('hidden');
    loginUserEl.value = '';
    loginPassEl.value = '';
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
const sessionListEl = document.getElementById('session-list');

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
// text node so chunks can update it incrementally (textContent = XSS-safe).
function appendStreamingMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex justify-start min-w-0';
    const bubble = document.createElement('div');
    bubble.className = 'bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-tl-none px-4 py-3 text-sm max-w-[min(36rem,85vw)] md:max-w-xl leading-relaxed shadow-md whitespace-pre-wrap break-words overflow-wrap-anywhere min-w-0';
    bubble.style.overflowWrap = 'anywhere';
    bubble.textContent = '';
    wrapper.appendChild(bubble);
    messagesDiv.appendChild(wrapper);
    scrollToBottom();
    return bubble;
}

function appendMessage(role, content) {
    const wrapper = document.createElement('div');
    wrapper.className = `${role === 'user' ? 'justify-end' : 'justify-start'} flex min-w-0`;
    if (role === 'user') {
        const div = document.createElement('div');
        div.className = 'bg-indigo-600 text-white rounded-2xl rounded-tr-none px-4 py-3 text-sm max-w-[min(28rem,85vw)] md:max-w-lg shadow-md whitespace-pre-wrap break-words min-w-0';
        div.style.overflowWrap = 'anywhere';
        div.textContent = content;
        wrapper.appendChild(div);
    } else {
        const bubble = document.createElement('div');
        bubble.className = 'bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-tl-none px-4 py-3 text-sm max-w-[min(36rem,85vw)] md:max-w-xl leading-relaxed shadow-md whitespace-pre-wrap break-words min-w-0';
        bubble.style.overflowWrap = 'anywhere';
        bubble.textContent = content;
        wrapper.appendChild(bubble);
    }
    messagesDiv.appendChild(wrapper);
    scrollToBottom();
}

function appendLoading() {
    const id = 'loading-' + Date.now();
    const wrapper = document.createElement('div');
    wrapper.id = id;
    wrapper.className = 'flex justify-start';
    wrapper.innerHTML = `
        <div class="bg-slate-900 border border-slate-800 text-slate-400 rounded-2xl rounded-tl-none px-4 py-3 text-sm flex items-center space-x-2">
            <span class="animate-pulse">OpenCode 正在處理並調用 MCP 工具...</span>
        </div>
    `;
    messagesDiv.appendChild(wrapper);
    scrollToBottom();
    return id;
}

function removeLoading(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

async function loadHistory() {
    messagesDiv.innerHTML = '';
    try {
        const res = await fetch(`/api/history?sessionId=${encodeURIComponent(currentSessionId)}&limit=100`, { credentials: 'include' });
        if (res.status === 401) { loginOverlay.classList.remove('hidden'); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
            welcomeSection.classList.add('hidden');
            rows.forEach(r => appendMessage(r.role === 'user' ? 'user' : 'ai', r.content));
        } else {
            welcomeSection.classList.remove('hidden');
        }
    } catch(e) { console.warn('history load failed', e); }
}

async function loadSessions() {
    try {
        const res = await fetch('/api/sessions?limit=50', { credentials: 'include' });
        if (res.status === 401) { document.getElementById('session-count').textContent = '需登入'; return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const sessions = await res.json();
        document.getElementById('session-count').textContent = sessions.length ? `${sessions.length} 則` : '';
        if (!Array.isArray(sessions) || sessions.length === 0) {
            sessionListEl.innerHTML = '<div class="text-xs text-slate-500 px-2 py-2">尚無對話</div>';
            return;
        }
        sessionListEl.innerHTML = '';
        sessions.forEach(s => {
            const isActive = s.session_id === currentSessionId;
            const row = document.createElement('div');
            row.className = `group flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition ${isActive ? 'bg-slate-800 text-indigo-300 border border-slate-700' : 'hover:bg-slate-800/60 text-slate-400 hover:text-slate-200'}`;
            row.dataset.sessionId = s.session_id;
            row.addEventListener('click', () => switchSession(s.session_id));

            const left = document.createElement('div');
            left.className = 'flex-1 min-w-0 text-left';
            const title = document.createElement('div');
            title.className = 'text-xs font-medium truncate';
            title.textContent = (s.preview || '(空對話)').slice(0, 28);
            const meta = document.createElement('div');
            meta.className = 'text-[10px] opacity-60 truncate';
            const date = new Date(s.updated_at).toLocaleDateString('zh-TW', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
            meta.textContent = `${s.msg_count} 則 · ${date}`;
            left.appendChild(title);
            left.appendChild(meta);

            const delBtn = document.createElement('button');
            delBtn.className = 'opacity-0 group-hover:opacity-100 ml-2 p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-red-400 transition';
            delBtn.title = '刪除';
            delBtn.innerHTML = '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i>';
            delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.session_id); });

            row.appendChild(left);
            row.appendChild(delBtn);
            sessionListEl.appendChild(row);
        });
        lucide.createIcons();
    } catch(e) { sessionListEl.innerHTML = '<div class="text-xs text-red-400 px-2">載入失敗</div>'; }
}

function switchSession(id) {
    if (!/^[a-zA-Z0-9._\-]{1,128}$/.test(id) && !/^[0-9a-fA-F-]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
        console.warn('Invalid sessionId', id);
        return;
    }
    currentSessionId = id;
    localStorage.setItem('todayai_session', id);
    loadHistory();
    loadSessions();
}
window.switchSession = switchSession;

function createNewSession() {
    currentSessionId = crypto.randomUUID();
    localStorage.setItem('todayai_session', currentSessionId);
    messagesDiv.innerHTML = '';
    welcomeSection.classList.remove('hidden');
    loadSessions();
}
window.createNewSession = createNewSession;

async function deleteSession(id) {
    if (!confirm('確定刪除此對話？')) return;
    try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
        if (res.status === 401) { loginOverlay.classList.remove('hidden'); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch(e) { console.warn('delete failed', e); }
    if (id === currentSessionId) createNewSession();
    else loadSessions();
}
window.deleteSession = deleteSession;
window.clearChat = createNewSession;

checkAuth().then(ok => {
    if (ok) {
        loadHistory();
        loadSessions();
    }
});

function scrollToBottom() {
    const container = document.getElementById('chat-container');
    container.scrollTop = container.scrollHeight;
}

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

function renderProposalCard(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const proposalId = typeof data.proposalId === 'string' ? data.proposalId : '';
    if (!proposalId) return null;
    if (proposalCards.has(proposalId)) return proposalCards.get(proposalId).root;
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

    messagesDiv.appendChild(wrapper);
    scrollToBottom();
    proposalCards.set(proposalId, { root: wrapper, statusEl, approveBtn, rejectBtn, state: 'pending' });
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
            body: JSON.stringify({ sessionId: (typeof currentSessionId === 'string' ? currentSessionId : null) })
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

async function fetchProposalAndRender(proposalId) {
    if (!proposalId || proposalCards.has(proposalId)) return proposalCards.get(proposalId) || null;
    try {
        const qs = (typeof currentSessionId === 'string' && currentSessionId) ? `?sessionId=${encodeURIComponent(currentSessionId)}` : '';
        const res = await fetch(`/api/change-proposals/${encodeURIComponent(proposalId)}${qs}`, { credentials: 'include' });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        if (!data || data.proposalId !== proposalId) return null;
        renderProposalCard(data);
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
