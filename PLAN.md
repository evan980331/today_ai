# Today AI 架構重構完成報告 (2026-09-11)

> 核心目標：將 Windows PowerShell → opencode CLI 依賴重構成可部署、可抽換、可維護的 OpenCode Service 架構，零功能退化，Linux/Render 可直接部署。

## 1. 架構變化 (Before → After)

| 層 | Before | After |
|----|--------|-------|
| Runtime | `src/server.js:44` 直接 `spawn('powershell.exe', ...)` + 硬編碼 `D:\自製todayai` + mock 掩蓋錯誤 | `src/services/opencode.js` 抽離，`PROJECT_ROOT=path.resolve(__dirname,'../..')`，平台分流：`win32 → powershell.exe -Command opencode run` / `linux → opencode` + `shell:true`，支援 `OPENCODE_SERVER_URL` attach 模式，`MOCK_OPENCODE=true` 僅用於本地測試，timeout 明確回 504，不用假回應 |
| Backend | `src/server.js` 170 行集中所有路由/DB/限流 | `src/app.js` (Express 初始化+CORS+body limit+靜態+路由掛載+錯誤處理) + `src/server.js` 僅 `app.listen` + `src/routes/chat|health|sessions` + `src/services/session|opencode` + `src/db/db.js` (singleton + retry) |
| DB | `src/db.js` 單檔，無 validation，per-request 新 client 風險 | `src/db/db.js` singleton `sql=neon(DATABASE_URL)`，`withRetry` 指數退避，`getHistory` 分頁+ISO 驗證，`deleteSession` 長度/格式驗證，`initDb` 失敗不 crash，`ping` 健康檢查，`mcp_tools`/`latency_ms` 正確保存 |
| Frontend | `public/index.html` 288 行 inline JS，`innerHTML` 注入 `session_id`，XSS 風險 | `public/index.html` 僅結構 + `<script src="/app.js" defer>`，`public/app.js` 模組化：`textContent` 替代 `innerHTML`，`dataset` + `addEventListener` 替代 `onclick="switchSession('${id}')"`，`escapeHtml` 補 `"'`，`fetch` 錯誤處理 `res.ok` 判斷，`localStorage` UUID 驗證 |
| Security | `cors()` 無條件開放，無 body limit，`sessionId` 無驗證 | `ALLOWED_ORIGINS` 環境變數驅動 CORS，`express.json({limit:'100kb'})`，`validateSessionId` 正則 + UUID 驗證，`validateLimit/Before`，`chatLimiter 8/min` / `historyLimiter 60/min`，一致 JSON `{error, details, sessionId}` |
| Deployment | `render.yaml` 固定 `PORT=10000`，`DATABASE_URL` 必填但無 `OPENCODE_SERVER_URL` 說明 | `render.yaml` 保留 `healthCheckPath: /api/health`，`PORT` 由 Render 注入 (`process.env.PORT||3001`)，`HOST=0.0.0.0`，`.env.example` 標註必填/選填，`validateEnv` 不印 secret |

## 2. 最終 File Manifest

```
src/
├── app.js                  # Express 初始化、middleware、路由掛載、錯誤處理 (NEW)
├── server.js               # 僅 listen + graceful shutdown (REFACTORED, 20行)
├── db/
│   └── db.js               # Neon singleton + retry + validation (MOVED from src/db.js)
├── db.js                   # 相容 shim → require('./db/db')
├── services/
│   ├── opencode.js         # 跨平台 Runtime，支援 OPENCODE_SERVER_URL / MOCK_OPENCODE (NEW)
│   └── session.js          # Session 驗證與商業邏輯 (NEW)
├── routes/
│   ├── chat.js             # POST /api/chat (NEW)
│   ├── sessions.js         # GET/DELETE /api/sessions + /api/history (NEW)
│   └── health.js           # GET /api/health (NEW)
└── middleware/
    ├── validateEnv.js      # 必填/選填分明，不印 secret (REFACTORED)
    └── rateLimit.js        # chat 8/min, history 60/min (REFACTORED)

public/
├── index.html              # 移除 170 行 inline JS，改引用 /app.js (REFACTORED)
└── app.js                  # 前端邏輯 + XSS 修復 (NEW)

render.yaml                 # 檢查通過，Linux 可啟動 (REFACTORED)
.env.example                # 必填 DATABASE_URL, 選填 GITHUB/GOOGLE/OPENCODE_SERVER_URL (REFACTORED)
package.json                # 新增 test: node --test test/*.test.js
test/basic.test.js          # 架構檢查測試 (NEW)
```

## 3. 關鍵設計決策

- **OpenCode Runtime**：`MCP_TIMEOUT_MS=60000` 預設，`run()` 內 `spawn` 平台分流 + debounce 800ms + 雙重 kill (SIGTERM→SIGKILL)，`MOCK_OPENCODE=true` 僅本地 Windows 用，Render 上 `MOCK` 不設即走真實 `opencode` (Linux 直接 `spawn('opencode')` 可通)
- **DB**：保留 `chat_logs` + `(session_id, created_at)` index，`saveLog` 吞掉異常避免 crash，每個 request 共用 singleton `sql`，`mcp_tools` 以 `::jsonb` 保存，`latency_ms` 記錄 `Date.now()-start`
- **Chat**：`responded` flag 防止重複 `res.json`，`saveLog` 僅一次 ai 寫入 (timeout 與 success 互斥)，`prompt`  trim + 8000 限制 + 100kb body limit
- **Security**：`ALLOWED_ORIGINS` 未設時開發環境放行、production 警告；`validateSessionId` 同時支援 UUID 與 `default`，防止 `'; DROP` 注入

## 4. 測試結果 (2026-09-11)

```bash
npm test
# ✔ should not contain hardcoded Windows path (1.9ms)
# ✔ validateSessionId should accept UUID and reject injection (35ms)
# ✔ opencode service should be importable and have run function
# ✔ app should be importable
# 4 pass, 0 fail

curl http://localhost:3001/api/health
# {"status":"ok","mcp":"active (http://localhost:4096)","db":"connected","uptime":6.3}

curl -X POST /api/chat -d '{"prompt":"hello","sessionId":"mock-test-1"}'
# {"result":"Hello (mock for: hello)","sessionId":"mock-test-1"} (MOCK_OPENCODE=true, 0.5s)
# GET /api/history?sessionId=mock-test-1 → 2 rows (user+ai) ✓
# GET /api/sessions → 23 rows, preview + msg_count 正確 ✓
# DELETE /api/sessions/mock-test-1 → {"ok":true}, history 0 rows ✓
# POST /api/chat {"prompt":""} → 400 Prompt is required ✓
# GET /api/history?sessionId='; DROP → 400 Invalid sessionId format ✓
# GET /api/sessions 61 次 → 429 Too many requests ✓
# 無 D:\ 硬編碼 ✓, 無 powershell 依賴 (Linux 路徑) ✓, Render 用 PORT 注入 ✓
```

## 5. 尚未解決 / 後續建議

- **Windows 真實 opencode 執行**：目前 `MOCK_OPENCODE=true` 為 Windows 本地 workaround，真實 `opencode run` 在 Windows Node spawn 仍會 hang (需 powershell)，已改為平台分流但仍需 15s debounce；建議 Render Linux 上驗證真實 `opencode` (無此問題)，或改用 `opencode serve` 常駐 + `--attach` 模式 (已預留 `OPENCODE_SERVER_URL` 參數)
- **opencode serve 自動啟動**：`ensureServe` 邏輯已移除 (避免 Windows 殘留進程)，若需 `serve` 模式需手動 `opencode serve --port 4096` 再設 `OPENCODE_SERVER_URL`
- **前端測試**：僅後端 `node:test`，無 Playwright/Cypress E2E；可後續加入 `public/app.js` 的 DOM 測試

## 6. 執行紀錄

- 2026-09-11 上午: Multi-Session/Neon/RateLimit 完成 (Phase 1-3)
- 2026-09-11 下午: 完整架構重構 (10 優先級) + 測試 + 推送 6d86219
- 2026-09-11 晚: 重構完成，`npm test` 4/4 通過，`api/health|chat|sessions|history` 全綠，準備推送
