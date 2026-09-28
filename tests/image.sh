#!/usr/bin/env bash
# Container-level checks for the built image (docker required):
#   readiness is 503 until openfang is healthy, then 200; runs unprivileged;
#   a dashboard config change survives container recreation on the same volume;
#   SIGTERM stops the container within the grace period; weak credentials refuse to boot.
# Usage: tests/image.sh [image-tag]   (default openfang-railway:test)
set -euo pipefail

IMAGE="${1:-openfang-railway:test}"
NAME="of-image-test-$$"
VOL="of-image-vol-$$"
PORT="${IMAGE_TEST_PORT:-18080}"
PASSWORD="image-test-password-123"
API_KEY="image-test-api-key-456"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; docker logs "$NAME" 2>&1 | tail -40 >&2 || true; exit 1; }

run_container() {
  docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8080" -v "$VOL:/data" \
    -e ADMIN_PASSWORD="$PASSWORD" -e OPENFANG_API_KEY="$API_KEY" "$@" "$IMAGE" >/dev/null
}

healthz() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/_gate/healthz" || true; }

wait_ready() {
  for _ in $(seq 1 120); do
    [ "$(healthz)" = "200" ] && return 0
    sleep 0.5
  done
  return 1
}

say "image metadata"
docker image inspect "$IMAGE" --format 'entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}} user={{.Config.User}} workdir={{.Config.WorkingDir}}'
docker run --rm --entrypoint openfang "$IMAGE" --version
docker run --rm --entrypoint sh "$IMAGE" -c 'node --version; python3 --version; pip3 --version | cut -d" " -f1-2; npm --version; ls /etc/ssl/certs/ca-certificates.crt; id openfang'

say "weak credentials refuse to boot"
weak_out="$(docker run --rm -e ADMIN_PASSWORD=short -e OPENFANG_API_KEY=x "$IMAGE" 2>&1)" && { echo "FAIL: weak password accepted (exit 0)" >&2; exit 1; }
echo "$weak_out" | grep -q "ADMIN_PASSWORD must be set" || { echo "FAIL: unexpected output: $weak_out" >&2; exit 1; }

say "first boot: readiness is 503 until openfang is healthy"
docker volume create "$VOL" >/dev/null
run_container
first="$(healthz)"
codes="$first"
while [ "$(healthz)" != "200" ]; do codes="$codes $(healthz)"; sleep 0.2; [ "${#codes}" -gt 2000 ] && fail "never became ready"; done
echo "healthz sequence: $codes"
case "$codes" in *503*) ;; *) echo "note: gate became ready before the first sample";; esac
wait_ready || fail "not ready"
body="$(curl -s "http://127.0.0.1:${PORT}/_gate/healthz")"
[ "$body" = '{"ok":true}' ] || fail "unexpected healthz body: $body"

say "runs unprivileged, volume owned by openfang"
procs="$(docker exec "$NAME" sh -c 'for p in /proc/[0-9]*; do printf "%s %s\n" "$(stat -c %U "$p")" "$(tr "\0" " " < "$p/cmdline" | cut -c1-60)"; done')"
echo "$procs"
docker exec "$NAME" sh -c 'stat -c "%U:%G %a %n" /data /data/config.toml'
[ "$(docker exec "$NAME" stat -c %U /data/config.toml)" = "openfang" ] || fail "config.toml not owned by openfang"
echo "$procs" | grep -q '^openfang .*openfang start' || fail "openfang not running as openfang"
echo "$procs" | grep -q '^openfang node /app/gate/server.js' || fail "gate not running as openfang"
echo "$procs" | grep '^root' | grep -v 'tini' | grep -qv 'sh -c for p in /proc' && fail "unexpected root process"

say "auth is enforced end to end"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health")" = "401" ] || fail "unauthenticated /api/health not 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:${PORT}/api/health")" = "200" ] || fail "bearer /api/health not 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer nope" "http://127.0.0.1:${PORT}/api/health")" = "401" ] || fail "bad bearer not 401"

say "dashboard change persists across container recreation"
curl -s -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"path":"default_model.provider","value":"openai"}' "http://127.0.0.1:${PORT}/api/config/set" >/dev/null
curl -s -H "Authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  -d '{"path":"default_model.model","value":"gpt-4o-mini"}' "http://127.0.0.1:${PORT}/api/config/set" >/dev/null
sleep 1
docker exec "$NAME" grep -q 'model = "gpt-4o-mini"' /data/config.toml || fail "config.toml not updated by /api/config/set"

say "graceful stop (SIGTERM) timing"
start=$(date +%s%N)
docker stop -t 30 "$NAME" >/dev/null
end=$(date +%s%N)
echo "stop took $(( (end - start) / 1000000 )) ms"
exit_code="$(docker inspect "$NAME" --format '{{.State.ExitCode}}')"
echo "container exit code: $exit_code"
[ "$exit_code" = "0" ] || [ "$exit_code" = "143" ] || fail "unexpected exit code $exit_code"
docker logs "$NAME" 2>&1 | grep -q "stopping openfang (SIGTERM)" || fail "gate did not forward SIGTERM to openfang"
docker rm "$NAME" >/dev/null

run_container -e OPENFANG_DEFAULT_PROVIDER=anthropic -e OPENFANG_DEFAULT_MODEL=claude-sonnet-4-20250514
wait_ready || fail "not ready after recreate"
cfg="$(curl -s -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:${PORT}/api/config")"
echo "$cfg"
echo "$cfg" | grep -q '"model":"gpt-4o-mini"' || fail "model change lost on recreate"
echo "$cfg" | grep -q '"provider":"openai"' || fail "provider change lost on recreate"
docker logs "$NAME" 2>&1 | grep -q "existing /data/config.toml" && fail "second boot re-adopted config (state.json lost?)"
docker logs "$NAME" 2>&1 | grep -q "seeded /data/config.toml" && fail "second boot re-seeded config"

say "secrets are not in logs"
docker logs "$NAME" 2>&1 | grep -q "$API_KEY" && fail "API key in logs"
docker logs "$NAME" 2>&1 | grep -q "$PASSWORD" && fail "admin password in logs"

say "resource footprint (idle)"
docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}}' "$NAME"
docker image inspect "$IMAGE" --format 'image size: {{.Size}} bytes'

printf '\nIMAGE TESTS PASSED\n'
