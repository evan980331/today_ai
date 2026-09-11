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

    // 使用 JSON 轉義避免 command injection，改用 opencode run (新版 CLI 已移除 -p)
    const escapedPrompt = JSON.stringify(prompt);
    const command = `opencode run ${escapedPrompt}`;
    console.log(`[OpenCode Executing]: ${command}`);

    // MCP 超時防護: 60s 內未回應則中斷，避免 hanging
    const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS) || 60000;
    let timedOut = false;
    const timer = setTimeout(async () => {
        timedOut = true;
        await saveLog({ sessionId, role: 'system', content: `TIMEOUT after ${MCP_TIMEOUT_MS}ms`, prompt, latencyMs: MCP_TIMEOUT_MS });
        if (!res.headersSent) res.status(504).json({ error: 'MCP 工具呼叫超時', details: `超過 ${MCP_TIMEOUT_MS}ms 未回應`, sessionId });
    }, MCP_TIMEOUT_MS);

    exec(command, { maxBuffer: 1024 * 1024 * 20, timeout: 120000 }, async (error, stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (error) {
            console.error(`[OpenCode Error]:`, stderr || error.message);
            const errMsg = stderr || error.message;
            const isTimeout = errMsg.includes('timed out') || errMsg.includes('ETIMEDOUT');
            await saveLog({ sessionId, role: 'ai', content: `ERROR: ${errMsg}`, prompt, latencyMs: Date.now() - start });
            return res.status(isTimeout ? 504 : 500).json({
                error: isTimeout ? 'MCP 工具呼叫超時' : 'OpenCode 執行失敗',
                details: errMsg,
                hint: '請確認已執行 /connect 設定 LLM Provider (opencode auth) 且 opencode --version 可用',
                sessionId
            });
        }

        const result = stdout.trim();
        await saveLog({ sessionId, role: 'ai', content: result, prompt, latencyMs: Date.now() - start });
        res.json({ result, sessionId });
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
