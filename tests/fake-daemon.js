// Minimal stand-in for the `openfang` binary used by the behaviour tests.
// Supports: `config get <key>` (with a crude parse-error check) and
// `start --config <path>` serving /api/health, /api/echo, /api/stream and /ws.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [command, ...rest] = process.argv.slice(2);
const home = process.env.OPENFANG_HOME;

function readConfig() {
  const p = path.join(home, "config.toml");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

if (command === "config" && rest[0] === "get") {
  const content = readConfig();
  if (content === null) {
    process.stderr.write("No config file found\n");
    process.exit(1);
  }
  if (/^\[[^\]\n]*$/m.test(content)) {
    process.stderr.write("Config parse error: TOML parse error: unclosed table, expected `]`\n");
    process.exit(1);
  }
  const key = rest[1];
  const match = content.match(new RegExp(`^${key.split(".").pop()}\\s*=\\s*"?([^"\\n]*)"?`, "m"));
  if (!match) {
    process.stderr.write(`Key not found: ${key}\n`);
    process.exit(1);
  }
  process.stdout.write(`${match[1]}\n`);
  process.exit(0);
}

if (command !== "start") {
  process.stderr.write(`fake-daemon: unsupported command ${command}\n`);
  process.exit(2);
}

const [host, port] = (process.env.OPENFANG_LISTEN || "127.0.0.1:4200").split(":");
const apiKey = process.env.OPENFANG_API_KEY || "";
const failFile = process.env.FAKE_HEALTH_FAIL_FILE || "";
const delay = Number(process.env.FAKE_DAEMON_DELAY_MS || 0);

function authorized(req) {
  const url = new URL(req.url, "http://x");
  return req.headers.authorization === `Bearer ${apiKey}` || url.searchParams.get("token") === apiKey;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/health") {
    if (failFile && fs.existsSync(failFile)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"status":"error"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok","version":"fake"}');
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}');
    return;
  }
  if (url.pathname === "/api/echo") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body, env: { OPENFANG_LISTEN: process.env.OPENFANG_LISTEN, PORT: process.env.PORT ?? null, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? null } }));
    });
    return;
  }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`data: tick ${n}\n\n`);
      if (n === 3) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>fake dashboard</body></html>");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  if (!authorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", (frame) => {
    // Decode one masked text frame and echo it back unmasked.
    const len = frame[1] & 0x7f;
    const mask = frame.subarray(2, 6);
    const payload = Buffer.from(frame.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
    const header = Buffer.from([0x81, payload.length]);
    socket.write(Buffer.concat([header, payload]));
  });
  socket.on("error", () => {});
});

setTimeout(() => {
  server.listen(Number(port), host, () => process.stdout.write(`fake openfang listening on ${host}:${port}\n`));
}, delay);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    process.stdout.write(`fake openfang got ${sig}, exiting\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  });
}
