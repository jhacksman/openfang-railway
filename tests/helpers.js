import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = path.join(TEMPLATE_DIR, "gate", "server.js");
export const FAKE_DAEMON = path.join(TEMPLATE_DIR, "tests", "fake-daemon.js");

export const PASSWORD = "correct-horse-battery-staple";
export const API_KEY = "test-api-key-0123456789";

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function mkHome() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "of-test-home-"));
}

// Creates a directory containing an `openfang` executable that behaves like
// `mode`: "fake" runs tests/fake-daemon.js, "hang" never listens, "exit" fails
// immediately, "real" symlinks the real binary from OPENFANG_BIN.
export async function makeBin(mode) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "of-test-bin-"));
  const target = path.join(dir, "openfang");
  if (mode === "real") {
    const real = process.env.OPENFANG_BIN || "openfang";
    const resolved = real.includes("/") ? real : childProcess.execSync(`command -v ${real}`).toString().trim();
    await fsp.symlink(resolved, target);
    return dir;
  }
  const scripts = {
    fake: `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DAEMON}" "$@"\n`,
    hang: "#!/bin/sh\nexec sleep 3600\n",
    exit: '#!/bin/sh\necho "fatal: simulated boot failure" >&2\nexit 1\n',
  };
  await fsp.writeFile(target, scripts[mode], { mode: 0o755 });
  return dir;
}

export async function startGate({ binDir, home, env = {} }) {
  const port = await freePort();
  const daemonPort = await freePort();
  const logs = [];
  const proc = childProcess.spawn(process.execPath, [SERVER], {
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: home,
      PORT: String(port),
      OPENFANG_HOME: home,
      OPENFANG_DAEMON_PORT: String(daemonPort),
      ADMIN_PASSWORD: PASSWORD,
      OPENFANG_API_KEY: API_KEY,
      GATE_PROBE_INTERVAL_MS: "300",
      GATE_PROBE_STALE_MS: "1500",
      GATE_SHUTDOWN_GRACE_MS: "5000",
      TEMPLATE_VERSION: "test",
      NO_COLOR: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (stream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => logs.push(...chunk.split("\n").filter(Boolean)));
  };
  collect(proc.stdout);
  collect(proc.stderr);
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));

  const gate = {
    proc,
    port,
    daemonPort,
    home,
    logs,
    exited,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    async stop() {
      if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
      return exited;
    },
  };

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return gate;
    try {
      await fetch(gate.url("/_gate/healthz"));
      return gate;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`gate did not listen: ${logs.join("\n")}`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(fn, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`condition not met within ${timeout}ms (last=${JSON.stringify(last)})`);
}

export async function healthz(gate) {
  const res = await fetch(gate.url("/_gate/healthz"));
  return { status: res.status, body: await res.json() };
}

export async function login(gate, password = PASSWORD) {
  const res = await fetch(gate.url("/_gate/login"), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, next: "/" }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return { status: res.status, cookie: setCookie.split(";")[0], location: res.headers.get("location") };
}

export function readFile(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
