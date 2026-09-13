#!/usr/bin/env bash
# P0.6-8: Agent Worker smoke test for Linux.
# Verifies node, git, opencode, then drives one full worker lifecycle
# against a temporary workspace. Exits non-zero on ANY failure.
set -euo pipefail

PORT=${SMOKE_PORT:-0}
if [ "$PORT" = "0" ]; then
  PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")
fi
URL="http://127.0.0.1:${PORT}"
AUTH_USER="worker"
AUTH_PASS="smoke-$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/today-ai-smoke-XXXXXX")"

echo "[smoke] node: $(node --version)"
echo "[smoke] git: $(git --version)"
echo "[smoke] opencode: $(opencode --version)"
echo "[smoke] workspace: ${WORKDIR}"
echo "[smoke] url: ${URL}"

cleanup() {
  echo "[smoke] stopping worker..."
  kill "${SERVE_PID:-}" 2>/dev/null || true
  sleep 1
  kill -9 "${SERVE_PID:-}" 2>/dev/null || true
  rm -rf "${WORKDIR}"
  echo "[smoke] workspace cleaned"
}
trap cleanup EXIT

echo "[smoke] starting opencode serve (cwd=workspace)..."
cd "${WORKDIR}"
OPENCODE_SERVER_PASSWORD="${AUTH_PASS}" \
  opencode serve --hostname 127.0.0.1 --port "${PORT}" >/tmp/today-ai-smoke-serve.log 2>&1 &
SERVE_PID=$!

echo "[smoke] waiting for health (30s)..."
for i in $(seq 1 60); do
  if curl -sf -u "${AUTH_USER}:${AUTH_PASS}" "${URL}/" >/dev/null 2>&1; then
    echo "[smoke] health OK after ~$((i / 2))s"
    break
  fi
  if ! kill -0 "${SERVE_PID}" 2>/dev/null; then
    echo "[smoke] FAIL: serve process exited early" >&2
    cat /tmp/today-ai-smoke-serve.log >&2 || true
    exit 1
  fi
  if [ "$i" = "60" ]; then
    echo "[smoke] FAIL: health timeout" >&2
    exit 1
  fi
  sleep 0.5
done

echo "[smoke] creating session..."
SESSION_JSON=$(curl -sf -u "${AUTH_USER}:${AUTH_PASS}" -H 'Content-Type: application/json' \
  -d '{"title":"smoke"}' "${URL}/session")
SESSION_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)" <<<"${SESSION_JSON}")
if [ -z "${SESSION_ID}" ] || [ "${SESSION_ID}" = "undefined" ]; then
  echo "[smoke] FAIL: no session id" >&2
  exit 1
fi
echo "[smoke] session: ${SESSION_ID}"

echo "[smoke] sending prompt..."
RESULT_JSON=$(curl -sf -u "${AUTH_USER}:${AUTH_PASS}" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"reply with exactly: SMOKE_OK"}]}' \
  --max-time 170 "${URL}/session/${SESSION_ID}/message")
RESULT_TEXT=$(node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log((o.parts||[]).filter(p=>p.type==='text').map(p=>p.text).join(''))" <<<"${RESULT_JSON}")
echo "[smoke] result: ${RESULT_TEXT}"
if [ "${RESULT_TEXT}" != "SMOKE_OK" ]; then
  echo "[smoke] FAIL: unexpected result" >&2
  exit 1
fi

echo "[smoke] aborting session..."
ABORT_OUT=$(curl -sf -u "${AUTH_USER}:${AUTH_PASS}" -X POST "${URL}/session/${SESSION_ID}/abort")
if [ "${ABORT_OUT}" != "true" ]; then
  echo "[smoke] FAIL: abort returned ${ABORT_OUT}" >&2
  exit 1
fi

echo "[smoke] SMOKE_OK"
