import childProcess from "node:child_process";
import http from "node:http";

import {
  CONFIG_PATH,
  DAEMON_HOST,
  DAEMON_LISTEN,
  DAEMON_PORT,
  GATE_ONLY_ENV,
  OPENFANG_BIN,
  OPENFANG_HOME,
  PROBE_INTERVAL_MS,
  PROBE_STALE_MS,
  PROBE_TIMEOUT_MS,
  RESTART_BACKOFF_MAX_MS,
  RESTART_BACKOFF_MIN_MS,
  SHUTDOWN_GRACE_MS,
} from "./config.js";
import { log } from "./log.js";

export const state = {
  proc: null,
  pid: null,
  startedAt: null,
  restarts: 0,
  lastExit: null,
  lastError: null,
  lastHealthyAt: 0,
  lastProbeAt: 0,
  lastProbeStatus: null,
  configState: "unknown",
  configError: null,
  shuttingDown: false,
  blocked: null,
};

let restartTimer = null;
let probeTimer = null;
let backoff = RESTART_BACKOFF_MIN_MS;
let effectiveApiKey = "";

export function setEffectiveApiKey(key) {
  effectiveApiKey = key || "";
}

export function getEffectiveApiKey() {
  return effectiveApiKey;
}

function daemonEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!GATE_ONLY_ENV.has(name)) env[name] = value;
  }
  env.OPENFANG_HOME = OPENFANG_HOME;
  env.OPENFANG_LISTEN = DAEMON_LISTEN;
  if (effectiveApiKey) env.OPENFANG_API_KEY = effectiveApiKey;
  delete env.OPENFANG_ALLOW_NO_AUTH;
  delete env.PORT;
  return env;
}

export function isReady(now = Date.now()) {
  return (
    !state.shuttingDown &&
    !state.blocked &&
    state.proc !== null &&
    state.lastHealthyAt > 0 &&
    now - state.lastHealthyAt <= PROBE_STALE_MS
  );
}

export function probeOnce() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: DAEMON_HOST, port: DAEMON_PORT, path: "/api/health", method: "GET", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on("end", () => {
          let ok = res.statusCode === 200;
          if (ok) {
            try {
              ok = JSON.parse(body).status === "ok";
            } catch {
              ok = false;
            }
          }
          resolve({ ok, status: res.statusCode });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ ok: false, status: null, error: err.code || err.message }));
    req.end();
  });
}

async function probeLoop() {
  if (state.shuttingDown) return;
  const now = Date.now();
  state.lastProbeAt = now;
  if (state.proc) {
    const result = await probeOnce();
    state.lastProbeStatus = result.ok ? "ok" : result.error || `http ${result.status}`;
    if (result.ok) {
      if (state.lastHealthyAt === 0) log("gate", "openfang daemon is healthy");
      state.lastHealthyAt = Date.now();
    }
  } else {
    state.lastProbeStatus = "no process";
  }
  probeTimer = setTimeout(probeLoop, PROBE_INTERVAL_MS);
}

function scheduleRestart(reason) {
  if (state.shuttingDown || restartTimer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, RESTART_BACKOFF_MAX_MS);
  log("gate", `restarting openfang in ${delay}ms (${reason})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    state.restarts += 1;
    spawnDaemon();
  }, delay);
}

export function spawnDaemon() {
  if (state.shuttingDown || state.proc || state.blocked) return;
  state.lastHealthyAt = 0;
  let proc;
  try {
    proc = childProcess.spawn(OPENFANG_BIN, ["start", "--config", CONFIG_PATH], {
      env: daemonEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    state.lastError = `spawn failed: ${err.message}`;
    log("error", state.lastError);
    scheduleRestart("spawn threw");
    return;
  }

  state.proc = proc;
  state.pid = proc.pid || null;
  state.startedAt = Date.now();
  log("gate", `started openfang (pid ${proc.pid ?? "?"})`);

  const forward = (stream, scope) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (line) log(scope, line);
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) log(scope, buffer.trimEnd());
    });
  };
  forward(proc.stdout, "openfang");
  forward(proc.stderr, "openfang");

  proc.on("error", (err) => {
    state.lastError = `openfang could not be started: ${err.code || err.message}`;
    log("error", state.lastError);
  });

  // "close" (not "exit") also fires when the spawn itself fails (ENOENT), so
  // the supervisor never gets stuck holding a process that never ran.
  proc.on("close", (code, signal) => {
    if (state.proc !== proc) return;
    const uptime = Date.now() - (state.startedAt || Date.now());
    state.proc = null;
    state.pid = null;
    state.lastHealthyAt = 0;
    state.lastExit = { code, signal, at: new Date().toISOString(), uptimeMs: uptime };
    if (!state.shuttingDown) {
      log("error", `openfang exited (code=${code} signal=${signal}) after ${Math.round(uptime / 1000)}s`);
      if (uptime > 60000) backoff = RESTART_BACKOFF_MIN_MS;
      scheduleRestart("process exited");
    }
  });
}

export function startSupervisor() {
  spawnDaemon();
  if (!probeTimer) probeLoop();
}

export function restartDaemon(reason) {
  log("gate", `restart requested: ${reason}`);
  backoff = RESTART_BACKOFF_MIN_MS;
  if (state.proc) {
    state.proc.kill("SIGTERM");
  } else if (state.blocked) {
    state.blocked = null;
    spawnDaemon();
  } else {
    scheduleRestart(reason);
  }
}

export function blockDaemon(reason) {
  state.blocked = reason;
  if (state.proc) state.proc.kill("SIGTERM");
}

export function stopDaemon() {
  state.shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (probeTimer) clearTimeout(probeTimer);
  return new Promise((resolve) => {
    const proc = state.proc;
    if (!proc) return resolve();
    const killTimer = setTimeout(() => {
      log("gate", "openfang did not stop in time; sending SIGKILL");
      proc.kill("SIGKILL");
    }, SHUTDOWN_GRACE_MS);
    proc.once("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    log("gate", "stopping openfang (SIGTERM)");
    proc.kill("SIGTERM");
  });
}
