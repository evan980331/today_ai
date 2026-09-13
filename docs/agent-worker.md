# Agent Worker Prototype (P0.5, single-host)

> One active execution = one isolated workspace + one dedicated OpenCode
> Server. No shared-server multi-tenancy: verified on opencode 1.18.30 that
> `POST /session` ignores `directory`, and `serve --port 0` is ignored
> (always binds 4096). Isolation boundary = server process `cwd` + dynamic
> port + per-worker Basic Auth secret.

## Lifecycle

```
createWorker()   workspace + record            -> creating
startWorker()    spawn `opencode serve --hostname 127.0.0.1 --port <dyn>`
                 with cwd = workspacePath       -> starting
waitForReady()   health poll <= WORKER_START_TIMEOUT_MS (def. 30s)
                 exit/timeout/health-fail       -> failed (process reaped)
                 ok                             -> ready
markRunning()    execution starts               -> running
markIdle()       execution done                 -> ready
stopWorker()     SIGTERM -> (gracefulMs) -> SIGKILL fallback
                 scrub password, unregister     -> stopped
cleanupWorker()  stop + remove workspace dir
```

`withWorker(opts, fn)` runs the whole arc (create→start→run→stop→cleanup)
with `AGENT_EXECUTION_TIMEOUT_MS` (def. 10 min) racing `fn` — a function
that ignores AbortSignal still gets reaped via worker shutdown.

## Session abort vs worker shutdown (separate lifecycles)

- Session abort (`AbortController` / `POST /session/{id}/abort`) stops the
  current turn only. The worker stays `ready` for reuse.
- Worker shutdown happens only on lifecycle completion (or timeout/crash).
  Never kill the process while OpenCode may still be writing files: SIGTERM
  first, SIGKILL only after `gracefulMs`.

## Authentication

- Per worker: `username = worker`, `password = crypto.randomBytes(24).hex`.
- Secret travels only in the child's `OPENCODE_SERVER_PASSWORD` env + module
  memory. Never database, logs, frontend, git, or error strings
  (`publicView()` excludes password + process handle; shutdown scrubs it).
- `OpenCodeClient` is built via `workerClient(worker)` — routes never
  hand-assemble URLs or credentials.
- The child inherits the server env (it needs MCP tokens such as
  `GITHUB_PERSONAL_ACCESS_TOKEN` for its own MCP servers). This also exposes
  server-side secrets to the local worker process — accepted for the
  single-host prototype (same trust boundary, localhost only); a future
  remote-worker provider must switch to an env allowlist.

## Dynamic ports

`allocatePort()` (OS bind-0) per worker, e.g. A→4101, B→4102. No fixed pool,
no `4096` default. Residual bind-then-spawn TOCTOU is accepted for the
single-host prototype (sequential binds, millisecond window).

## Crash recovery

- Process `exit` during starting/ready/running → status `failed` with
  `lastError` (truncated, no secrets), awaiting `startWorker` rejects
  (`WORKER_EXITED` / `WORKER_START_TIMEOUT`), process reaped (no zombies).
- Callers translate to session `failed` + explicit error event (never fake).

## Concurrency model

- Same Today AI session: `executionLock` → second execution gets 409
  (backend-enforced).
- Different sessions: different workers → fully parallel, different ports,
  different cwds (tested A/B).
- This lock is single-instance. Multi-instance deployments need a
  DB-conditional update on `agent_sessions.status` (P1, not this round).

## Docker prototype

`Dockerfile.worker` (node:20-slim + git + `npm i -g opencode-ai`,
`WORKSPACE_ROOT=/workspace`, no baked secrets) proves the toolchain
installs on Linux. **Not build-verified here** (no Docker on Windows dev
host) and not orchestrated — no Compose/K8s/queue/Redis this round.

## Remote worker (P0.7)

Same lifecycle, different transport. Today AI routes never learn PIDs or
paths; they only know the provider interface (`create/execute/abort/destroy`):

- `src/services/workerProvider.js` — `LocalProcessWorkerProvider`
  (single-host `withWorker`) + `executePrompt()` router entry, which
  switches to remote when `WORKER_URL` + `WORKER_SHARED_SECRET` are both
  set. `/api/chat` uses it; `/api/chat/stream` stays local this round (P1).
- `src/services/remoteWorker.js` — `RemoteWorkerClient` (create/get/
  execute/abort/destroy over HTTP, `X-Worker-Auth` header, per-call
  timeouts, distinct `WORKER_*` error codes, secret never in messages).
- `src/routes/workers.js` + `src/workerServer.js` — the worker-side API
  (`POST /workers`, `GET /workers/:id`, `POST /workers/:id/execute`,
  `POST /workers/:id/abort`, `DELETE /workers/:id`). Auth is a shared
  secret compared with `timingSafeEqual` (fail-closed when unconfigured).
  Strict views only (`workerId/workspaceId/status`/timestamps/`lastError`).
  All untrusted fields validated; `cwd`/`port`/`command`/`args`/`env` are
  rejected outright — the worker resolves paths from `workspaceId` itself.
  One execution per worker (second concurrent execute → 409).
- `MAX_WORKERS` enforced at create; `MAX_WORKSPACE_SIZE_MB` is
  contract-only for now (honestly marked unenforced in `getWorkerLimits()`).

## Single-host scope (deliberate)

Today AI API and workers run on one Linux machine / container for now, but
`agentWorker.js` never assumes co-location beyond `spawn`: the future path
is `Render API → queue → worker VM/container` running the same
create/start/health/stop contract over HTTP. No Express coupling inside the
service (injectable `spawnFn`, pure port allocator).

## Environment knobs

| Variable | Default | Meaning |
|---|---|---|
| `WORKSPACE_ROOT` | `./.workspaces` (dev) / tmp (prod) | workspace parent dir |
| `WORKER_START_TIMEOUT_MS` | 30000 | server ready deadline |
| `AGENT_EXECUTION_TIMEOUT_MS` | 600000 | per-execution deadline |

## Test map

- `test/worker.test.js` (12 unit tests, fake processes): creation, ports,
  startup, health, auth, cwd isolation, crash, timeouts, graceful/force kill,
  cleanup, A/B concurrency, abort/worker split.
- `test/integration-worker.test.js` (opt-in `OPENCODE_WORKER_INTEGRATION_TEST=true`,
  explicit SKIP otherwise): real workspace → real `opencode serve` → health →
  session → prompt creates `worker-test.txt = WORKER_OK` → SSE → stop →
  process gone + workspace removed.

## Known environment constraint (Windows tool host)

Spawning a long-lived `opencode serve` as a child of this Windows shell
terminates the shell session (verified minimal repro; mechanism unconfirmed).
Consequences: the real integration test cannot execute on THIS host — it is
written for Linux/Docker CI. All logic is covered by the fake-process unit
tests here. Do not attempt `opencode serve` spawn trials from the assistant
shell on Windows.
