require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const { getSql, initDb, saveLog } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// 初始化 Neon 資料庫
initDb();

// 靜態檔案服務 (提供 public/index.html)
app.use(express.static(path.join(__dirname, '../public')));

// 核心對話 API 端點 (含 Neon 持久化)
app.post('/api/chat', async (req, res) => {
    const { prompt, sessionId = 'default' } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    const start = Date.now();
    // 先寫入 user 訊息 (非阻塞)
    saveLog({ sessionId, role: 'user', content: prompt, prompt });

    // 使用 JSON 轉義避免 command injection，改用 opencode run (新版 CLI 已移除 -p)
    const escapedPrompt = JSON.stringify(prompt);
    const command = `opencode run ${escapedPrompt}`;
    console.log(`[OpenCode Executing]: ${command}`);

    exec(command, { maxBuffer: 1024 * 1024 * 20, timeout: 120000 }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`[OpenCode Error]:`, stderr || error.message);
            const errMsg = stderr || error.message;
            await saveLog({ sessionId, role: 'ai', content: `ERROR: ${errMsg}`, prompt, latencyMs: Date.now() - start });
            return res.status(500).json({
                error: 'OpenCode 執行失敗',
                details: errMsg,
                hint: '請確認已執行 /connect 設定 LLM Provider (opencode auth) 且 opencode --version 可用'
            });
        }

        const result = stdout.trim();
        await saveLog({ sessionId, role: 'ai', content: result, prompt, latencyMs: Date.now() - start });
        res.json({ result });
    });
});

// 對話歷史 Persistence (Neon)
app.get('/api/history', async (req, res) => {
    try {
        const sql = getSql();
        if (!sql) return res.json([]);
        const sessionId = req.query.sessionId || 'default';
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const rows = await sql`SELECT id, session_id, role, content, prompt, latency_ms, created_at FROM chat_logs WHERE session_id = ${sessionId} ORDER BY created_at ASC LIMIT ${limit}`;
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
        await sql`DELETE FROM chat_logs WHERE session_id = ${sessionId}`;
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

app.listen(PORT, () => {
    console.log(`==========================================`);
    console.log(` Today AI 系統已啟動：http://localhost:${PORT}`);
    console.log(`==========================================`);
});
