// Deterministic planner (Phase 1-C selection contract + P2-G auto selection).
// No LLM, no execution, no runtime calls, no permission checks — pure
// selection, always exactly 1 step.
//
// Contracts (all preserved):
//   tools: ['calculator'] -> { kind:'tool', name:'calculator', input }
//   tools: [] (+ no metadata) -> { kind:'runtime', name:'opencode', input }
// New (P2-G): when no explicit tools are given but tool metadata is
// provided, selectTool() deterministically picks one tool by
// keyword/capability matching, or returns null -> runtime fallback.
// Unknown tools/names are NOT validated here; execution layer raises
// TOOL_NOT_FOUND / unknown runtime with original codes.

// Write/mutation intent: tools that cannot serve these must never intercept.
// Checked first, as plain substring guards (no NLP).
// NOTE (P2-H): bare 建立/新增/寫入 (+ write/create) are NOT guards anymore —
// they are legitimate write-tool intents gated by Permission at execution.
// Generic coding intent is still caught by 幫我寫/修改/實作-style guards,
// and single-keyword tasks fall back via the MIN_SCORE threshold.
const WRITE_GUARDS = [
    '修改', '修改檔案', '改 code', '改code', '幫我改',
    '刪除', '删除', '移除文件', '刪除檔案', '刪除文件',
    '寫文件', '寫檔案',
    '執行', '運行', '跑一下', '跑個', '終端', '命令列',
    '寄信', '寄一封', '寄出', '寄給', '寄送', '傳送', '發送郵件', '發送', '回覆郵件', '整理',
    'modify', 'delete', 'remove', 'update',
    'run', 'execute', 'shell', 'command', 'send', 'npm', 'terminal',
    '撰寫', '實作', '開發', '寫一個', '寫個', '幫我寫',
    'implement', 'build'
];

// Per-tool trigger table. Entries are plain substrings (matched
// case-insensitively) or RegExp. The planner knows tool NAMES only —
// never implementations; selection is restricted to metadata actually
// provided by the caller (ToolRegistry.list()/describe() output).
// Score = number of distinct triggers matched; phrases count extra.
const TOOL_KEYWORDS = [
    { name: 'calculator', keywords: ['calculator', '計算機', '計算', '幫我算', '加減乘除', '數學', 'calculate', 'math', /\d\s*[+\-*/×÷]\s*\d/] },
    { name: 'gmail.search', keywords: ['gmail', '電子郵件', '郵件', '信件', '搜尋', '搜', '查詢', /\bemail\b/i, /\bmail\b/i, /\bsearch\b/i, '最近的郵件', '找信'] },
    { name: 'gmail.getMessage', keywords: ['gmail', '郵件', '信件', '這封', '取得', '內容', '讀取', '打開信', /\bmessage\b/i, /\bemail\b/i, /\bmail\b/i] },
    { name: 'gmail.listThreads', keywords: ['gmail', '郵件', '信件', '列出', '會話', '郵件串', /\bthread\b/i, /\bthreads\b/i, /\blist\b/i, /\bemail\b/i, /\bmail\b/i] },
    { name: 'calendar.listCalendars', keywords: ['calendar', '日曆', '行事曆', '列出', '有哪些', '日曆列表', '列出 calendar', /\bcalendars\b/i, /\blist\b/i] },
    { name: 'calendar.listEvents', keywords: ['calendar', '行事曆', '日曆', '行程', '活動', '列出', '查詢', /\bevent\b/i, /\bevents\b/i, /\blist\b/i] },
    { name: 'calendar.getEvent', keywords: ['calendar', '行事曆', '日曆', '取得', '這個', '活動詳情', /\bevent\b/i, /\bget\b/i] },
    { name: 'github.searchRepositories', keywords: ['github', 'repository', 'repositories', '倉庫', '儲存庫', '搜尋', '搜', '找', /\brepo\b/i, /\bsearch\b/i] },
    { name: 'github.getRepository', keywords: ['github', 'repository', '查看', '檢視', '資訊', '介紹', /\brepo\b/i, /\bget\b/i] },
    { name: 'github.listIssues', keywords: ['github', 'repository', '議題', '問題', '列出', /\bissue\b/i, /\bissues\b/i, /\blist\b/i, /\brepo\b/i] },
    { name: 'github.listPullRequests', keywords: ['github', 'repository', '合併請求', '列出', 'pull request', 'pull requests', /\blist\b/i, /\brepo\b/i, /\bpr\b/i] },
    { name: 'filesystem.read', keywords: ['檔案', '文件', '讀取', '打開', '開啟', '內容', '查看檔案', /\bread\b/i, /\bfile\b/i] },
    { name: 'filesystem.list', keywords: ['資料夾', '目錄', '列出', '檔案', '有哪些檔案', /\bfolder\b/i, /\bdirectory\b/i, /\blist\b/i] },
    { name: 'filesystem.write', keywords: ['寫入', '建立', '新增', '寫入檔案', '寫入文件', '建立檔案', '新增檔案', '寫一個檔案', 'write file', 'create file', 'create', /\bwrite\b/i] },
    { name: 'filesystem.createDirectory', keywords: ['建立', '新增', '建立資料夾', '建立目錄', '新增資料夾', '建立文件夹', '開新資料夾', 'create directory', 'mkdir', /\bdirectory\b/i] }
];

// Minimum score for a confident selection; the best match must also be
// strictly unique, otherwise the task is ambiguous -> fallback.
const MIN_SCORE = 2;

function normalizeText(task) {
    if (typeof task === 'string') return task.toLowerCase();
    if (task && typeof task.prompt === 'string') return task.prompt.toLowerCase();
    return '';
}

function hasWriteIntent(text) {
    return WRITE_GUARDS.some((g) => text.includes(g.toLowerCase()));
}

function countMatches(text, keywords) {
    let score = 0;
    for (const k of keywords) {
        if (typeof k === 'string') {
            if (k && text.includes(k.toLowerCase())) score += 1;
        } else if (k instanceof RegExp) {
            const re = new RegExp(k.source, k.flags.includes('i') ? k.flags : `${k.flags}i`);
            if (re.test(text)) score += 1;
        }
    }
    return score;
}

// Pure selection: (taskText, metadataList) -> metadata entry or null.
// Only tools present in `tools` can be selected; the input list is never
// mutated. Deterministic: same inputs always yield the same output.
function selectTool(task, tools) {
    const text = normalizeText(task);
    if (!text || !Array.isArray(tools) || tools.length === 0) return null;
    if (hasWriteIntent(text)) return null;
    const available = new Map();
    for (const t of tools) {
        if (t && typeof t.name === 'string') available.set(t.name, t);
    }
    let best = null;
    let bestScore = 0;
    let tied = false;
    for (const entry of TOOL_KEYWORDS) {
        const meta = available.get(entry.name);
        if (!meta) continue;
        const score = countMatches(text, entry.keywords);
        if (score > bestScore) {
            best = meta;
            bestScore = score;
            tied = false;
        } else if (score === bestScore && score > 0) {
            tied = true;
        }
    }
    if (!best || bestScore < MIN_SCORE || tied) return null;
    return best;
}

function plan(task, opts = {}) {
    if (!task || typeof task !== 'object') {
        throw Object.assign(new Error('planner requires task'), { code: 'PLANNING_ERROR', status: 400 });
    }
    const prompt = typeof task.prompt === 'string' ? task.prompt : '';
    const tools = Array.isArray(task.tools) ? task.tools : [];
    if (tools.length > 0) {
        const name = tools[0];
        if (typeof name !== 'string' || !name) {
            throw Object.assign(new Error('planner requires tool name'), { code: 'PLANNING_ERROR', status: 400 });
        }
        return [{ id: 'step-1', kind: 'tool', name, input: prompt, description: `tool:${name}` }];
    }
    // No explicit tools: try deterministic auto selection when metadata is
    // provided; otherwise (or on no match) fall back to runtime.
    const metadata = Array.isArray(opts.toolMetadata) ? opts.toolMetadata : null;
    if (metadata) {
        const selected = selectTool(prompt, metadata);
        if (selected) {
            return [{ id: 'step-1', kind: 'tool', name: selected.name, input: prompt, description: `tool:${selected.name}` }];
        }
    }
    const name = typeof task.runtime === 'string' && task.runtime ? task.runtime : 'opencode';
    return [{ id: 'step-1', kind: 'runtime', name, input: prompt, description: `runtime:${name}` }];
}

module.exports = { plan, selectTool, TOOL_KEYWORDS, WRITE_GUARDS, MIN_SCORE };
