# Deployment Checklist (P1.0)

> Nothing here has been executed against real infrastructure from this host.
> Every unchecked box needs a human with credentials. Variable names follow
> source code exactly — notably the secret is `WORKER_SHARED_SECRET`
> (not `WORKER_SECRET`).

## A. Today AI API deployment

- [ ] `NODE_ENV=production`
- [ ] `DATABASE_URL` (Neon Postgres)
- [ ] `AUTH_USERNAME`, `AUTH_PASSWORD` (no defaults, never committed)
- [ ] `ALLOWED_ORIGINS=https://<today-ai-domain>` (no `*`, http(s) scheme)
- [ ] `WORKSPACE_ROOT=/workspace` (or equivalent persistent path)
- [ ] Remote worker pair: `WORKER_URL=https://<worker-host>` **and**
      `WORKER_SHARED_SECRET=<secret>` — both or neither; half-configured
      production refuses to start (no silent fallback)
- [ ] `MOCK_OPENCODE` **unset** (production start fails if `true`)
- [ ] Optional: `OPENCODE_SERVER_URL` (+ Basic user/pass) only if pointing
      at a real OpenCode Server; otherwise chat returns explicit 503
- [ ] `GET https://<today-ai-domain>/api/health` → `{"status":"ok",...}`
- [ ] No secret in logs, responses, or repo (grep before deploy)

## B. Agent Worker deployment (Linux host / container)

- [ ] Linux host with Node.js 20+, git, OpenCode CLI ≥ 1.18
      (`npm install -g opencode-ai && opencode --version` must succeed)
- [ ] Docker optional — image builds from `Dockerfile.worker`
      (`docker build -f Dockerfile.worker -t today-ai-worker .`)
- [ ] `WORKER_SHARED_SECRET=<secret>` (fail-closed when missing; generate
      per deployment, e.g. `openssl rand -hex 32`)
- [ ] `WORKER_HOST=127.0.0.1` (default; only override behind TLS + network policy)
- [ ] `WORKER_PORT=4100` (or chosen port; OpenCode workers get dynamic ports)
- [ ] `WORKSPACE_ROOT=/workspace` (persistent volume recommended)
- [ ] `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` only if the
      worker itself attaches to another OpenCode Server (local-spawn default
      needs neither)
- [ ] Start: `WORKER_SHARED_SECRET=... node src/workerServer.js`
- [ ] `GET /health` → `{"status":"ok","service":"agent-worker",...}` (no auth,
      no PID/port/paths/secrets in body)
- [ ] Authenticated probe: `POST /workers` with `X-Worker-Auth` → 201;
      without/wrong secret → 401
- [ ] OpenCode reachable ONLY via loopback on the worker host — never
      exposed to the internet (no `0.0.0.0:4096`, no port-forward to OpenCode)

## C. Test sequence (needs the two deployments above)

- [ ] `GET /health` on both services
- [ ] Authenticated worker request (`POST /workers` → 201 strict view)
- [ ] `POST /api/chat` through Today AI (small prompt, expect 200 + result)
- [ ] `POST /api/chat/stream` (expect `session.started` … `done` SSE)
- [ ] Abort mid-stream (expect `error: aborted`, worker destroyed, no orphan)
- [ ] Timeout path (short `WORKER_REQUEST_TIMEOUT_MS` against slow prompt)
- [ ] Workspace cleanup (workspace dir gone after success/failure/abort)
- [ ] Cloud E2E: `CLOUD_WORKER_INTEGRATION_TEST=true
      TODAY_AI_BASE_URL=... WORKER_URL=... WORKER_SHARED_SECRET=...
      E2E_USERNAME=... E2E_PASSWORD=... node --test test/integration-cloud-worker.test.js`
- [ ] Mobile E2E: phone browser → Today AI HTTPS URL → login → session →
      `Create a file named mobile-e2e.txt containing exactly MOBILE_E2E_OK.`
      → SSE `completed` → refresh → history intact → abort once → cleanup;
      phone must never see Worker/OpenCode URLs, passwords, or paths

## Deployment commands (templates — fill vars, never commit filled values)

```bash
# --- Agent Worker host (Linux) ---
export WORKER_SHARED_SECRET="$(openssl rand -hex 32)"
export WORKSPACE_ROOT=/workspace
export WORKER_HOST=127.0.0.1
export WORKER_PORT=4100
node src/workerServer.js
# health: curl http://127.0.0.1:4100/health

# --- Today AI API host (Linux / Render) ---
export NODE_ENV=production
export DATABASE_URL='postgresql://...'
export AUTH_USERNAME='...'
export AUTH_PASSWORD='...'
export ALLOWED_ORIGINS='https://today.example.com'
export WORKSPACE_ROOT=/tmp/today-ai-workspaces
export WORKER_URL='https://worker.example.com'
export WORKER_SHARED_SECRET='<same secret as worker host>'
npm start
# health: curl https://today.example.com/api/health
```

`OPENCODE_SERVER_URL` lives only on backend/worker hosts — never in
frontend code, env, or responses.
