import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  clearCookie,
  clearLoginFailures,
  clientIp,
  COOKIE_NAME,
  createSessionToken,
  extractApiCredential,
  loginAllowed,
  parseCookies,
  recordLoginFailure,
  sessionCookie,
  stripCookie,
  timingSafeEqualString,
  verifyPassword,
  verifySessionToken,
} from "./auth.js";
import {
  ADMIN_PASSWORD,
  CONFIG_PATH,
  DAEMON_HOST,
  DAEMON_PORT,
  ENV_API_KEY,
  MIN_PASSWORD_LENGTH,
  OPENFANG_HOME,
  OPENFANG_VERSION,
  PORT,
  TEMPLATE_VERSION,
} from "./config.js";
import {
  blockDaemon,
  getEffectiveApiKey,
  isReady,
  restartDaemon,
  setEffectiveApiKey,
  startSupervisor,
  state,
  stopDaemon,
} from "./daemon.js";
import { log, recentLogs } from "./log.js";
import { configPage, loginPage, statusPage, unavailablePage } from "./pages.js";
import { atomicWrite, backupConfig, migrate, readConfigValue, validateConfigFile } from "./storage.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function wantsHtml(req) {
  const accept = req.headers.accept || "";
  return req.method === "GET" && accept.includes("text/html");
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  send(res, status, `${JSON.stringify(payload)}\n`, { "Content-Type": "application/json; charset=utf-8", ...headers });
}

function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, { "Content-Type": "text/html; charset=utf-8", ...headers });
}

function safeNext(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/_gate/login")) {
    return "/";
  }
  return value;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authenticate(req, url) {
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies.get(COOKIE_NAME))) return { kind: "session" };
  const credential = extractApiCredential(req, url);
  const apiKey = getEffectiveApiKey();
  if (credential && apiKey && timingSafeEqualString(credential, apiKey)) return { kind: "api_key" };
  return null;
}

function sameOriginOrNoOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function denyAuth(req, res, url) {
  if (wantsHtml(req)) {
    const next = encodeURIComponent(safeNext(url.pathname + url.search));
    send(res, 302, "", { Location: `/_gate/login?next=${next}` });
    return;
  }
  sendJson(res, 401, { error: "authentication required" }, { "WWW-Authenticate": 'Bearer realm="OpenFang"' });
}

function statusSnapshot() {
  return {
    ready: isReady(),
    template_version: TEMPLATE_VERSION,
    openfang_version: OPENFANG_VERSION,
    daemon: {
      running: state.proc !== null,
      pid: state.pid,
      started_at: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      restarts: state.restarts,
      last_exit: state.lastExit,
      last_error: state.lastError,
      last_probe: state.lastProbeStatus,
      last_healthy_at: state.lastHealthyAt ? new Date(state.lastHealthyAt).toISOString() : null,
      blocked: state.blocked,
    },
    config: { path: CONFIG_PATH, state: state.configState, error: state.configError },
    home: OPENFANG_HOME,
    hostname: os.hostname(),
    recent_logs: recentLogs().slice(-60),
  };
}

async function handleGate(req, res, url) {
  const secure = isSecure(req);

  if (url.pathname === "/_gate/healthz") {
    const ready = isReady();
    sendJson(res, ready ? 200 : 503, { ok: ready });
    return true;
  }

  if (url.pathname === "/_gate/login") {
    if (req.method === "GET") {
      sendHtml(res, 200, loginPage({ next: safeNext(url.searchParams.get("next") || "/") }));
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, "", { Allow: "GET, POST" });
      return true;
    }
    if (!sameOriginOrNoOrigin(req)) {
      send(res, 403, "cross-site request rejected");
      return true;
    }
    const ip = clientIp(req);
    if (!loginAllowed(ip)) {
      sendHtml(res, 429, loginPage({ error: "Too many failed attempts. Try again in 15 minutes." }), { "Retry-After": "900" });
      return true;
    }
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const next = safeNext(form.get("next") || "/");
    if (!verifyPassword(form.get("password") || "")) {
      recordLoginFailure(ip);
      log("gate", `failed login from ${ip}`);
      await new Promise((r) => setTimeout(r, 300));
      sendHtml(res, 401, loginPage({ next, error: "Incorrect password." }));
      return true;
    }
    clearLoginFailures(ip);
    log("gate", `admin login from ${ip}`);
    send(res, 303, "", { Location: next, "Set-Cookie": sessionCookie(createSessionToken(), { secure }) });
    return true;
  }

  if (url.pathname === "/_gate/logout") {
    if (req.method !== "POST") {
      send(res, 405, "", { Allow: "POST" });
      return true;
    }
    send(res, 303, "", { Location: "/_gate/login", "Set-Cookie": clearCookie({ secure }) });
    return true;
  }

  if (!url.pathname.startsWith("/_gate/")) return false;

  const auth = authenticate(req, url);
  if (!auth) {
    denyAuth(req, res, url);
    return true;
  }

  if (url.pathname === "/_gate/status") {
    const snapshot = statusSnapshot();
    if (wantsHtml(req)) sendHtml(res, 200, statusPage(snapshot));
    else sendJson(res, 200, snapshot);
    return true;
  }

  if (url.pathname === "/_gate/config") {
    if (req.method === "GET") {
      const content = fs.existsSync(CONFIG_PATH) ? await fsp.readFile(CONFIG_PATH, "utf8") : "";
      sendHtml(res, 200, configPage({ content, daemonBlocked: state.blocked }));
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, "", { Allow: "GET, POST" });
      return true;
    }
    if (!sameOriginOrNoOrigin(req)) {
      send(res, 403, "cross-site request rejected");
      return true;
    }
    const contentType = req.headers["content-type"] || "";
    const raw = await readBody(req, 1024 * 1024);
    const content = contentType.startsWith("application/json")
      ? JSON.parse(raw).content
      : new URLSearchParams(raw).get("content");
    if (typeof content !== "string") {
      sendJson(res, 400, { error: "missing content" });
      return true;
    }
    const candidateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "of-cfg-"));
    const candidate = path.join(candidateDir, "config.toml");
    try {
      await fsp.writeFile(candidate, content, { encoding: "utf8", mode: 0o600 });
      const check = await validateConfigFile(candidate);
      if (check.unverified) check.error = `could not validate: ${check.unverified}`;
      if (!check.ok || check.unverified) {
        if (contentType.startsWith("application/json")) sendJson(res, 400, { error: check.error });
        else sendHtml(res, 400, configPage({ content, error: check.error, daemonBlocked: state.blocked }));
        return true;
      }
    } finally {
      await fsp.rm(candidateDir, { recursive: true, force: true });
    }
    await backupConfig("edit");
    await atomicWrite(CONFIG_PATH, content.endsWith("\n") ? content : `${content}\n`);
    state.configState = "valid";
    state.configError = null;
    await refreshApiKey();
    restartDaemon("config.toml edited via /_gate/config");
    log("gate", "config.toml replaced by admin; backup written");
    if (contentType.startsWith("application/json")) sendJson(res, 200, { status: "saved" });
    else sendHtml(res, 200, configPage({ content, saved: true }));
    return true;
  }

  send(res, 404, "not found");
  return true;
}

function proxyHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || name === "authorization" || name === "x-api-key") continue;
    if (name === "cookie") {
      const remaining = stripCookie(value, COOKIE_NAME);
      if (remaining) headers.cookie = remaining;
      continue;
    }
    headers[name] = value;
  }
  headers.authorization = `Bearer ${getEffectiveApiKey()}`;
  headers.host = `${DAEMON_HOST}:${DAEMON_PORT}`;
  if (!headers["x-forwarded-for"]) headers["x-forwarded-for"] = req.socket.remoteAddress || "";
  return headers;
}

// The gate authenticates upstream with the bearer header, so a ?token= presented
// by a browser client is dropped here rather than forwarded (and logged) by the daemon.
function upstreamPath(url) {
  if (!url.searchParams.has("token")) return url.pathname + url.search;
  const params = new URLSearchParams(url.searchParams);
  params.delete("token");
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

function proxyRequest(req, res, url) {
  if (!state.proc || state.blocked) {
    const detail = state.blocked
      ? `OpenFang is stopped: ${state.blocked}`
      : "OpenFang is starting or restarting. Retry in a few seconds.";
    if (wantsHtml(req)) sendHtml(res, 503, unavailablePage(detail), { "Retry-After": "5" });
    else sendJson(res, 503, { error: "openfang unavailable" }, { "Retry-After": "5" });
    return;
  }
  req.socket.setTimeout(0);
  const upstream = http.request(
    { host: DAEMON_HOST, port: DAEMON_PORT, method: req.method, path: upstreamPath(url), headers: proxyHeaders(req) },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      for (const name of Object.keys(headers)) if (HOP_BY_HOP.has(name)) delete headers[name];
      if (upstreamRes.headers["transfer-encoding"]) headers["transfer-encoding"] = upstreamRes.headers["transfer-encoding"];
      res.writeHead(upstreamRes.statusCode, headers);
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );
  upstream.on("error", (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (wantsHtml(req)) sendHtml(res, 503, unavailablePage("OpenFang did not answer. Retry in a few seconds."), { "Retry-After": "5" });
    else sendJson(res, 503, { error: "openfang unavailable" }, { "Retry-After": "5" });
    log("gate", `proxy error: ${err.code || err.message}`);
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const url = new URL(req.url, "http://gate");
  const auth = authenticate(req, url);
  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!state.proc || state.blocked) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstream = net.connect(DAEMON_PORT, DAEMON_HOST, () => {
    const headers = proxyHeaders(req);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade;
    const lines = [`${req.method} ${upstreamPath(url)} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  socket.setTimeout(0);
  upstream.setTimeout(0);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}

async function refreshApiKey() {
  const fromConfig = await readConfigValue("api_key");
  if (fromConfig && fromConfig !== ENV_API_KEY) {
    log("gate", "config.toml sets api_key; it takes precedence over OPENFANG_API_KEY for the daemon");
  }
  setEffectiveApiKey(fromConfig || ENV_API_KEY);
}

async function handler(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://gate");
  } catch {
    send(res, 400, "bad request");
    return;
  }
  try {
    if (await handleGate(req, res, url)) return;
  } catch (err) {
    log("error", `gate handler failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, err.message === "body too large" ? 413 : 500, { error: "gate error" });
    return;
  }
  const auth = authenticate(req, url);
  if (!auth) {
    denyAuth(req, res, url);
    return;
  }
  if (auth.kind === "session" && req.method !== "GET" && req.method !== "HEAD" && !sameOriginOrNoOrigin(req)) {
    sendJson(res, 403, { error: "cross-site request rejected" });
    return;
  }
  proxyRequest(req, res, url);
}

function fail(message) {
  log("error", message);
  process.exit(1);
}

async function main() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    fail(`ADMIN_PASSWORD must be set to at least ${MIN_PASSWORD_LENGTH} characters (Railway Variables).`);
  }
  if (!ENV_API_KEY) fail("OPENFANG_API_KEY must be set (Railway Variables).");

  setEffectiveApiKey(ENV_API_KEY);

  // Listen before touching the volume or the binary so /_gate/healthz answers
  // 503 (not a connection error) during boot; readiness stays false until the
  // daemon is up and /api/health has succeeded.
  const server = http.createServer(handler);
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 75000;
  server.on("upgrade", proxyUpgrade);
  server.on("clientError", (err, socket) => {
    if (err.code !== "ECONNRESET" && socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  log("gate", `listening on :${PORT} (template ${TEMPLATE_VERSION}, openfang ${OPENFANG_VERSION})`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log("gate", `received ${signal}; shutting down`);
    state.shuttingDown = true;
    server.close();
    server.closeIdleConnections?.();
    await stopDaemon();
    server.closeAllConnections?.();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await migrate();
  const check = await validateConfigFile();
  if (check.ok) {
    state.configState = check.missing ? "missing" : check.unverified ? "unverified" : "valid";
    state.configError = check.unverified || null;
    if (check.unverified) log("error", `could not validate config.toml: ${check.unverified}`);
    await refreshApiKey();
  } else {
    state.configState = "invalid";
    state.configError = check.error;
    log("error", `config.toml is invalid and was left untouched: ${check.error}`);
    log("error", "OpenFang will not start until it is fixed at /_gate/config (sign in with ADMIN_PASSWORD).");
    blockDaemon(`config.toml is invalid: ${check.error}`);
  }
  if (state.shuttingDown) return;
  startSupervisor();
}

main().catch((err) => fail(`gate failed to start: ${err.stack || err.message}`));
