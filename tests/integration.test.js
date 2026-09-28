// Runs the gate against the real pinned `openfang` binary (OPENFANG_BIN or
// `openfang` on PATH). No provider credentials are needed: nothing here sends
// a message to an LLM, it exercises boot, auth, the dashboard's persistence
// path (POST /api/config/set) across a restart, WebSocket auth and shutdown.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { API_KEY, healthz, login, makeBin, mkHome, readFile, startGate, waitFor } from "./helpers.js";

const bearer = { authorization: `Bearer ${API_KEY}` };

async function startReal(home, env = {}) {
  const binDir = await makeBin("real");
  const gate = await startGate({ binDir, home, env: { GATE_PROBE_INTERVAL_MS: "500", GATE_PROBE_STALE_MS: "5000", ...env } });
  await waitFor(async () => (await healthz(gate)).status === 200, { timeout: 60000 });
  return gate;
}

test("real openfang: boots, is only reachable with credentials, and stops on SIGTERM", async () => {
  const home = await mkHome();
  const gate = await startReal(home);
  try {
    assert.equal((await fetch(gate.url("/api/health"))).status, 401);
    assert.equal((await fetch(gate.url("/api/tools"), { headers: { authorization: "Bearer wrong-key" } })).status, 401);

    const health = await (await fetch(gate.url("/api/health"), { headers: bearer })).json();
    assert.equal(health.status, "ok");
    const tools = await (await fetch(gate.url("/api/tools"), { headers: bearer })).json();
    assert.ok(tools.total > 0);

    const { cookie, status } = await login(gate);
    assert.equal(status, 303);
    const dashboard = await fetch(gate.url("/"), { headers: { cookie, accept: "text/html" } });
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type") || "", /text\/html/);

    const agents = await (await fetch(gate.url("/api/agents"), { headers: bearer })).json();
    const first = Array.isArray(agents) ? agents[0] : agents.agents?.[0];
    assert.ok(first?.id, `expected a default agent, got ${JSON.stringify(agents).slice(0, 200)}`);
    {
      const denied = new WebSocket(`ws://127.0.0.1:${gate.port}/api/agents/${first.id}/ws`);
      const deniedResult = await new Promise((resolve) => {
        denied.addEventListener("error", () => resolve("error"));
        denied.addEventListener("open", () => resolve("open"));
      });
      assert.equal(deniedResult, "error");

      const ws = new WebSocket(`ws://127.0.0.1:${gate.port}/api/agents/${first.id}/ws?token=${API_KEY}`);
      const opened = await new Promise((resolve) => {
        ws.addEventListener("open", () => resolve("open"));
        ws.addEventListener("error", () => resolve("error"));
        setTimeout(() => resolve("timeout"), 5000);
      });
      assert.equal(opened, "open");
      ws.close();
    }

    assert.ok(!gate.logs.some((l) => l.includes(API_KEY)), "api key leaked into logs");
    assert.ok(readFile(path.join(home, "config.toml")).includes('provider = "anthropic"'));
  } finally {
    gate.proc.kill("SIGTERM");
    const result = await gate.exited;
    assert.equal(result.code, 0);
    assert.ok(gate.logs.some((l) => l.includes("stopping openfang (SIGTERM)")), gate.logs.join("\n"));
  }
});

test("real openfang: a dashboard model change survives a restart", async () => {
  const home = await mkHome();
  const configPath = path.join(home, "config.toml");

  let gate = await startReal(home);
  try {
    const before = await (await fetch(gate.url("/api/config"), { headers: bearer })).json();
    assert.equal(before.default_model.provider, "anthropic");
    assert.equal(before.api_key, "***");

    for (const [p, value] of [["default_model.provider", "openai"], ["default_model.model", "gpt-4o-mini"]]) {
      const res = await fetch(gate.url("/api/config/set"), {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ path: p, value }),
      });
      assert.equal(res.status, 200, await res.text());
    }
    await waitFor(() => /provider = "openai"/.test(readFile(configPath) || ""));
    assert.match(readFile(configPath), /model = "gpt-4o-mini"/);
  } finally {
    await gate.stop();
  }

  gate = await startReal(home, { OPENFANG_DEFAULT_PROVIDER: "anthropic", OPENFANG_DEFAULT_MODEL: "claude-sonnet-4-20250514" });
  try {
    const after = await (await fetch(gate.url("/api/config"), { headers: bearer })).json();
    assert.equal(after.default_model.provider, "openai");
    assert.equal(after.default_model.model, "gpt-4o-mini");
    assert.match(readFile(configPath), /provider = "openai"/);
    const state = JSON.parse(readFile(path.join(home, ".openfang-railway", "state.json")));
    assert.equal(state.schema, 1);
  } finally {
    await gate.stop();
  }
});
