import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(childProcess.execFile);

import {
  BACKUP_DIR,
  BACKUP_KEEP,
  CONFIG_PATH,
  GATE_STATE_DIR,
  OPENFANG_BIN,
  OPENFANG_HOME,
  SEED,
  STATE_PATH,
  TEMPLATE_VERSION,
} from "./config.js";
import { log } from "./log.js";

export const SCHEMA_VERSION = 1;

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderSeedConfig(seed = SEED) {
  return [
    "# OpenFang configuration (persistent volume).",
    "# Written once by the openfang-railway gate on first boot; never rewritten.",
    "# The dashboard and `openfang config set` edit this file in place.",
    "# api_listen and api_key come from the OPENFANG_LISTEN / OPENFANG_API_KEY",
    "# environment variables managed by the template.",
    "",
    `log_level = ${tomlString(seed.logLevel)}`,
    "",
    "[default_model]",
    `provider = ${tomlString(seed.provider)}`,
    `model = ${tomlString(seed.model)}`,
    `api_key_env = ${tomlString(seed.apiKeyEnv)}`,
    "",
  ].join("\n");
}

export async function atomicWrite(filePath, content, mode = 0o600) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  const handle = await fsp.open(tmp, "w", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, filePath);
}

export async function readState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export async function writeState(state) {
  await fsp.mkdir(GATE_STATE_DIR, { recursive: true, mode: 0o700 });
  await atomicWrite(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export async function backupConfig(reason) {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `config.toml.${stamp}.${reason}`);
  await fsp.copyFile(CONFIG_PATH, target);
  await fsp.chmod(target, 0o600);
  const entries = (await fsp.readdir(BACKUP_DIR)).filter((n) => n.startsWith("config.toml.")).sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP))) {
    await fsp.rm(path.join(BACKUP_DIR, stale), { force: true });
  }
  return target;
}

// `openfang config get` resolves config.toml from OPENFANG_HOME, so the file's
// directory is passed as the home for the probe. Resolves to
// { status, stdout, stderr, error } and never throws.
async function configGet(configPath, key) {
  try {
    const { stdout, stderr } = await execFile(OPENFANG_BIN, ["config", "get", key], {
      env: { ...process.env, OPENFANG_HOME: path.dirname(configPath), NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { status: 0, stdout, stderr, error: null };
  } catch (err) {
    return {
      status: typeof err.code === "number" ? err.code : null,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      error: typeof err.code === "string" ? err.code : err.killed ? "TIMEOUT" : null,
    };
  }
}

function cleanOutput(result) {
  return `${result.stdout || ""}${result.stderr || ""}`
    .split(/\r?\n/)
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);
}

// Validates a config file with the same parser the daemon uses, without
// re-implementing TOML here. Only a reported parse error marks the file
// invalid; a missing key is fine, and an unusable binary leaves the file
// "unverified" so the supervisor's own restart loop surfaces that problem.
export async function validateConfigFile(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) return { ok: true, error: null, missing: true };
  const result = await configGet(configPath, "log_level");
  if (result.error) return { ok: true, error: null, unverified: `cannot run openfang: ${result.error}` };
  if (result.status === 0) return { ok: true, error: null };
  const detail = cleanOutput(result);
  if (/Key not found/i.test(detail)) return { ok: true, error: null };
  if (/parse error|TOML|invalid|expected/i.test(detail)) return { ok: false, error: detail };
  return { ok: true, error: null, unverified: detail || `openfang exited with status ${result.status}` };
}

export async function readConfigValue(key, configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) return null;
  const result = await configGet(configPath, key);
  if (result.error || result.status !== 0) return null;
  const value = String(result.stdout || "").trim();
  return value || null;
}

// Runs versioned, idempotent migrations. v0 -> v1 seeds config.toml when the
// volume is empty. An existing config.toml is never rewritten by the gate.
export async function migrate() {
  await fsp.mkdir(OPENFANG_HOME, { recursive: true });
  const previous = (await readState()) || { schema: 0 };
  let schema = Number(previous.schema) || 0;
  const now = new Date().toISOString();

  if (schema < 1) {
    if (!fs.existsSync(CONFIG_PATH)) {
      await atomicWrite(CONFIG_PATH, renderSeedConfig());
      log("gate", `seeded ${CONFIG_PATH} (provider=${SEED.provider} model=${SEED.model})`);
    } else {
      log("gate", `existing ${CONFIG_PATH} adopted without changes`);
      await backupConfig("adopt");
    }
    schema = 1;
  }

  const state = {
    schema,
    first_boot_at: previous.first_boot_at || now,
    last_boot_at: now,
    template_version: TEMPLATE_VERSION,
    previous_template_version: previous.template_version || null,
  };
  await writeState(state);
  return state;
}
