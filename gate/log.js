import { LOG_LIMIT } from "./config.js";

const recent = [];

const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?)[^\s"']{6,}/gi,
];

export function redact(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "$1[redacted]");
  return out;
}

export function log(scope, message) {
  const line = `${new Date().toISOString()} [${scope}] ${redact(message)}`;
  recent.push(line);
  if (recent.length > LOG_LIMIT) recent.splice(0, recent.length - LOG_LIMIT);
  (scope === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

export function recentLogs() {
  return recent.slice();
}
