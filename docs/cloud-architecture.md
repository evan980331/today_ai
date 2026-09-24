# Today AI — Cloud Coding Agent 平台架構

> 產品名稱：**Today AI**（系統／平台名稱，維持不變）
> Agent 語音稱呼：**Stella**（未來語音互動時的稱呼，非正式產品更名）
> 靈感：星街彗星《Stellar Stellar》
> 定位：Today AI = Personal AI 系統／平台；Stella = 使用者語音稱呼的 Agent
> 架構：Today AI └─ Stella ─┬─ Agent Orchestrator／Memory／Scheduler／Coding Agent／Gmail／Calendar／未來 Tools
> 限制：現階段不將 UI／Repo／Domain／package 更名為 Stella，不新增語音功能；此為長期命名決策備忘，未來 Agent 架構需保留此區分。

> 目標：從「本機 Express → spawn OpenCode CLI 的 Bridge」重構成
> 「可部署到 Linux 雲端、可從手機操作的 Coding Agent 平台」。

## 目標架構

```
Mobile (HTTPS)
 ↓
Cloudflare Tunnel
 ↓
Today AI API (Express, Render / 127.0.0.1:3001)
 ↓
Session (agent_sessions: created → running → completed/failed/cancelled)
 ↓
Workspace (/workspace/<id>, WORKSPACE_ROOT 驅動)
 ↓
Agent Worker → OpenCode Server (外部, OPENCODE_SERVER_URL)
 ↓ SSE (session.started / text.delta / tool.* / message.completed)
Today AI SSE → Browser (POST /api/chat/stream)
 ↓
GitHub (workspace-scoped git, execFile, 無 shell 拼接)
 ↓
Vercel (部署目標, 未來)
```

## 關鍵設計決策

### 1. OpenCode Runtime 三態 (P0-1)

`getRuntimeMode()` 回傳：

| Mode | 條件 | 行為 |
|------|------|------|
| `mock` | `MOCK_OPENCODE=true` + 非 production | 秒回假資料，僅 dev/test |
| `local-cli` | 非 production，無 `OPENCODE_SERVER_URL` | `spawn opencode`（含 `--format json` 結構化事件） |
| `remote-server` | `OPENCODE_SERVER_URL` 已設定 | 優先 attach；production 下失聯 → 明確 `503 RUNTIME_UNAVAILABLE` |
| `unavailable` | production 無可用 runtime | 所有執行明確拒絕，**絕不假裝成功** |

production 遇到 `MOCK_OPENCODE=true`：`validateEnv()` 直接啟動失敗，
`run()`/`runStream()` 丟 `MOCK_FORBIDDEN`。Mock 永遠不得掩蓋 production 問題。

### 2. Render 不能跑 OpenCode (已確認 P0)

`render.yaml` 的 `startCommand` 只有 `npm start`，沒有任何 process 會啟動
OpenCode Server。舊設定 `OPENCODE_SERVER_URL=http://localhost:4096` 是**錯誤假設**，
已移除。Production 架構必須是：

```
Today AI API (Render) → 外部 Agent Worker / OpenCode Server
```

`OPENCODE_SERVER_URL`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_SERVER_PASSWORD`
為選填（未設時 API 照常啟動，chat/stream 明確回 503）。Password 絕不進 repo。

Render 本身不適合作為 OpenCode runtime（無官方 npm 安裝方式，
binary 未驗證能在 build container 可靠安裝），故不把 binary 硬塞進
`package.json`，本輪不做脆弱 workaround。

### 3. Workspace 隔離 (P0-2)

- `WORKSPACE_ROOT` 環境變數驅動（production 必填，如 `/workspace`；
  Windows local 預設 `./.workspaces`），程式零硬編碼。
- 每個 workspace 有唯一 ID（`[a-zA-Z0-9._-]`），`getWorkspacePath()` 保證
  不逃逸 root，`resolveInWorkspace()` 保證子路徑不逃逸 workspace。
- Agent 永遠不在 Today AI 自己的 repo root 執行（舊 `PROJECT_ROOT` 模式僅
  留作 local-cli backward compat）。

### 4. Session 模型 (P0-3)

- `chat_logs` 完全保留（backward compatible）。
- 新增 `agent_sessions(id, owner, repository, branch, workspace_id, status,
  created_at, updated_at)`，status：`created/running/completed/failed/cancelled`。
- 目前無真正 user ID：`owner` = 已登入 username（cookie session），
  schema 已預留未來換成 user ID。

### 5. OpenCodeClient (P0-4)

`src/services/agentClient.js` 提供 `health/createSession/sendPrompt/
subscribeEvents/abortSession`。CLI transport 已完整實作（含 `--format json`
真實結構化事件，非 TUI 解析）。Server transport 目前只實作 `health()`；
其餘方法明確丟 `NOT_IMPLEMENTED`（官方 server endpoint 未確認——實測
server 全路由 401，路徑未列舉），**絕不假造 streaming**。

### 6. Streaming (P0-5)

`POST /api/chat/stream`（SSE，Cookie Auth，`POST /api/chat` 保留相容）：
Browser ← Today AI SSE ← OpenCode `--format json` events ← adapter 正規化
（`src/services/agentEvents.js`，raw schema 永不暴露給前端）。
History 只在完成時寫一次完整內容；中斷不寫 partial；client disconnect
觸發 AbortController 清理 child process。

事件粒度說明：`--format json` 的 `text` 是 **per-step 整塊**（非 token 級），
打字機效果需等待官方 token 級串流能力。

### 7. Git (P0-6)

`src/services/git.js`：全部 `execFile` + 參數陣列（無 shell 拼接），
URL 僅接受 `https://`／`git@` 形式，所有操作強制指定 workspace，
`readWorkspaceFile` 有 traversal 保護。本輪僅 abstraction，未接 OAuth。

## 目前完成

- [x] P0-1 Runtime 三態 + production 明確 503 + MOCK 禁令
- [x] P0-2 Workspace service + 隔離/traversal 測試
- [x] P0-3 `agent_sessions` migration + backward compat 測試
- [x] P0-4 OpenCodeClient（CLI 完整；server transport 已實作，見下）
- [x] P0-5 `/api/chat/stream` SSE + adapter + 前端增量顯示（fallback 保留）
- [x] P0-6 Git abstraction（execFile，無 shell）
- [x] P0-7 render.yaml／.env.example／validateEnv（移除 localhost:4096 假設）
- [x] P0-8 60+ 個新測試（見測試結果）

## 第六輪 P0.9（Remote stream 打通，SSE 合約不變）

- Worker 端新增 `POST /workers/:id/execute/stream`（SSE：`upstream` 轉發
  OpenCode raw event、`done {result,mcpTools}`、`error {message,status}`；
  同樣的 `X-Worker-Auth`、驗證、in-flight 409、中止接線）。
- `RemoteWorkerClient.executeStream()`（超時／Abort／畸形 frame 跳過／
  無 terminal 即失敗／狀態碼映射；secret 永不外洩）。
- Today AI `/api/chat/stream` 經同一 `useRemoteWorker()` 切換遠端分支，
  以既有 `normalizeServerEvent` 轉換——瀏覽器看到的平台事件與本機逐字相同，
  看不到 workerId／URL／secret。
- 清理保證：disconnect→abort 上游→destroy 遠端 worker（worker 端 DELETE
  亦先 abort 再清）；history 單次寫入維持。
- 修了一個真缺陷：`req.on('close')` 會在 request body 收完即觸發，
  不能當 disconnect 訊號；兩條 SSE route 一律改用
  `res.on('close') ＋ !writableEnded`。
- Cloud／Linux／Docker／手機 E2E：本機仍無環境，一律 SKIPPED（無 fake pass）。

## 第五輪 P0.8（Deployment Readiness：稽核＋半配置拒絕）

環境變數稽核（以 `validateEnv.js`＋`validateWorkerEnv.js` 實際行為為準）：

REQUIRED（Today AI API, production；缺一即 `exit(1)`）：
`DATABASE_URL`、`AUTH_USERNAME`、`AUTH_PASSWORD`、`ALLOWED_ORIGINS`
（禁 `*`、禁空、須 http(s) 開頭）、`WORKSPACE_ROOT`。

REQUIRED（Worker host, `workerServer.js`；缺即 `exit(1)`）：
`WORKER_SHARED_SECRET`。

OPTIONAL（Today AI API）：
`OPENCODE_SERVER_URL`（＋`OPENCODE_SERVER_USERNAME/PASSWORD`；未設則
production chat 明確 503）、`WORKER_URL`＋`WORKER_SHARED_SECRET`
（**必須成對**，半配置在 production 直接啟動失敗，dev 僅警告並走本機）、
`WORKSPACE_KEEP_ON_FAILURE`、`MAX_WORKERS`（強制）、
`MAX_WORKSPACE_SIZE_MB`（合約宣告，未強制）、`GITHUB_*`、`GOOGLE_*`、`PORT`。

OPTIONAL（Worker host）：`WORKER_HOST`（預設 127.0.0.1）、`WORKER_PORT`
（預設 4100）。

DEVELOPMENT ONLY：`MOCK_OPENCODE=true`（production 直接啟動失敗；
`run`/`runStream` 亦各別拒絕）。

Frontend 使用的 secret：**零**（全相對路徑＋HttpOnly cookie）。

Worker 對外部署形狀（P0.8-5，已實作＋文件化，未真機部署）：
`Internet → Worker API (HTTPS, X-Worker-Auth) → localhost OpenCode`；
OpenCode 永遠只聽 127.0.0.1，永不直接對外。

## 第四輪 P0.7（Remote Worker 合約＋部署基礎）

- `workerProvider.js`：`LocalProcessWorkerProvider`＋`executePrompt()`；
  `WORKER_URL`＋`WORKER_SHARED_SECRET` 同時存在時 `/api/chat` 改走遠端
  （stream 維持本機，P1）。
- `remoteWorker.js`：`RemoteWorkerClient`（超時／Abort／`WORKER_*` 錯誤碼，
  secret 永不外洩）。
- Worker 端 API（`routes/workers.js`＋`workerServer.js` 獨立 entry）：
  shared-secret（`timingSafeEqual`，fail-closed）、strict view、輸入全驗證、
  禁止呼叫方指定 cwd、單 worker 單執行（409）、`MAX_WORKERS` 強制、
  `MAX_WORKSPACE_SIZE_MB` 誠實標示未強制。
- `Dockerfile.worker`、`scripts/worker-smoke.sh`（bash -n 語法通過）、
  `.github/workflows/worker.yml`（補上 live-server 啟動步驟＋provider
  key 需求註記）皆已就緒；**Docker／Linux 真機在本機皆不可用**，以下誠實標示。
- Frontend 全相對路徑，無 hardcoded URL／worker 內網資訊（手機安全）。
- Multi-instance lock：仍單實例 in-memory（P1：DB conditional update）。

## 第三輪 P0.6（Worker 接入 route，單執行單 worker）

- `POST /api/chat` 與 `POST /api/chat/stream` 全程跑在 `withWorker()` 內
  （workspace → serve → prompt/stream → stop → cleanup），回應／SSE 格式零變更。
- Mock 模式走相同生命線（無真 process），故既有 mock 測試全部保持通過。
- 清理保證：`try/finally` 覆蓋 success／failure／abort／timeout／upstream
  錯誤／disconnect；`WORKSPACE_KEEP_ON_FAILURE=true` 可留檔除錯（預設清掉）。
- 並行：同 session 第二個執行回 409（`executionLock`，backend 強制）；
  不同 session 各自 worker 並行。
- 未新建 provider 抽象：`withWorker` 已足夠，route 不碰 `child_process`
 （`workerProvider.js` 留待 remote-queue 那輪）。
- 仍未做：外部 Worker 實際部署、GitHub OAuth、queue／Redis／K8s。

## 第二輪 P0（OpenCode Server 實接，opencode 1.18.30 已實測）

官方 Server API（`GET /doc` OpenAPI 3.1 + localhost 實測，非推測）：

| 能力 | Endpoint | 驗證結果 |
|------|----------|----------|
| health | `GET /`（Basic auth） | 無 auth → 401；有 auth → 200 |
| createSession | `POST /session {title?}` | 回 `{id: ses_..., slug, ...}`，實測通過 |
| sendPrompt | `POST /session/{id}/message {parts:[{type:'text',text}]}` | 阻塞至完成，回 `{info, parts}`，實測通過 |
| subscribeEvents | `GET /event`（SSE，全域流，`properties.sessionID` 過濾） | 實測事件序列：`server.connected → message.updated → message.part.updated → session.status(busy) → message.part.delta → session.idle` |
| abortSession | `POST /session/{id}/abort` | 回 `true`，實測通過；不存在的 session 也回 200 |
| 錯誤對應 | 401/403/404(`NotFoundError`)/409/429/5xx/斷線 | 各有獨立 code（`UPSTREAM_*`），password 永不外洩 |

增量事件格式（真 token 級）：`message.part.delta {sessionID, messageID,
partID, field, delta}`；另有 `message.part.updated`（part 快照，含
`part.type`）用於區分 text／reasoning／tool，推理與工具輸入永遠不會被
當成 AI 文字顯示。

- [x] Server transport 五方法＋timeout＋AbortSignal＋錯誤分類
- [x] Workspace cwd：CLI 執行 `cwd = workspace path`（A/B 隔離測試）；
  server transport 在 worker cwd 執行（`directory` 欄位實測會被忽略，
  真隔離需每 project 獨立 Worker——架構上已如此設計）
- [x] Runtime lifecycle：dev CLI fallback；production 無 URL → 503；
  production URL 失聯 → 503；production 永不 spawn／mock／假回應
- [x] Streaming 保證：單次 completed／failed（`finished` flag）、完成才寫
  一次 history、abort 不寫 error history、disconnect 取消 upstream、
  同 session 並行第二個執行回 409（`executionLock`，backend 強制）
- [x] Opt-in 真機整合測試（`OPENCODE_INTEGRATION_TEST=true`，無 server 時
  明確 SKIP）
- [ ] 外部 Agent Worker 實際部署（仍未做：Render 上依然無 runtime）

## 目前未完成

- [ ] 外部 Agent Worker 實際部署（Render 上仍無 runtime；連線合約與 Worker
  需求見 `.env.example`）
- [ ] GitHub clone／OAuth 接線（abstraction 已就緒）
- [ ] Workspace git 操作串入執行鏈（目錄＋agent row 已建立）
- [ ] Vercel 部署鏈
- [ ] 多實例部署的分散式 execution lock（目前單實例 in-memory；
  跨實例需以 `agent_sessions.status` 做條件更新，見 P1）

## 下一個 P0

1. 確認 OpenCode Server API（帶 `OPENCODE_SERVER_PASSWORD` auth 列舉 endpoint，
   補完 server transport 的 createSession/sendPrompt/subscribeEvents）。
2. 部署外部 Agent Worker（Render 私有服務或獨立 VM），`OPENCODE_SERVER_URL`
   指向它，驗證 production `/api/chat` 不再 503。
3. Stream 執行綁定 workspace：`runStream` 的 `cwd` 從 `PROJECT_ROOT` 改為
   workspace 目錄（需先有可用的 remote/local runtime）。

## 下一個 P1

1. GitHub OAuth + `cloneRepository` 接線（workspace preparation 完整鏈路）。
2. 前端：agent session 列表／狀態顯示、streaming 中止按鈕。
3. Workspace 生命週期：TTL cleanup cron、磁碟配額。
4. Vercel 部署觸發（從 workspace diff → preview deploy）。
