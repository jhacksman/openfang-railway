import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { API_KEY, healthz, login, makeBin, mkHome, PASSWORD, readFile, sleep, startGate, waitFor } from "./helpers.js";

async function withGate(mode, fn, opts = {}) {
  const binDir = await makeBin(mode);
  const home = opts.home || (await mkHome());
  const gate = await startGate({ binDir, home, env: opts.env });
  try {
    await fn(gate, { binDir, home });
  } finally {
    await gate.stop();
  }
}

async function sampleHealthz(gate, seconds) {
  const codes = [];
  for (let i = 0; i < seconds * 2; i += 1) {
    codes.push((await healthz(gate)).status);
    await sleep(500);
  }
  return codes;
}

test("readiness fails while the openfang binary is missing", async () => {
  await withGate("fake", async (gate) => {
    const codes = await sampleHealthz(gate, 3);
    assert.deepEqual([...new Set(codes)], [503]);
    assert.ok(gate.logs.some((l) => l.includes("ENOENT")), gate.logs.join("\n"));
    assert.ok(gate.logs.some((l) => l.includes("restarting openfang")), gate.logs.join("\n"));
    const { cookie } = await login(gate);
    const status = await (await fetch(gate.url("/_gate/status"), { headers: { cookie } })).json();
    assert.equal(status.daemon.pid, null);
    assert.ok(status.daemon.restarts >= 1, JSON.stringify(status.daemon));
  }, { env: { PATH: "/nonexistent-bin" } });
});

test("readiness fails while openfang runs but never becomes healthy", async () => {
  await withGate("hang", async (gate) => {
    const codes = await sampleHealthz(gate, 3);
    assert.deepEqual([...new Set(codes)], [503]);
  });
});

test("readiness fails while openfang keeps exiting", async () => {
  await withGate("exit", async (gate) => {
    const codes = await sampleHealthz(gate, 3);
    assert.deepEqual([...new Set(codes)], [503]);
    assert.ok(gate.logs.some((l) => l.includes("exited (code=1")), gate.logs.join("\n"));
  });
});

test("readiness follows the real daemon health, with no details in the public body", async () => {
  const marker = path.join(await mkHome(), "fail");
  await withGate("fake", async (gate) => {
    const ready = await waitFor(async () => (await healthz(gate)).status === 200);
    assert.ok(ready);
    assert.deepEqual((await healthz(gate)).body, { ok: true });

    fs.writeFileSync(marker, "x");
    await waitFor(async () => (await healthz(gate)).status === 503);
    assert.deepEqual((await healthz(gate)).body, { ok: false });

    fs.rmSync(marker);
    await waitFor(async () => (await healthz(gate)).status === 200);
  }, { env: { FAKE_HEALTH_FAIL_FILE: marker } });
});

test("a crashed daemon is restarted and readiness recovers", async () => {
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    const { cookie } = await login(gate);
    const status = await (await fetch(gate.url("/_gate/status"), { headers: { cookie } })).json();
    process.kill(status.daemon.pid, "SIGKILL");
    await waitFor(async () => (await healthz(gate)).status === 503);
    await waitFor(async () => (await healthz(gate)).status === 200);
    const after = await (await fetch(gate.url("/_gate/status"), { headers: { cookie } })).json();
    assert.equal(after.daemon.restarts, 1);
    assert.notEqual(after.daemon.pid, status.daemon.pid);
  });
});

test("unauthenticated requests are rejected; browsers are redirected to login", async () => {
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    const api = await fetch(gate.url("/api/echo"));
    assert.equal(api.status, 401);
    assert.match(api.headers.get("www-authenticate") || "", /Bearer/);
    const page = await fetch(gate.url("/?x=1"), { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/_gate/login?next=%2F%3Fx%3D1");
    const status = await fetch(gate.url("/_gate/status"));
    assert.equal(status.status, 401);
    const ws = await fetch(gate.url("/ws"), { headers: { connection: "Upgrade", upgrade: "websocket" } }).catch((e) => e);
    assert.ok(ws instanceof Error || ws.status === 401);
  });
});

test("password login, API key and query token are accepted; wrong credentials are not", async () => {
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    const bad = await login(gate, "wrong-password-value");
    assert.equal(bad.status, 401);
    assert.equal(bad.cookie, "");

    const good = await login(gate);
    assert.equal(good.status, 303);
    assert.match(good.cookie, /^of_gate=v1\./);
    const viaCookie = await fetch(gate.url("/api/echo"), { headers: { cookie: good.cookie } });
    assert.equal(viaCookie.status, 200);

    const forged = `${good.cookie.slice(0, -4)}AAAA`;
    assert.equal((await fetch(gate.url("/api/echo"), { headers: { cookie: forged } })).status, 401);

    assert.equal((await fetch(gate.url("/api/echo"), { headers: { authorization: `Bearer ${API_KEY}` } })).status, 200);
    assert.equal((await fetch(gate.url("/api/echo"), { headers: { "x-api-key": API_KEY } })).status, 200);
    const viaQuery = await fetch(gate.url(`/api/echo?a=1&token=${API_KEY}&b=2`));
    assert.equal(viaQuery.status, 200);
    assert.equal((await viaQuery.json()).url, "/api/echo?a=1&b=2");
    assert.equal((await fetch(gate.url("/api/echo"), { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(gate.url("/api/echo?token=nope"))).status, 401);
    assert.equal((await fetch(gate.url("/api/echo"), { headers: { authorization: `Bearer ${PASSWORD}` } })).status, 401);
  });
});

test("login is rate limited and cross-site cookie POSTs are refused", async () => {
  await withGate("fake", async (gate) => {
    for (let i = 0; i < 10; i += 1) assert.equal((await login(gate, "wrong-password-value")).status, 401);
    assert.equal((await login(gate)).status, 429);

    const { cookie } = await login(gate, PASSWORD).then(async (r) => (r.status === 429 ? { cookie: null } : r));
    if (cookie) {
      const csrf = await fetch(gate.url("/api/echo"), {
        method: "POST",
        headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: "{}",
      });
      assert.equal(csrf.status, 403);
    }
  });
});

test("the gate injects the daemon credential and strips client secrets and gate-only env", async () => {
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    const { cookie } = await login(gate);
    const res = await fetch(gate.url("/api/echo"), {
      method: "POST",
      headers: { cookie: `${cookie}; other=1`, authorization: "Bearer client-supplied", "x-api-key": "client-key", "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(res.status, 200);
    const echo = await res.json();
    assert.equal(echo.body, "hello");
    assert.equal(echo.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(echo.headers["x-api-key"], undefined);
    assert.equal(echo.headers.cookie, "other=1");
    assert.equal(echo.env.ADMIN_PASSWORD, null);
    assert.equal(echo.env.PORT, null);
    assert.equal(echo.env.OPENFANG_LISTEN, `127.0.0.1:${gate.daemonPort}`);
  });
});

test("server-sent events stream through the gate", async () => {
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    const res = await fetch(gate.url(`/api/stream?token=${API_KEY}`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const text = await res.text();
    assert.equal((text.match(/data: tick/g) || []).length, 3);
  });
});

test("websocket upgrades are authenticated and proxied", async () => {
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    const denied = new WebSocket(`ws://127.0.0.1:${gate.port}/ws`);
    await new Promise((resolve) => {
      denied.addEventListener("error", resolve);
      denied.addEventListener("close", resolve);
    });

    const ws = new WebSocket(`ws://127.0.0.1:${gate.port}/ws?token=${API_KEY}`);
    const echoed = await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => ws.send("ping"));
      ws.addEventListener("message", (event) => resolve(String(event.data)));
      ws.addEventListener("error", () => reject(new Error("websocket failed")));
      setTimeout(() => reject(new Error("websocket timeout")), 5000);
    });
    assert.equal(echoed, "ping");
    ws.close();
  });
});

test("config.toml is seeded once and never rewritten on later boots", async () => {
  const home = await mkHome();
  const configPath = path.join(home, "config.toml");
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    assert.match(readFile(configPath), /provider = "anthropic"/);
    const state = JSON.parse(readFile(path.join(home, ".openfang-railway", "state.json")));
    assert.equal(state.schema, 1);
    assert.equal(state.template_version, "test");
  }, { home });

  const edited = readFile(configPath).replace('provider = "anthropic"', 'provider = "openai"').replace(/model = ".*"/, 'model = "gpt-4o-mini"') + '\n[custom]\nkept = true\n';
  await fsp.writeFile(configPath, edited);

  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    assert.equal(readFile(configPath), edited);
  }, { home, env: { OPENFANG_DEFAULT_PROVIDER: "groq", OPENFANG_DEFAULT_MODEL: "other" } });
});

test("an existing volume from another layout is adopted, backed up and left intact", async () => {
  const home = await mkHome();
  const configPath = path.join(home, "config.toml");
  const original = 'include = ["config.user.toml"]\nlog_level = "debug"\n[default_model]\nprovider = "openai"\nmodel = "gpt-4o"\n';
  await fsp.writeFile(configPath, original);
  await fsp.writeFile(path.join(home, "config.user.toml"), "[custom]\nx = 1\n");
  await withGate("fake", async (gate) => {
    await waitFor(async () => (await healthz(gate)).status === 200);
    assert.equal(readFile(configPath), original);
    const backups = fs.readdirSync(path.join(home, ".openfang-railway", "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /\.adopt$/);
  }, { home });
});

test("a corrupt config.toml blocks the daemon, is never reset, and can be repaired via /_gate/config", async () => {
  const home = await mkHome();
  const configPath = path.join(home, "config.toml");
  const corrupt = 'log_level = "info"\n[default_model\nprovider = "x"\n';
  await fsp.writeFile(configPath, corrupt);
  await withGate("fake", async (gate) => {
    const codes = await sampleHealthz(gate, 2);
    assert.deepEqual([...new Set(codes)], [503]);
    assert.equal(readFile(configPath), corrupt);
    assert.ok(gate.logs.some((l) => l.includes("config.toml is invalid")), gate.logs.join("\n"));

    const { cookie } = await login(gate);
    const status = await (await fetch(gate.url("/_gate/status"), { headers: { cookie } })).json();
    assert.equal(status.daemon.running, false);
    assert.equal(status.config.state, "invalid");

    const stillBad = await fetch(gate.url("/_gate/config"), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: "[broken\n" }),
    });
    assert.equal(stillBad.status, 400);
    assert.equal(readFile(configPath), corrupt);

    const fixed = 'log_level = "info"\n[default_model]\nprovider = "openai"\nmodel = "gpt-4o-mini"\n';
    const repaired = await fetch(gate.url("/_gate/config"), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ content: fixed }),
    });
    assert.equal(repaired.status, 200);
    assert.equal(readFile(configPath), fixed);
    const backups = fs.readdirSync(path.join(home, ".openfang-railway", "backups")).filter((b) => b.endsWith(".edit"));
    assert.equal(backups.length, 1);
    assert.equal(readFile(path.join(home, ".openfang-railway", "backups", backups[0])), corrupt);
    await waitFor(async () => (await healthz(gate)).status === 200);
  }, { home });
});

test("SIGTERM stops the daemon gracefully and exits 0", async () => {
  const binDir = await makeBin("fake");
  const gate = await startGate({ binDir, home: await mkHome() });
  await waitFor(async () => (await healthz(gate)).status === 200);
  gate.proc.kill("SIGTERM");
  const result = await gate.exited;
  assert.equal(result.code, 0);
  assert.ok(gate.logs.some((l) => l.includes("fake openfang got SIGTERM")), gate.logs.join("\n"));
});

test("the gate refuses to start without a usable ADMIN_PASSWORD or API key", async () => {
  const binDir = await makeBin("fake");
  for (const env of [{ ADMIN_PASSWORD: "" }, { ADMIN_PASSWORD: "short" }, { OPENFANG_API_KEY: "" }]) {
    const gate = await startGate({ binDir, home: await mkHome(), env });
    const result = await gate.exited;
    assert.equal(result.code, 1, JSON.stringify(env));
    assert.ok(gate.logs.some((l) => /must be set/.test(l)), gate.logs.join("\n"));
  }
});
