import path from "node:path";

function envString(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : String(value).trim();
}

function envInt(name, fallback) {
  const raw = envString(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const OPENFANG_HOME = envString("OPENFANG_HOME", "/data");
export const CONFIG_PATH = path.join(OPENFANG_HOME, "config.toml");
export const GATE_STATE_DIR = path.join(OPENFANG_HOME, ".openfang-railway");
export const BACKUP_DIR = path.join(GATE_STATE_DIR, "backups");
export const STATE_PATH = path.join(GATE_STATE_DIR, "state.json");

export const PORT = envInt("PORT", 8080);
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT = envInt("OPENFANG_DAEMON_PORT", 4200);
export const DAEMON_LISTEN = `${DAEMON_HOST}:${DAEMON_PORT}`;
export const DAEMON_BASE_URL = `http://${DAEMON_LISTEN}`;
export const OPENFANG_BIN = envString("OPENFANG_BIN", "openfang");

export const ADMIN_PASSWORD = envString("ADMIN_PASSWORD");
export const ENV_API_KEY = envString("OPENFANG_API_KEY");
export const MIN_PASSWORD_LENGTH = 12;

export const SESSION_TTL_SECONDS = envInt("GATE_SESSION_TTL_HOURS", 168) * 3600;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const PROBE_INTERVAL_MS = envInt("GATE_PROBE_INTERVAL_MS", 2000);
export const PROBE_TIMEOUT_MS = 1500;
export const PROBE_STALE_MS = envInt("GATE_PROBE_STALE_MS", 10000);
export const SHUTDOWN_GRACE_MS = envInt("GATE_SHUTDOWN_GRACE_MS", 20000);
export const RESTART_BACKOFF_MIN_MS = 2000;
export const RESTART_BACKOFF_MAX_MS = 30000;
export const LOG_LIMIT = 200;
export const BACKUP_KEEP = 20;

// Seed-only values: written to config.toml on first boot when no config exists.
// Later changes to these variables do not rewrite an existing config.toml.
export const SEED = {
  provider: envString("OPENFANG_DEFAULT_PROVIDER", "anthropic"),
  model: envString("OPENFANG_DEFAULT_MODEL", "claude-sonnet-4-20250514"),
  apiKeyEnv: envString("OPENFANG_DEFAULT_API_KEY_ENV", "ANTHROPIC_API_KEY"),
  logLevel: envString("OPENFANG_LOG_LEVEL", "info"),
};

// Variables that belong to the gate and are never handed to the daemon.
export const GATE_ONLY_ENV = new Set(["ADMIN_PASSWORD", "GATE_SESSION_TTL_HOURS"]);

export const TEMPLATE_VERSION = envString("TEMPLATE_VERSION", "dev");
export const OPENFANG_VERSION = envString("OPENFANG_VERSION", "unknown");
