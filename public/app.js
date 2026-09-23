// Early stubs so inline onclick never sees undefined even if later init throws
window.toggleSidebar = function() { console.warn('toggleSidebar stub called before init'); };
window.sendMessage = function() { console.warn('sendMessage stub called before init'); };
window.usePrompt = function(t) { const el=document.getElementById('user-input'); if(el){el.value=t; window.sendMessage();} };
try { if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons(); } catch {}
try {
const _cd = document.getElementById('current-date');
if (_cd) _cd.innerText = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
});
} catch {}

let currentSessionId = (() => {
    const v = localStorage.getItem('todayai_session');
    // Validate stored sessionId is UUID or safe
    if (v && /^[0-9a-fA-F-]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) return v;
    if (v && /^[a-zA-Z0-9._\-]{1,128}$/.test(v)) return v;
    const id = crypto.randomUUID();
    localStorage.setItem('todayai_session', id);
    return id;
})();
if (!localStorage.getItem('todayai_session')) localStorage.setItem('todayai_session', currentSessionId);

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
        window.sendMessage();
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
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 8000) {
        appendMessage('ai', '訊息過長 (max 8000)');
        return;
    }

    welcomeSection.classList.add('hidden');
    appendMessage('user', text);
    input.value = '';

    // Abort any previous in-flight stream before starting a new one.
    if (currentStreamController) {
        try { currentStreamController.abort(); } catch {}
        currentStreamController = null;
    }

    const loadingId = appendLoading();
    const streamed = await sendMessageStream(text, loadingId);
    if (streamed) return;
    // Fallback: legacy non-streaming endpoint (kept for compatibility).
    await sendMessageLegacy(text, loadingId);
}

// Streaming path: POST /api/chat/stream (SSE). Returns true when the
// stream endpoint handled the request (success or clean error).
async function sendMessageStream(text, loadingId) {
    const controller = new AbortController();
    currentStreamController = controller;
    let bubble = null;
    let fullText = '';
    let handled = false;
    // P1-1 activity state: dedupe by callId/partId
    let activityBox = null;
    let activityList = null;
    const activityMap = new Map();
    function ensureActivityBox() {
        if (activityBox) return;
        const wrap = document.createElement('div');
        wrap.className = 'flex space-x-3 justify-start';
        const icon = document.createElement('div');
        icon.className = 'w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center font-bold text-xs text-slate-400 shrink-0 mt-1';
        icon.innerHTML = '<i data-lucide="loader-circle" class="w-4 h-4 animate-spin"></i>';
        try { if (window.lucide) lucide.createIcons({ nodes: [icon] }); } catch {}
        activityBox = document.createElement('div');
        activityBox.className = 'bg-slate-900/60 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-slate-400 max-w-xl w-full leading-relaxed shadow-sm space-y-1 overflow-hidden';
        activityBox.innerHTML = '<div class="flex items-center gap-2 text-[11px] tracking-wider text-slate-500 uppercase"><span class="w-2 h-2 rounded-full bg-amber-400/60 animate-pulse shrink-0"></span>背景活動</div>';
        activityList = document.createElement('div');
        activityList.className = 'space-y-1 pt-1';
        activityBox.appendChild(activityList);
        wrap.appendChild(icon);
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
    function finalizeActivity() {
        if (!activityBox) return;
        const header = activityBox.querySelector('div');
        if (header) header.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400/60 shrink-0 inline-block"></span> 已完成 · ' + activityMap.size + ' 項活動';
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
                    fullText += obj.content;
                    if (!bubble) bubble = appendStreamingMessage();
                    bubble.textContent = fullText;
                    scrollToBottom();
                } else if (ev === 'tool.started' || ev === 'tool.completed' || ev === 'command.started' || ev === 'command.completed') {
                    upsertActivity(obj);
                } else if (ev === 'message.completed' || ev === 'done') {
                    finalizeActivity();
                    if (!bubble && fullText) bubble = appendStreamingMessage();
                    if (bubble) bubble.textContent = fullText || bubble.textContent;
                    loadSessions();
                } else if (ev === 'error') {
                    finalizeActivity();
                    if (!bubble) bubble = appendStreamingMessage();
                    bubble.textContent = `錯誤：${obj.message || '未知錯誤'}`;
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
            appendMessage('ai', '已取消生成。');
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

async function sendMessageLegacy(text, loadingId) {
    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
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
        appendMessage('ai', '連線失敗，請確認後端 Bridge Server 是否已啟動。');
    }
}
window.sendMessage = sendMessage;

// Streaming AI bubble: same styling as appendMessage('ai'), but returns the
// text node so chunks can update it incrementally (textContent = XSS-safe).
function appendStreamingMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex space-x-3 justify-start min-w-0';
    const icon = document.createElement('div');
    icon.className = 'w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-xs text-white shrink-0 mt-1';
    icon.textContent = 'T';
    const bubble = document.createElement('div');
    bubble.className = 'bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-tl-none px-4 py-3 text-sm max-w-[min(36rem,85vw)] md:max-w-xl leading-relaxed shadow-md whitespace-pre-wrap break-words overflow-wrap-anywhere min-w-0';
    bubble.style.overflowWrap = 'anywhere';
    bubble.textContent = '';
    wrapper.appendChild(icon);
    wrapper.appendChild(bubble);
    messagesDiv.appendChild(wrapper);
    scrollToBottom();
    return bubble;
}

function appendMessage(role, content) {
    const wrapper = document.createElement('div');
    wrapper.className = `flex space-x-3 ${role === 'user' ? 'justify-end' : 'justify-start'} min-w-0`;
    if (role === 'user') {
        const div = document.createElement('div');
        div.className = 'bg-indigo-600 text-white rounded-2xl rounded-tr-none px-4 py-3 text-sm max-w-[min(28rem,85vw)] md:max-w-lg shadow-md whitespace-pre-wrap break-words min-w-0';
        div.style.overflowWrap = 'anywhere';
        div.textContent = content;
        wrapper.appendChild(div);
    } else {
        const icon = document.createElement('div');
        icon.className = 'w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-xs text-white shrink-0 mt-1';
        icon.textContent = 'T';
        const bubble = document.createElement('div');
        bubble.className = 'bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-tl-none px-4 py-3 text-sm max-w-[min(36rem,85vw)] md:max-w-xl leading-relaxed shadow-md whitespace-pre-wrap break-words min-w-0';
        bubble.style.overflowWrap = 'anywhere';
        bubble.textContent = content;
        wrapper.appendChild(icon);
        wrapper.appendChild(bubble);
    }
    messagesDiv.appendChild(wrapper);
    scrollToBottom();
}

function appendLoading() {
    const id = 'loading-' + Date.now();
    const wrapper = document.createElement('div');
    wrapper.id = id;
    wrapper.className = 'flex space-x-3 justify-start';
    wrapper.innerHTML = `
        <div class="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-xs text-white shrink-0 mt-1">T</div>
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
