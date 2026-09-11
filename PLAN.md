# Today AI 下一步執行計畫 (Multi-Session / Deployment / Resiliency)

> 基礎已完成: `src/server.js:17` Neon 雙寫 + `src/db.js:1` + `GET /api/history` + `public/index.html:loadHistory()`。本計畫在現有之上增量，不重建 schema。
> 建立時間: 2026-09-11 | 狀態: 執行中 (Phase 1 開始)

---

## 1. 現況盤點與風險

- **Session 寫死**: `src/server.js:42` `sessionId='default'` 前後端皆固定，導致多對話無法區分；`public/index.html:clearChat()` 直接 `DELETE WHERE session_id='default'` 會清空全部
- **無部署描述**: `package.json:6` 僅 `start/dev`，無 `render.yaml`/`Dockerfile`，`PORT` 已支援 `process.env.PORT` 但未驗證 `DATABASE_URL` 缺失時 `initDb()` 僅 warn (`src/db.js:7`)，正式環境會無聲失敗
- **無防護**: 無 `express-rate-limit`、無 Neon 重連、無 MCP timeout (`src/server.js:30` 固定 120s 但無 per-request abort)

---

## 2. File Manifest (涉及修改/新增)

| 檔案 | 動作 | 內容 |
|------|------|------|
| `src/server.js` | 修改 | 新增 `GET /api/sessions` 聚合、`GET /api/history` 改支援分頁/`before`游標、加入 `rateLimit`、`validateEnv()`、`timeout` wrapper |
| `src/db.js` | 修改 | 新增 `getSessions()`, `deleteSession()`, `withRetry()` 指數退避、連線健康檢查 `ping()` |
| `src/middleware/rateLimit.js` | 新增 | `express-rate-limit` 配置 (chat 5req/min/IP, history 30req/min) |
| `src/middleware/validateEnv.js` | 新增 | 啟動時檢查 `PORT/DATABASE_URL` (可選 `GITHUB_TOKEN`)，缺失直接 `process.exit(1)` 並輸出清單 |
| `public/index.html` | 修改 | Sidebar 從靜態 (`<nav>`) 改動態 `sessions` 列表 + 新建/切換/刪除 + `localStorage sessionId` + UUID |
| `public/app.js` (可選拆分) | 新增 | 若 `index.html:112` 內聯過長，抽離前端邏輯 |
| `render.yaml` | 新增 | Render Blueprint: `services.web` + `envVars` + `healthCheckPath: /api/health` |
| `.env.example` | 修改 | 已有 `DATABASE_URL` 佔位，需補 `NODE_ENV` 註解與必填標記 |
| `package.json` | 修改 | 新增 `dependencies: express-rate-limit, uuid` |
| `AGENTS.md` | 修改 (可選) | 記錄 run/test/verify 指令供 OpenCode 理解 |

**不新增**: `opencode.json` 無需改，Neon 表 `chat_logs` 已有 `session_id` 索引 `idx_chat_logs_session_created` 可直接聚合。

---

## 3. 階段性開發順序 (3 階段，依賴由低到高)

### Phase 1: 後端 Multi-Session API (無 UI 風險)

**目標**: 淘汰 `default` 依賴，提供可測試的 session 抽象。

**步驟**:
1. `src/db.js` 新增 `getSessions(limit)`, `deleteSession(sessionId)`, `withRetry()` 指數退避
2. `src/server.js` 新增 `GET /api/sessions`, 修改 `GET /api/history` 支援 `?sessionId=uuid&limit&before=ISO`, `DELETE /api/sessions/:id`
3. `POST /api/chat` 若空則後端 `uuidv4()` 生成並回 `sessionId`

**驗證 (curl)**:
```bash
curl -X POST http://localhost:3001/api/chat -H "Content-Type: application/json" -d '{"prompt":"hello s1","sessionId":"test-aaa"}'
curl -X POST http://localhost:3001/api/chat -H "Content-Type: application/json" -d '{"prompt":"hello s2","sessionId":"test-bbb"}'
curl http://localhost:3001/api/sessions
curl "http://localhost:3001/api/history?sessionId=test-aaa"
curl -X DELETE http://localhost:3001/api/sessions/test-bbb
```

### Phase 2: 前端 Sidebar 與部署配置 (可並行)

**A. UI Upgrade (`public/index.html`)**:
- `aside` 內 `#session-list` 容器
- `localStorage.getItem('todayai_session') || crypto.randomUUID()` → `loadSessions() → renderSidebar()` → `loadHistory(sessionId)`
- 按鈕: `+ 新對話`, 每項 `刪除`

**B. Deployment (`render.yaml` + validateEnv)**:
- `render.yaml` 含 `healthCheckPath: /api/health`
- `app.listen(PORT,'0.0.0.0')` 確保容器外可訪問
- `validateEnv.js` 缺 `DATABASE_URL` 直接報錯退出

### Phase 3: Resiliency & Security

1. **Rate Limit**: `express-rate-limit` (chat 5req/min, history 30req/min)
2. **Neon 重試**: `withRetry` 指數退避 200ms*2^n
3. **MCP Timeout**: `Promise.race` + `AbortController` 60s，主動 kill 並回 504

---

## 4. 交付檢查清單

- [ ] `curl /api/sessions` 回聚合列表
- [ ] 前端可新建/切換/刪除 session，F5 後 `localStorage` 恢復
- [ ] `render.yaml` push 後 Render 一鍵部署成功
- [ ] 缺 `DATABASE_URL` 啟動直接報錯退出
- [ ] 6 次連打 `/api/chat` 第6次 429
- [ ] 拔 Neon 網線模擬中斷，3 次重試後 `db:error` 但服務不 crash

## 5. MCP 連接說明 (GitHub / Gmail / Google Calendar)

見下方獨立章節 `MCP 連接指南`。

---

## 6. 執行紀錄

- 2026-09-11: Plan 建立並開始 Phase 1
- 2026-09-11: Phase 1-3 全部完成並驗證 (sessions/history/rate-limit 429 觸發成功)，已準備推送

## 7. 驗證結果

- `GET /api/sessions` 聚合成功 (test-sess-1/2)
- `GET /api/history?sessionId=test-sess-1` 分頁正確
- `DELETE /api/sessions/:id` 刪除成功
- `GET /api/sessions` 61 次觸發 `429 Too many requests` (historyLimiter 60/min)
- `GET /api/health` → `db:connected`
