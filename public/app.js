lucide.createIcons();

document.getElementById('current-date').innerText = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
});

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

const input = document.getElementById('user-input');
const messagesDiv = document.getElementById('messages');
const welcomeSection = document.getElementById('welcome-section');
const sessionListEl = document.getElementById('session-list');

input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function usePrompt(text) {
    input.value = text;
    sendMessage();
}
window.usePrompt = usePrompt;

async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 8000) {
        appendMessage('ai', '訊息過長 (max 8000)');
        return;
    }

    welcomeSection.classList.add('hidden');
    appendMessage('user', text);
    input.value = '';

    const loadingId = appendLoading();

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text, sessionId: currentSessionId })
        });
        const data = await res.json();
        removeLoading(loadingId);
        if (!res.ok) {
            appendMessage('ai', `錯誤 ${res.status}: ${escapeHtml(data.error || '未知錯誤')}${data.details ? '\n' + escapeHtml(data.details.slice(0,300)) : ''}`);
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

function appendMessage(role, content) {
    const wrapper = document.createElement('div');
    wrapper.className = `flex space-x-3 ${role === 'user' ? 'justify-end' : 'justify-start'}`;
    if (role === 'user') {
        const div = document.createElement('div');
        div.className = 'bg-indigo-600 text-white rounded-2xl rounded-tr-none px-4 py-3 text-sm max-w-lg shadow-md whitespace-pre-wrap';
        div.textContent = content;
        wrapper.appendChild(div);
    } else {
        const icon = document.createElement('div');
        icon.className = 'w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-xs text-white shrink-0 mt-1';
        icon.textContent = 'T';
        const bubble = document.createElement('div');
        bubble.className = 'bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-tl-none px-4 py-3 text-sm max-w-xl leading-relaxed shadow-md whitespace-pre-wrap';
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
        const res = await fetch(`/api/history?sessionId=${encodeURIComponent(currentSessionId)}&limit=100`);
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
        const res = await fetch('/api/sessions?limit=50');
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
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch(e) { console.warn('delete failed', e); }
    if (id === currentSessionId) createNewSession();
    else loadSessions();
}
window.deleteSession = deleteSession;
window.clearChat = createNewSession;

loadHistory();
loadSessions();

function scrollToBottom() {
    const container = document.getElementById('chat-container');
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
