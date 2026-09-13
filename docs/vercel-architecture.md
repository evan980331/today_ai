# Vercel-first Architecture

> **Vercel is not an OpenCode runtime.** Vercel runs Web + API +
> authentication + orchestration + tool integrations + task metadata +
> streaming endpoints. Anything needing a process, a filesystem, git, or a
> long-lived connection runs on a Remote Runtime (Remote Worker host today,
> other runtimes tomorrow).

```
Browser
   ↓ HTTPS
Vercel / Today AI  (stateless: UI, API, auth, orchestration)
   ↓
Agent Orchestrator
   ├── Tools  (run IN Vercel: Gmail / GitHub / Calendar — direct API calls)
   │
   └── WorkerProvider → Agent Runtime
          ↓ HTTPS + X-Worker-Auth
      Remote Worker host (or future runtime)
          ↓ localhost
       OpenCode (or future agent engine)
```

## Boundary rules (enforced by `npm run build`)

1. `src/routes/`, `src/app.js`, `src/server.js`, `src/middleware/`,
   `src/services/agentOrchestrator.js`, `src/services/tools/` and
   `src/services/opencodeRuntime.js` never call `spawn`/`exec`/`execFile`.
   Process execution lives only in `services/opencode.js`,
   `services/agentWorker.js`, `services/agentClient.js` (health probe) and
   `services/git.js` — all reachable solely through the runtime/provider
   layer, never directly from routes.
2. Routes and `public/` never hardcode `localhost`, `127.0.0.1` or `:4096`.
   The browser only ever talks to relative `/api/...` paths.
3. Secrets (`WORKER_SHARED_SECRET`, provider keys, OAuth tokens) never
   leave the backend: not in responses, SSE events, logs, or the frontend.

## Where each piece runs

| Piece | Vercel (stateless) | Remote Runtime |
|---|---|---|
| Web UI + login/session cookies | ✅ | — |
| `/api/chat`, `/api/chat/stream` framing | ✅ | — |
| History / sessions / tasks metadata (Neon) | ✅ | — |
| Gmail / GitHub / Calendar API calls | ✅ (direct, no worker needed) | — |
| Tool registry + orchestration decisions | ✅ | — |
| OpenCode execution (CLI or server) | — | ✅ |
| git / filesystem / workspace | — | ✅ |
| Long coding tasks (minutes+) | — | ✅ |
| `opencode serve` lifecycle | — | ✅ |

## Why OpenCode is not on Vercel

Serverless functions have hard execution-time limits, ephemeral read-only
filesystems (outside `/tmp`), and no process supervision. OpenCode needs
minutes-long runs, a persistent workspace with git, and MCP child processes.
Forcing it into a function would break timeouts, lose workspaces, and orphan
processes — so it stays behind the runtime interface instead.

## Runtime contract (all runtimes implement it)

```text
Agent Runtime
├── execute({ prompt, workspaceId, ... }) -> { result, mcpTools }
├── executeStream({ ..., onEvent })       -> { result, mcpTools }
│       onEvent receives NORMALIZED platform events only
├── abort(target)                        -> { ok }
└── health()                             -> { available, ... }
```

`opencodeRuntime` is the current (and only) implementation. Swapping in
another engine means adding one module + `registerRuntime()` — no route,
frontend, orchestrator, or tool changes. The browser cannot tell runtimes
apart: SSE event names and REST shapes are runtime-agnostic by contract.

## Environment checklist (see `.env.example` for values)

Today AI required: `DATABASE_URL`, `AUTH_USERNAME`, `AUTH_PASSWORD`,
`ALLOWED_ORIGINS`, `WORKSPACE_ROOT`.
Remote Worker optional: `WORKER_URL`, `WORKER_SHARED_SECRET`,
`WORKER_REQUEST_TIMEOUT_MS`.
Worker host: `WORKER_SHARED_SECRET`, `WORKER_HOST`, `WORKER_PORT`,
`WORKSPACE_ROOT`.
No real secrets are committed anywhere; names above are stable contracts.

## Status (honest)

- [x] Orchestrator + tools registry + runtime adapter + Vercel boundary gate
- [x] Remote Worker path verified (fixture + opt-in live tests)
- [ ] Actual Vercel deployment (needs project + env wiring by a human)
- [ ] Gmail / GitHub / Calendar tool implementations (interfaces only)
- [ ] Long-task persistence (task store is in-memory; needs DB before queue)
