# Changelog

All notable changes to this template. Versions follow semver for the template itself; the
pinned OpenFang release is listed separately because it is the thing most deployers care about.

| Template | OpenFang | Config schema |
| --- | --- | --- |
| 1.0.0 | 0.6.9 | 1 |

## 1.0.0 — unreleased

First release.

- Pinned OpenFang `v0.6.9` (`openfang-x86_64-unknown-linux-gnu.tar.gz`, SHA-256
  `4309b0bcf2adc5dac45776e2008087a8ad072933f1ae698ff8d4e06fb6b87602`) on a digest-pinned
  `node:22-bookworm-slim` base with Python 3, pip, venv, Node 22, npm and CA certificates.
- Readiness gate on the public port: `/_gate/healthz` is `200` only while the daemon process is
  alive and `/api/health` succeeded within `GATE_PROBE_STALE_MS`.
- Daemon supervisor: restart with exponential backoff, SIGTERM/SIGKILL shutdown within
  `GATE_SHUTDOWN_GRACE_MS`, spawn failures (missing binary) surfaced as not-ready.
- Persistence: `config.toml` is seeded once on an empty volume and never rewritten; existing
  files are adopted and backed up; config schema `1` recorded in
  `/data/.openfang-railway/state.json`; unparsable config blocks startup without being reset.
- Authentication: admin password login (HMAC-signed HttpOnly cookie, rate limited, same-origin
  checks) and API key (bearer / `X-API-Key` / `?token=`) in front of HTTP, SSE and WebSocket
  routes; `?token=` is stripped before proxying; gate-only variables are withheld from the daemon;
  logs and status output are redacted.
- Admin pages: `/_gate/status` and `/_gate/config` (validated, backed-up, atomic replace).
- Runs as unprivileged `openfang` (uid 10001) under `tini`.
- Railway Infrastructure as Code (`.railway/railway.ts`): service, `/data` volume, healthcheck,
  restart policy and generated `ADMIN_PASSWORD` / `OPENFANG_API_KEY`. Railway's `railway.json`
  config-as-code is deprecated and not shipped.
- Tests: behaviour suite against a fake daemon, integration suite against the real binary,
  container-level suite against the built image; all wired into GitHub Actions.

### Migration notes

- From the anonymous marketplace template (`nazihkalo/openfang-railway`): attach the same volume
  at `/data`. Its `config.toml` (with `include = ["config.user.toml"]`) is adopted as-is and
  backed up on first boot. Rename `SETUP_PASSWORD` to `ADMIN_PASSWORD` (12+ characters).
  `OPENFANG_API_KEY` keeps its meaning. `/setup` no longer exists; use `/_gate/login`.
