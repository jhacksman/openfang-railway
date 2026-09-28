# OpenFang on Railway

A production-minded Railway template for [OpenFang](https://github.com/RightNow-AI/openfang),
the open-source agent operating system.

- **Pinned upstream release.** Ships the unmodified OpenFang `v0.6.9` Linux binary, verified by
  SHA-256 at build time. It never builds from a moving `main` branch, so a redeploy gives you the
  same OpenFang you tested.
- **Honest readiness.** Railway's healthcheck (`/_gate/healthz`) only returns `200` when the
  OpenFang process is running *and* its own `/api/health` answered within the last 10 seconds.
  A missing binary, a crash loop, or a daemon that never listens keeps the deploy unhealthy instead
  of "green but broken".
- **Settings survive restarts.** `config.toml` lives on the Railway volume and is written **once**,
  on first boot. Provider/model/channel changes made in the OpenFang dashboard (or with
  `openfang config set`) are kept across restarts and redeploys. Every edit made through the
  template is backed up first and written atomically.
- **Everything behind authentication.** The OpenFang API, dashboard, SSE streams and WebSockets are
  only reachable with your API key or an admin session. Secrets are never placed in URLs, HTML,
  logs or status output.

Deploy on Railway: *the marketplace listing for this template has not been published yet; this
line will be replaced with the Deploy button once it is.* Until then you can deploy it as a plain
GitHub-repo service (see [Deploy without the template](#deploy-without-the-template)).

This project is **not affiliated with, endorsed by, or an official distribution of** OpenFang /
RightNow AI, or of Railway. See [Third-party notices](THIRD_PARTY_NOTICES.md).

## Contents

- [What gets deployed](#what-gets-deployed)
- [Required variables](#required-variables)
- [Optional variables](#optional-variables)
- [First run](#first-run)
- [How configuration and persistence work](#how-configuration-and-persistence-work)
- [Backup, restore and rollback](#backup-restore-and-rollback)
- [Resource assumptions](#resource-assumptions)
- [Comparison with the existing anonymous template](#comparison-with-the-existing-anonymous-template)
- [Compatibility](#compatibility)
- [Limitations](#limitations)
- [Deploy without the template](#deploy-without-the-template)
- [Local development and tests](#local-development-and-tests)
- [Support](#support)
- [License](#license)

## What gets deployed

One Railway service built from the `Dockerfile` in this repository, plus one volume mounted at
`/data`.

```
Railway edge (HTTPS, $PORT)
   │
   ▼
gate  (Node 22, no npm dependencies, runs as uid 10001)
   ├── /_gate/healthz           public, {"ok":true|false}, nothing else
   ├── /_gate/login|logout      admin password → HttpOnly session cookie
   ├── /_gate/status            authenticated: daemon state, recent (redacted) logs
   ├── /_gate/config            authenticated: view/replace config.toml (validated, backed up)
   └── /* (everything else)     authenticated reverse proxy → OpenFang
                                 HTTP, SSE and WebSocket
                                        │
                                        ▼
                         openfang start  (127.0.0.1:4200, loopback only)
                                 OPENFANG_HOME=/data  (volume)
```

The gate supervises the daemon (restart with backoff on exit, SIGTERM then SIGKILL on shutdown)
and is the only process listening on the public port. Both processes run as the unprivileged
`openfang` user; `tini` is PID 1.

## Required variables

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Password for the browser login at `/_gate/login`. At least 12 characters; the service refuses to start otherwise. Never passed to OpenFang. |
| `OPENFANG_API_KEY` | Bearer token for the OpenFang API (`Authorization: Bearer …`, `X-API-Key`, or `?token=` for browser SSE/WebSocket clients that cannot set headers). Also injected into the daemon so OpenFang enforces it on loopback. |
| One provider key | e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, … — whatever the model you pick needs. Set it as a Railway variable; the daemon reads it from the environment. Provider keys can also be entered in the OpenFang dashboard, in which case OpenFang stores them under `/data`. |

Generate strong values for the first two (Railway's `${{secret(32)}}` template function, or
`openssl rand -hex 32`). They are not printed anywhere.

## Optional variables

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENFANG_DEFAULT_PROVIDER` | `anthropic` | **Seed only** — used to write `config.toml` on the very first boot of an empty volume. Later changes do not rewrite an existing config; edit it in the dashboard or at `/_gate/config` instead. |
| `OPENFANG_DEFAULT_MODEL` | `claude-sonnet-4-20250514` | Seed only. |
| `OPENFANG_DEFAULT_API_KEY_ENV` | `ANTHROPIC_API_KEY` | Seed only. Name of the env var OpenFang reads the provider key from. |
| `OPENFANG_LOG_LEVEL` | `info` | Seed only. |
| `GATE_SESSION_TTL_HOURS` | `168` | Lifetime of the admin session cookie. |
| `GATE_SHUTDOWN_GRACE_MS` | `20000` | How long OpenFang gets after SIGTERM before SIGKILL. |
| `GATE_PROBE_INTERVAL_MS` / `GATE_PROBE_STALE_MS` | `2000` / `10000` | Health probe cadence and the maximum age of a successful probe for readiness to hold. |

Any other variable you set on the service is passed through to the OpenFang daemon unchanged
(that is how provider keys and OpenFang's own `OPENFANG_*` settings reach it). Only
`ADMIN_PASSWORD` and `GATE_SESSION_TTL_HOURS` are withheld from the daemon environment.

## First run

1. Deploy the service and make sure a volume is mounted at `/data`.
2. Set `ADMIN_PASSWORD`, `OPENFANG_API_KEY` and a provider key.
3. Wait for the deployment to become healthy. Railway waits for `/_gate/healthz` to return `200`
   (up to 300 s, see `railway.json`); OpenFang typically boots in a few seconds.
4. Open `https://<your-service>.up.railway.app/` — you are redirected to `/_gate/login`. Sign in
   with `ADMIN_PASSWORD`; you land in the native OpenFang dashboard.
5. Finish provider/model/channel/agent setup in OpenFang. Those changes are written to
   `/data/config.toml` and OpenFang's own data under `/data/data`, and survive restarts.

API clients use the same public URL with `Authorization: Bearer $OPENFANG_API_KEY`, e.g.

```sh
curl -H "Authorization: Bearer $OPENFANG_API_KEY" https://<your-service>.up.railway.app/api/health
```

`/_gate/status` (same credentials) shows whether the daemon is running, the last probe result,
restart count, config state and the last 60 log lines with secrets redacted.

## How configuration and persistence work

Persistent paths (all on the `/data` volume):

| Path | Owner | Contents |
| --- | --- | --- |
| `/data/config.toml` | OpenFang / you | The one configuration file. Seeded on first boot, never rewritten by the template. |
| `/data/data/` | OpenFang | Agents, memory, sessions, credential vault, etc. |
| `/data/secrets.env` | OpenFang | Provider keys entered through the OpenFang dashboard (`POST /api/providers/{name}/key`). |
| `/data/.openfang-railway/state.json` | template | Schema version, first/last boot time, template version. Used for forward migrations. |
| `/data/.openfang-railway/backups/` | template | Timestamped copies of `config.toml` taken before any change the template makes (adoption, admin edits). The newest 20 are kept. |

Rules the template follows:

- **Seed once.** `config.toml` is created only if it does not exist. Existing files — including
  one created by a different template or by hand — are adopted as-is (after taking a backup).
- **Migrate, don't reset.** `state.json` carries a schema version; new template versions apply
  idempotent migrations forward and never wipe data.
- **Never silently reset a broken config.** If `config.toml` fails to parse (checked with the
  same OpenFang binary that would load it), the daemon is not started, the healthcheck stays
  `503`, and the file is left untouched. Fix it at `/_gate/config` (validated before it is saved,
  backed up, written atomically) or restore a backup.
- **Listen address and API key come from the environment.** The gate sets `OPENFANG_LISTEN` and
  `OPENFANG_API_KEY` for the daemon so they are never baked into the file. If you set `api_key`
  in `config.toml` yourself, that value is used by both the daemon and the gate.
- **Secrets stay out of the file system the template controls.** Provider keys are environment
  variables or OpenFang-managed; the gate never writes them.

## Backup, restore and rollback

**Configuration backups** are taken automatically (see above). To restore one, sign in, open
`/_gate/status` to see the daemon state, then paste the desired backup contents into
`/_gate/config` and save. Backups are readable with Railway's shell:
`railway ssh -- ls /data/.openfang-railway/backups`.

**Whole-volume backups** should use Railway's volume backup feature on the service's volume
settings (see Railway's documentation for the current UI); the template does not duplicate that.
Everything OpenFang needs to come back is under `/data`.

**Rolling back the template/OpenFang version:** use Railway's *Redeploy* on a previous
deployment (image and volume are independent, so your data stays). To pin a different upstream
release permanently, change `OPENFANG_VERSION` and `OPENFANG_SHA256` at the top of the
`Dockerfile` in your fork. Configuration written by a newer OpenFang may include keys an older
release does not understand; OpenFang's top-level config accepts unknown keys (its binding
sections do not), so check `/_gate/status` after a downgrade.

**Starting over:** delete the volume (or `railway ssh -- rm -rf /data/*`) and redeploy; the
template seeds a fresh `config.toml` from the `OPENFANG_DEFAULT_*` variables.

## Resource assumptions

Measured on the built image (`tests/image.sh`, idle daemon, one default agent, no traffic):

| Metric | Value |
| --- | --- |
| Image size | ~136 MB |
| Idle memory | ~22 MiB (gate + daemon) |
| Idle CPU | < 0.1 % |
| Cold start to healthy | a few seconds after the container starts |

Actual usage depends on how many agents you run and which tools/skills they use (Python and
Node are in the image for skills and MCP servers). Railway's smallest plans are sufficient for
personal use; the volume grows with OpenFang's memory/session data.

## Comparison with the existing anonymous template

There is an existing OpenFang listing on the Railway marketplace whose source is
[nazihkalo/openfang-railway](https://github.com/nazihkalo/openfang-railway). The behaviours
below were reproduced against its commit `59b1fd29c11d36af21ec3e057986bcb8c48a385b` on
2026-09-28 with local scripts that start the wrapper without a working OpenFang binary and that
edit the model in the dashboard and restart. This is a factual engineering comparison, not a
claim about its author.

| | existing listing | this template |
| --- | --- | --- |
| OpenFang source | `git clone` of `main` at build time (unpinned, changes between builds) | release `v0.6.9` binary, SHA-256 verified |
| Healthcheck | `/setup/healthz` returns `200` as soon as the wrapper's own process is up — also when `openfang` is missing or crashing | `200` only while the daemon process is alive **and** `/api/health` succeeded within 10 s |
| `config.toml` | regenerated from environment variables on **every** boot; a model change in the dashboard is lost on restart | written once; dashboard edits persist (verified by restart tests) |
| Dashboard auth | API key injected into browser `localStorage` from the setup page | HttpOnly session cookie or bearer token; key never sent to the browser |
| Runs as | root | `openfang` (uid 10001), `tini` as PID 1 |
| Auth on SSE / WebSocket | not covered by tests | covered by tests (HTTP, SSE and WebSocket) |

## Compatibility

| Template | OpenFang | Base image | Arch | Node | Notes |
| --- | --- | --- | --- | --- | --- |
| 1.0.0 | 0.6.9 (`acf2587`) | `node:22-bookworm-slim` (digest-pinned) | `linux/amd64` | 22 | first release |

The config schema version stored in `state.json` is `1`. Newer template releases list any
migrations in [CHANGELOG.md](CHANGELOG.md).

## Limitations

- **Single instance.** OpenFang keeps state on local disk; run one replica per volume.
- **No live-provider tests in CI.** The test suite uses the real OpenFang binary but no real
  LLM provider; whether a given provider/model works is OpenFang's behaviour, not the template's.
- **Upstream moves fast.** Features described in OpenFang's `main` branch may not exist in
  `v0.6.9`. Upgrades happen by bumping the pinned release here after testing.
- **Admin console is minimal on purpose.** Status and raw `config.toml` editing only; all
  product configuration happens in OpenFang's own dashboard.
- **Query-string tokens** (`?token=`) are accepted for browser SSE/WebSocket clients, as they
  are by OpenFang itself. The gate removes the parameter before forwarding the request and does
  not log request URLs, but the token still appears in your browser history. Prefer headers
  where you can.
- **Not verified by Railway or OpenFang.** Any "verified" badge you see on a marketplace
  listing is Railway's decision, not a claim made here.

## Deploy without the template

1. Create a new Railway service from this GitHub repository (Railway detects the `Dockerfile`).
2. Add a volume, mount path `/data`.
3. Add the variables from [Required variables](#required-variables).
4. Railway reads the healthcheck path and restart policy from `railway.json`.

## Local development and tests

```sh
npm run lint                     # syntax check gate/ and tests/
shellcheck entrypoint.sh tests/image.sh
npm test                         # behaviour tests against a fake daemon (no network)
OPENFANG_BIN=/path/to/openfang npm run test:integration   # real binary, no provider needed
docker build -t openfang-railway:test .
tests/image.sh openfang-railway:test                      # container-level checks
```

`npm test` covers: readiness stays `503` when the binary is missing / hangs / keeps exiting,
recovers after a health outage, daemon restart, HTTP/SSE/WebSocket auth, session forgery,
login rate limiting, cross-site protection, secret redaction and env filtering, one-time seeding,
adoption of an existing volume, corrupt-config blocking and repair, graceful SIGTERM, and refusal
to boot with weak/missing credentials. The integration and image tests boot the real OpenFang
binary, change the model through OpenFang's own API and verify it survives a restart.

The same commands run in [GitHub Actions](.github/workflows/ci.yml) on every push.

## Support

- Bugs and questions about **this template**: open an issue in this repository.
- Bugs in **OpenFang itself** (agents, tools, providers, dashboard): upstream at
  https://github.com/RightNow-AI/openfang/issues.
- Railway platform questions (billing, volumes, domains): https://help.railway.com.

Security issues in the gate: please open a private security advisory on this repository rather
than a public issue.

## License

The template and gate are MIT licensed (see [LICENSE](LICENSE)). OpenFang is redistributed
unmodified under its Apache-2.0 OR MIT license; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
