# Today AI P0.9 報告 (2026-09-12, Remote stream 打通)

> `/api/chat/stream` 經同一 `useRemoteWorker()` 切遠端分支：
> Worker 端新增 `POST /workers/:id/execute/stream`（`upstream`／`done`／`error`
> SSE），`RemoteWorkerClient.executeStream()`（超時／Abort／畸形跳過／狀態映射），
> Today AI 以既有 `normalizeServerEvent` 轉換——瀏覽器事件與本機逐字相同，
> workerId／URL／secret 零外洩。修了一個真缺陷：`req.on('close')` 會在
> request body 收完即觸發，不能當 disconnect 訊號，兩條 SSE route 一律改用
> `res.on('close') ＋ !writableEnded`。另加 `WORKER_REQUEST_TIMEOUT_MS`。
> Docker／Linux 真機／Cloud／手機 E2E 在本機皆不可用，一律 SKIPPED。
> 測試：166/166（fresh server 連跑兩次穩定）。未 commit，未 push。

# 以下為上一輪報告（P0.8）

# Today AI P0.8 報告 (2026-09-12, Deployment Readiness 稽核)

> 半配置遠端 Worker（僅 `WORKER_URL` 或僅 `WORKER_SHARED_SECRET`）在
> production 直接啟動失敗（dev 警告＋本機 fallback）；`.env.example`
> `WORKSPACE_ROOT` 重複定義已合併；環境變數稽核表見
> `docs/cloud-architecture.md`（REQUIRED／OPTIONAL／DEVELOPMENT ONLY）。
> Docker／Linux 真機／雲端部署在本機皆不可用：build、smoke、Linux 整合、
> Cloud E2E、手機 E2E 全部誠實 SKIPPED，無 fake pass。
> 測試：154/154（fresh server 連跑兩次穩定）。未 push。

# 以下為上一輪報告（P0.7）

# Today AI P0.7 報告 (2026-09-12, Remote Worker 合約＋部署基礎)

> `/api/chat` 已經 `executePrompt()` 改走 Worker provider（本機 `withWorker`；
> `WORKER_URL`＋`WORKER_SHARED_SECRET` 同時存在才改走遠端；stream 維持本機）。
> 新增：`workerProvider.js`、`remoteWorker.js`、`routes/workers.js`、
> `workerServer.js` 獨立 entry、`validateWorkerEnv.js`、`scripts/`（CI 修補
> live-server 啟動）、`test/worker-remote.test.js`（13）、
> `test/integration-cloud-worker.test.js`（opt-in E2E 合約）。
> `MAX_WORKERS` 已強制執行；`MAX_WORKSPACE_SIZE_MB` 誠實標示未強制。
> Docker／Linux 真機在本機不可用：build／smoke／CI 執行皆為 SKIPPED（已明示，
> 無 fake pass）；`worker-smoke.sh` 僅通過 `bash -n` 語法檢查。
> 測試：150/150（fresh server 連跑兩次穩定）。未 push。

# 以下為上一輪報告（P0-1 ~ P0-9）

# Today AI 雲端平台化報告 (2026-09-12, P0-1 ~ P0-9)

> 上一輪「Render/Linux production ready」的說法**已撤回**：經查 `render.yaml`
> 的 `startCommand` 只有 `npm start`，production 根本沒有 OpenCode Server
> process，`OPENCODE_SERVER_URL=http://localhost:4096` 是錯誤假設。本輪把
> 架構改成「Today AI API → 外部 Agent Worker / OpenCode Server」，並讓所有
> 缺 runtime 的情況明確失敗（503），不再假裝成功。詳見 `docs/cloud-architecture.md`。

## 本輪完成

- **P0-1 Runtime 三態**：`getRuntimeMode()` → `mock/local-cli/remote-server/
  unavailable`；production `MOCK_OPENCODE=true` 直接啟動失敗；
  production 無 runtime 時 `run()`/`runStream()` 丟 `RUNTIME_UNAVAILABLE`
 （chat/stream 明確回 503）。未把 binary 硬塞進 package.json。
- **P0-2 Workspace**：`src/services/workspace.js`（`WORKSPACE_ROOT` 驅動，
  ID 驗證＋traversal 保護，零硬編碼路徑）。
- **P0-3 Session**：`agent_sessions` migration（`created/running/completed/
  failed/cancelled`，owner 暫用登入 username）；`chat_logs` 零更動。
- **P0-4 OpenCodeClient**：`health/createSession/sendPrompt/subscribeEvents/
  abortSession`；CLI transport 完整（含 `--format json` 真實事件）；
  server transport 僅 `health()`，其餘明確 `NOT_IMPLEMENTED`（官方 endpoint
  未確認，不假造）。
- **P0-5 Streaming**：`POST /api/chat/stream`（SSE，Cookie Auth，
  `POST /api/chat` 保留）；adapter 正規化（raw 不暴露）；完成才寫一次
  history；disconnect 觸發 Abort 清理。前端增量顯示＋legacy fallback。
  注意：`--format json` 的 text 是 per-step 整塊，非 token 級。
- **P0-6 Git**：`src/services/git.js`（execFile＋參數陣列，URL／ref 驗證，
  workspace-scoped，traversal 保護）。未接 OAuth。
- **P0-7 Deploy**：`render.yaml` 移除 `localhost:4096` 假設，新增
  `WORKSPACE_ROOT`／`OPENCODE_SERVER_*`／`AUTH_*`／`ALLOWED_ORIGINS`
  （secret 類 `sync:false`）；`.env.example` 重寫 runtime 說明；
  `validateEnv` production 必填加 `WORKSPACE_ROOT`，MOCK 在 production
  直接 exit(1)。
- **P0-8 Tests**：`test/cloud.test.js` 新增 46 測試（workspace 隔離／traversal、
  session schema、runtime unavailable、MOCK 禁令、server health 失敗、
  event 正規化、git 參數安全、SSE headers／done／error／abort）。
- **P0-9 Docs**：本節＋`docs/cloud-architecture.md`（完成／未完成／下一個 P0/P1）。

## 本輪測試

```bash
npm test
# tests 106, pass 106, fail 0（fresh server 連跑兩次皆穩定）
# 既有 60 個測試零修改通過（僅 auth.test.js 的 validateEnv baseProd 補
# WORKSPACE_ROOT／清 MOCK 以符合新 production 要求；rate-limit 測試改為
# 不耗盡共享 budget＋隔離式 429 驗證，見下）
```

測試穩定性修正：全 test 檔共用一個 server（login limiter 10/15min），
`cloud.test.js` 的 stream 測試改為 in-process 自起 app（獨立 limiter 實例），
不再與 `auth.test.js` 搶登入 budget。

## 已知限制／下一個 P0

見 `docs/cloud-architecture.md`「目前未完成／下一個 P0」。

---

# 以下為上一輪報告（2026-09-11，production-ready 聲明已撤回）

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

## 5. Production Readiness 驗證 (2026-09-11 晚)

**真實 OpenCode Runtime**
- `OPENCODE_SERVER_URL` 已可控制：`src/services/opencode.js:14` `isServerUrlConfigured()` + `isServerReachable()` 實際 `fetch` 探測，`run()` 內 `useAttach` 依 env 決定 `opencode run --attach URL --auto`，已用 `opencode serve --port 4096` 實測 `opencode run --attach http://localhost:4096` 可通
- `MOCK_OPENCODE` 僅 dev/test：`src/services/opencode.js:31` 判斷 `MOCK===true && NODE_ENV!==production` 才 mock，`src/middleware/validateEnv.js` 在 production 警告
- Timeout 清理：`timer` + `debounce` 雙清，`SIGTERM`→2s 後 `SIGKILL`，`settled` flag 防止重複 `resolve/reject`，併發測試 2 同時 `/api/chat` 無污染，timeout 後 `child.kill` 確保不殘留

**MCP**
- `opencode.json:14` env 名稱與 `.env` 完全一致 (`GITHUB_PERSONAL_ACCESS_TOKEN`, `CLIENT_ID` 等)，缺 credentials 時 `opencode` 僅該 MCP 啟動失敗，`src/db/db.js` `saveLog` 吞異常不 crash server
- `mcp_tools` 已完善：`src/services/opencode.js:parseMcpTools()` 同時解析 JSON `tool_use` 與 default 正則 `github_\w+|gmail_\w+|google-calendar`，實測 `opencode run --auto` 輸出含 `github_search_repositories` 等可正確提取，去重後存 `jsonb`，無工具時存 `[]`，`src/routes/chat.js` 回傳 `{result,mcpTools}` 並一次性寫入

**Render/Linux**
- 全 repo `grep -r "D:\\\\" → 0`, `grep powershell` 僅在 `process.platform==='win32'` 分支內，Linux 路徑 `spawn('opencode', ... , shell:false)` 無 Windows 依賴
- `render.yaml:8` `healthCheckPath: /api/health`，`src/server.js:4` `HOST=0.0.0.0` + `PORT=process.env.PORT`，`package.json` `start: node src/server.js` 可直接 `npm install && npm start`，無需手動 `opencode serve`

**API 併發**
- 2 併發 `POST /api/chat` 不同 `sessionId` → 各自歷史隔離 ✓
- `responded` flag + `res.headersSent` 保證 timeout/error 只回一次，`user` 先寫 `ai` 後寫，`ai` 僅一次寫入

## 6. 最終測試 (25 tests, 0 fail)

```
npm test
✔ Architecture checks (4)
✔ Integration: health, session validation (4), chat (4), isolation, pagination, delete, DB, rate limit
✔ MCP parsing (5) + MCP DB persistence (3) - 無 MCP→[], 有 MCP→github_get_file_contents, 去重, 不重複寫入
25 pass, 0 fail, duration 5.0s
```

## 7. 尚未解決 P0/P1

- **P1 Windows 真實 opencode**：`spawn('powershell.exe')` 雖平台分流，但在 Node 內 `opencode run --attach` 仍偶發 30s timeout (直接 `opencode` via bash 則 2s 通)，生產 Linux 無此問題，Windows 建議保持 `MOCK_OPENCODE=true` 開發 (已在 README 註明，Linux/Render 為 production target)
- **P0 無**：`mcp_tools` 已完善並測試，`mcp` 缺 credentials 不 crash 已驗證

## 8. 執行紀錄

- 2026-09-11 上午: Multi-Session/Neon/RateLimit 完成 (Phase 1-3)
- 2026-09-11 下午: 完整架構重構 + 推送 6d86219
- 2026-09-11 晚: Production readiness 驗證 (17 tests 全綠) + 重構推送 e0c7912 → 本次
