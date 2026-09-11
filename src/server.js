require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const { getSql, initDb, saveLog } = require('./db');
const { validateEnv } = require('./middleware/validateEnv');
const { chatLimiter, historyLimiter } = require('./middleware/rateLimit');

validateEnv();

const app = express();
const PORT = process.env.PORT || 3001;
const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";

app.use(cors());
app.use(express.json());

// 初始化 Neon 資料庫 (含重試)
initDb();
setInterval(() => {
    const { ping } = require('./db');
    ping().catch(() => console.warn('[DB] ping failed, will retry on next request'));
}, 30000);

// 靜態檔案服務 (提供 public/index.html)
app.use(express.static(path.join(__dirname, '../public')));

// 核心對話 API 端點 (含 Neon 持久化 + 自動 sessionId) + RateLimit + Timeout 防護
app.post('/api/chat', chatLimiter, async (req, res) => {
    let { prompt, sessionId } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }
    if (!sessionId) {
        sessionId = require('crypto').randomUUID();
    }

    const start = Date.now();
    // 先寫入 user 訊息 (非阻塞)
    saveLog({ sessionId, role: 'user', content: prompt, prompt });

    // 最佳方案：Windows TTY 限制導致直接 spawn 會 hang，改用 powershell -Command 經驗證可通 (test_spawn2 成功)
    // 若 15 秒內未回應則 fallback 為 mock 回應，保證 UI 不卡死且仍寫入 Neon
    const { spawn } = require('child_process');
    const escapedPrompt = JSON.stringify(prompt);
    const psCommand = `opencode run --auto ${escapedPrompt}`;
    console.log(`[OpenCode Executing]: ${psCommand}`);

    const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS) || 15000;
    let timedOut = false;
    let child;
    const timer = setTimeout(async () => {
        timedOut = true;
        try { child && child.kill(); } catch {}
        // Fallback mock：仍寫入 ai 回應讓前端有感，標記為 mock
        const mock = `Hello (mock fallback - opencode busy, prompt: ${prompt.slice(0,60)})`;
        await saveLog({ sessionId, role: 'ai', content: mock, prompt, latencyMs: MCP_TIMEOUT_MS });
        if (!res.headersSent) res.json({ result: mock, sessionId, mocked: true, hint: "Windows Bridge 直接 run 會因 TTY hang，建議直接用終端機 opencode run 或啟用 opencode serve --attach" });
    }, MCP_TIMEOUT_MS);

    child = spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
        cwd: "D:\\自製todayai",
        env: process.env,
        windowsHide: true
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', async (code) => {
        if (timedOut) return;
        clearTimeout(timer);
        const raw = (stdout.trim() || stderr.trim());
        const clean = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^>.*$/gm, '').trim();
        const result = clean || (code === 0 ? "(empty)" : `ERROR: ${stderr.trim() || "exit "+code}`);
        const isError = code !== 0 && !stdout.trim();
        if (isError) {
            await saveLog({ sessionId, role: 'ai', content: result, prompt, latencyMs: Date.now() - start });
            if (!res.headersSent) return res.status(500).json({ error: 'OpenCode 執行失敗', details: result, sessionId });
        }
        await saveLog({ sessionId, role: 'ai', content: result, prompt, latencyMs: Date.now() - start });
        if (!res.headersSent) res.json({ result, sessionId });
    });
    child.on('error', async (e) => {
        if (timedOut) return;
        clearTimeout(timer);
        await saveLog({ sessionId, role: 'ai', content: `ERROR: ${e.message}`, prompt, latencyMs: Date.now() - start });
        if (!res.headersSent) res.status(500).json({ error: e.message, sessionId });
    });
});

// 對話歷史 Persistence (Neon) - 支援分頁游標
app.get('/api/history', historyLimiter, async (req, res) => {
    try {
        const sql = getSql();
        if (!sql) return res.json([]);
        const sessionId = req.query.sessionId || 'default';
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const before = req.query.before; // ISO timestamp
        let rows;
        if (before) {
            rows = await sql`SELECT id, session_id, role, content, prompt, latency_ms, created_at FROM chat_logs WHERE session_id = ${sessionId} AND created_at < ${before}::timestamptz ORDER BY created_at ASC LIMIT ${limit}`;
        } else {
            rows = await sql`SELECT id, session_id, role, content, prompt, latency_ms, created_at FROM chat_logs WHERE session_id = ${sessionId} ORDER BY created_at ASC LIMIT ${limit}`;
        }
        res.json(rows);
    } catch (e) {
        console.error('[DB] history fetch failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/history', async (req, res) => {
    try {
        const sql = getSql();
        if (!sql) return res.json({ ok: true });
        const sessionId = req.query.sessionId || 'default';
        const { deleteSession } = require('./db');
        await deleteSession(sessionId);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 多會話聚合 API
app.get('/api/sessions', historyLimiter, async (req, res) => {
    try {
        const { getSessions } = require('./db');
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const rows = await getSessions(limit);
        res.json(rows);
    } catch (e) {
        console.error('[DB] sessions fetch failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/sessions/:id', async (req, res) => {
    try {
        const { deleteSession } = require('./db');
        await deleteSession(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 健康檢查 (含 DB 狀態)
app.get('/api/health', async (req, res) => {
    let db = 'not_configured';
    if (process.env.DATABASE_URL) {
        try {
            const sql = getSql();
            await sql`SELECT 1 as ok`;
            db = 'connected';
        } catch (e) {
            db = 'error: ' + e.message;
        }
    }
    res.json({ status: 'ok', mcp: 'active', db });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`==========================================`);
    console.log(` Today AI 系統已啟動：http://localhost:${PORT} (0.0.0.0)`);
    console.log(` ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log(`==========================================`);
});
