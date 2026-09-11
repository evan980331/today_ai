# Today AI - 手機遠端存取 (Cloudflare Tunnel)

> 透過 Cloudflare Tunnel 將本機 Today AI 安全暴露到網際網路，手機可直接存取。

## 前置需求

- Cloudflare 帳號（免費方案即可）
- Cloudflare Tunnel 已安裝（`cloudflared`）
- 本機 Express 運行在 `127.0.0.1:3001`

## 1. 啟動 Express

```powershell
cd D:\自製todayai
npm start
```

確認 Express 正常：
```powershell
curl http://127.0.0.1:3001/api/health
# 應回傳 {"status":"ok","mcp":"...","db":"connected",...}
```

## 2. 安裝 Cloudflare Tunnel

```powershell
# Windows (winget)
winget install cloudflare.cloudflared

# 或下載：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

## 3. 登入 Cloudflare

```powershell
cloudflared tunnel login
```

瀏覽器會開啟 Cloudflare 授權頁面，選擇你的網域。

## 4. 建立 Tunnel

```powershell
cloudflared tunnel create today-ai
```

記下 Tunnel ID（輸出中的 UUID）。

## 5. Tunnel 設定

在專案根目錄建立 `tunnel-config.yml`：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: C:\Users\<你的帳號>\.cloudflared\<TUNNEL_ID>.json

ingress:
  - hostname: today.yourdomain.com
    service: http://127.0.0.1:3001
  - service: http_status:404
```

**重要**：
- `service: http://127.0.0.1:3001` — 只轉發到 Express（localhost）
- **不要**指向 `http://127.0.0.1:4096`（OpenCode MCP Server，不得暴露到網際網路）
- 最後一條規則必須是 `http_status:404`（catch-all）
- 不要開啟 router port forwarding

## 6. 建立 DNS 記錄

```powershell
cloudflared tunnel route dns today-ai today.yourdomain.com
```

或到 Cloudflare Dashboard > DNS 手動新增 CNAME 指向 `<TUNNEL_ID>.cfargotunnel.com`。

## 7. 啟動 Tunnel

```powershell
cloudflared tunnel --config tunnel-config.yml run today-ai
```

保持此視窗運行。

## 8. 設定環境變數

在 `.env` 中設定（或用系統環境變數）：

```env
NODE_ENV=production
AUTH_USERNAME=你的帳號
AUTH_PASSWORD=你的密碼
ALLOWED_ORIGINS=https://today.yourdomain.com
```

**重要**：
- `ALLOWED_ORIGINS` 必須包含 Cloudflare Tunnel 的網域
- 多個網域用逗號分隔：`https://today.yourdomain.com,https://another.yourdomain.com`
- `AUTH_USERNAME` / `AUTH_PASSWORD` 不得寫入 Git

## 9. 手機瀏覽器登入

1. 開啟手機瀏覽器，前往 `https://today.yourdomain.com`
2. 輸入帳號密碼登入
3. 開始使用 Today AI

## 10. 停止 Tunnel

```powershell
# Ctrl+C 停止 cloudflared
```

## 安全注意事項

| 項目 | 說明 |
|------|------|
| **OpenCode 4096** | 絕對不要暴露到網際網路。Express 只在 localhost 被 tunnel 轉發。 |
| **Cookie** | HttpOnly、SameSite=Lax、Secure=true (production)。JavaScript 無法讀取 session token。 |
| **CORS** | `ALLOWED_ORIGINS` 只允許你的 Cloudflare 網域。不允許任意 Origin。 |
| **Rate Limit** | Login: 10次/15分鐘。Chat: 20次/分鐘。History: 100次/分鐘。 |
| **密碼** | 不得寫入 Git、source code、README、`.env.example`、console.log。 |
| **Tunnel credentials** | `~/.cloudflared/` 下的 JSON 檔案不得提交到 Git。 |

## 網路流程

```
手機瀏覽器
    ↓ HTTPS
Cloudflare Edge (CDN)
    ↓ Cloudflare Tunnel (加密)
cloudflared (本機)
    ↓ HTTP
Express (127.0.0.1:3001)
    ↓ 內部連線
OpenCode MCP Server (localhost:4096) [不對外暴露]
```

## 常見問題

### Tunnel 啟動失敗
- 確認 `credentials-file` 路徑正確
- 確認 `cloudflared tunnel login` 已完成授權

### Cookie 在手機上不工作
- 確認 `NODE_ENV=production`（啟用 Secure flag）
- 確認使用 HTTPS（Cloudflare Tunnel 自動提供）
- 確認 `ALLOWED_ORIGINS` 包含你的網域

### 登入後 API 仍回傳 401
- 確認 `AUTH_USERNAME` 和 `AUTH_PASSWORD` 已設定
- 確認 cookie 有正確傳遞（瀏覽器開發者工具 > Network）
