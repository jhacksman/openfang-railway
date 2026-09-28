import crypto from "node:crypto";

import { ADMIN_PASSWORD, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, SESSION_TTL_SECONDS } from "./config.js";

export const COOKIE_NAME = "of_gate";

// Session signing key is derived from the admin password, so rotating the
// password invalidates every existing session.
const sessionKey = ADMIN_PASSWORD
  ? crypto.hkdfSync("sha256", ADMIN_PASSWORD, "openfang-railway-gate", "session-v1", 32)
  : null;

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function sign(payload) {
  return crypto.createHmac("sha256", Buffer.from(sessionKey)).update(payload).digest("base64url");
}

export function createSessionToken(now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const nonce = crypto.randomBytes(12).toString("base64url");
  const payload = `v1.${expires}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token, now = Date.now()) {
  if (!sessionKey || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const [version, expires, nonce, mac] = parts;
  const payload = `${version}.${expires}.${nonce}`;
  if (!timingSafeEqualString(sign(payload), mac)) return false;
  const expiresAt = Number.parseInt(expires, 10);
  return Number.isFinite(expiresAt) && expiresAt * 1000 > now;
}

export function parseCookies(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

export function stripCookie(header, name) {
  if (!header) return undefined;
  const kept = String(header)
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${name}=`));
  return kept.length ? kept.join("; ") : undefined;
}

export function sessionCookie(token, { secure, maxAge = SESSION_TTL_SECONDS } = {}) {
  const attrs = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie({ secure } = {}) {
  return sessionCookie("", { secure, maxAge: 0 });
}

export function verifyPassword(candidate) {
  if (!ADMIN_PASSWORD || typeof candidate !== "string") return false;
  return timingSafeEqualString(candidate, ADMIN_PASSWORD);
}

// Bearer / X-API-Key / ?token= credentials presented directly by API clients.
export function extractApiCredential(req, url) {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();
  const token = url.searchParams.get("token");
  return token && token.trim() ? token.trim() : null;
}

const failures = new Map();

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

export function loginAllowed(ip, now = Date.now()) {
  const entry = failures.get(ip);
  if (!entry) return true;
  if (now - entry.first > LOGIN_WINDOW_MS) {
    failures.delete(ip);
    return true;
  }
  return entry.count < LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(ip, now = Date.now()) {
  const entry = failures.get(ip);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    failures.set(ip, { first: now, count: 1 });
  } else {
    entry.count += 1;
  }
  if (failures.size > 10000) failures.clear();
}

export function clearLoginFailures(ip) {
  failures.delete(ip);
}
