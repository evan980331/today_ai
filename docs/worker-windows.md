# Windows Laptop Worker — Cloudflare Tunnel 部署

目標：`Vercel (API) → Cloudflare Tunnel → Windows 筆電 Worker → OpenCode → Local Workspace`

- Vercel **不** spawn OpenCode，缺 `WORKER_URL` 即 `503 RUNTIME_UNAVAILABLE`
- OpenCode 只在筆電 Worker 跑，`4096` 不暴露到 Internet
- Worker 只綁 `127.0.0.1`，對外由 Tunnel 提供 `https://<worker-domain>`

## 1. 安裝 Node.js (Windows)

下載 LTS https://nodejs.org/，安裝後確認：

```powershell
node -v
npm -v
```

## 2. 安裝 OpenCode

```powershell
npm i -g opencode  # 或依官方安裝指引
opencode --version
```
若 `opencode` 不在 PATH，記下完整路徑供 `OPENCODE_PATH` 使用（例如 `C:\tools\opencode.exe`），**不要**把該路徑寫死進 repo。

## 3. 設定 WORKSPACE_ROOT

```powershell
# 建議 D:\todayai-workspaces
$env:WORKSPACE_ROOT="D:\todayai-workspaces"
# 或寫入 .env / 系統環境變數，確保每 workspace/session 隔離
```

## 4. 設定 WORKER_SHARED_SECRET

產生隨機字串（勿提交到 git）：

```powershell
# PowerShell 產生 32 字節 hex
-join ((1..32) | ForEach-Object { "{0:X2}" -f (Get-Random -Maximum 256) })
# 設定環境變數
$env:WORKER_SHARED_SECRET="<你的-secret>"
```
此值 **必須** 與 Vercel 的 `WORKER_SHARED_SECRET` 相同。

選填：
```powershell
$env:OPENCODE_PATH="C:\tools\opencode.exe"  # 僅當 PATH 找不到 opencode 時
$env:WORKER_HOST="127.0.0.1"
$env:WORKER_PORT="4100"
```

## 5. 啟動 Worker Server

```powershell
cd D:\自製todayai
$env:WORKER_SHARED_SECRET="<你的-secret>"
$env:WORKSPACE_ROOT="D:\todayai-workspaces"
# 選填 $env:OPENCODE_PATH
node src/workerServer.js
# 預期：[Worker] listening on http://127.0.0.1:4100
```

保持此視窗開啟，Worker 會長時間常駐。

## 6. 本機測試 /health

新開 PowerShell：

```powershell
curl http://127.0.0.1:4100/health
# 預期：{"status":"ok","service":"agent-worker",...}
```

需帶 secret 的健康檢查（Vercel 會帶）：

```powershell
curl -H "X-Worker-Auth: <你的-secret>" http://127.0.0.1:4100/health
```

## 7. 安裝 cloudflared

下載 https://developers.cloudflare.com/cloudflare-one/connections/connect/networks/downloads/ 安裝後：

```powershell
cloudflared --version
cloudflared login   # 依指示授權，選擇你的 Cloudflare 域名
```

## 8. 建立 Tunnel

```powershell
cloudflared tunnel create todayai-worker
cloudflared tunnel list
```

## 9. 將 Tunnel 指向 localhost Worker

建立 `C:\Users\<你>\.cloudflared\config.yml`：

```yaml
tunnel: todayai-worker
credentials-file: C:\Users\<你>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: worker.example.com   # 換成你的子域名
    service: http://127.0.0.1:4100
  - service: http_status:404
```

設定 DNS：

```powershell
cloudflared tunnel route dns todayai-worker worker.example.com
```

啟動 Tunnel：

```powershell
cloudflared tunnel run todayai-worker
# 預期：tunnel 顯示已連線，https://worker.example.com 可對外訪問
```

也可設為 Windows 服務常駐。

## 10. 將產生的 HTTPS URL 設成 Vercel WORKER_URL

`https://worker.example.com` 即為 `WORKER_URL`。

## 11. Vercel 設定相同的 WORKER_SHARED_SECRET

Vercel Dashboard → Project → Settings → Environment Variables：

```
WORKER_URL=https://worker.example.com
WORKER_SHARED_SECRET=<同一-secret>
DATABASE_URL=postgresql://...
ALLOWED_ORIGINS=https://today-ai-sigma.vercel.app
```

兩者 **皆** 需設定，缺一即 `503 Remote Worker misconfigured`。

## 12. Redeploy

Vercel → Deployments → Redeploy 最新 commit（或 `git push` 觸發）。

## 13. 測試 /api/chat

```powershell
# 先登入取得 cookie，再打
curl -X POST https://<vercel-domain>/api/chat -H "Content-Type: application/json" -b "todayai_session=..." -d '{"prompt":"hello"}'
# 預期：经 Tunnel → 筆電 Worker → OpenCode → 回傳 result
```

或直接在手機瀏覽器使用線上站台。

> 安全提醒：Worker 只綁 `127.0.0.1`，不要用 `0.0.0.0` 對外；不要暴露 `opencode serve` 的 `4096`；`WORKER_SHARED_SECRET` 用 `timingSafeEqual` 比對，不印 log、不回 response、不入 history。
