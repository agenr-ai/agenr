import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const OPENCLAW_PLUGIN_PACKAGE = "@agenr/openclaw-plugin";

/** Result from an OpenClaw CLI action triggered by init. */
export interface ExternalCommandResult {
  /** Whether the action completed successfully enough to continue. */
  success: boolean;
  /** Human-readable status message for CLI display. */
  message: string;
}

/** Minimal plugin config values persisted into `openclaw.json`. */
export interface OpenClawPluginConfigInput {
  /** Agenr database path used by the plugin. */
  dbPath: string;
  /** Optional explicit agenr config path when not adjacent to the database. */
  configPath?: string;
}

/** String-keyed JSON object used while mutating `openclaw.json`. */
type JsonRecord = Record<string, unknown>;

/**
 * Runs a child process asynchronously while capturing stdout and stderr.
 *
 * @param command - Executable to run.
 * @param args - CLI args for the executable.
 * @param options - Runtime options for the spawned process.
 * @returns Captured stdout and stderr strings.
 */
export function execAsync(
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const message = [String(stderr ?? "").trim(), error.message].filter((value) => value.length > 0).join("\n");
        reject(new Error(message || error.message));
        return;
      }

      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/**
 * Finds an executable on the current PATH.
 *
 * @param name - Executable name to resolve.
 * @returns Absolute executable path when found, otherwise `null`.
 */
export function findBinaryPath(name: string): string | null {
  try {
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    const output = execFileSync(lookupCommand, [name], { encoding: "utf8" }).trim();
    const firstLine = output.split("\n")[0]?.trim();
    return firstLine && firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

/**
 * Installs the agenr OpenClaw plugin using the local OpenClaw CLI.
 *
 * @param spec - Path or package spec passed to `openclaw plugins install`.
 * @returns Install result with a user-facing status message.
 */
export async function installOpenClawPlugin(spec = OPENCLAW_PLUGIN_PACKAGE): Promise<ExternalCommandResult> {
  const openclawBin = findBinaryPath("openclaw");
  if (!openclawBin) {
    return {
      success: false,
      message: `OpenClaw was detected, but the \`openclaw\` CLI is not on PATH. Install the plugin later with \`openclaw plugins install ${OPENCLAW_PLUGIN_PACKAGE}\`.`,
    };
  }

  try {
    await execAsync(openclawBin, ["plugins", "install", spec], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env },
    });
    return {
      success: true,
      message: "agenr plugin installed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already exists") || message.toLowerCase().includes("already installed")) {
      return {
        success: true,
        message: "agenr plugin already installed",
      };
    }

    return {
      success: false,
      message: `Plugin install failed: ${message}`,
    };
  }
}

/**
 * Restarts the OpenClaw gateway service when the CLI is available.
 *
 * @returns Restart result with a user-facing status message.
 */
export async function restartOpenClawGateway(): Promise<ExternalCommandResult> {
  const openclawBin = findBinaryPath("openclaw");
  if (!openclawBin) {
    return {
      success: false,
      message: "OpenClaw CLI not found on PATH. Restart the gateway manually with `openclaw gateway restart`.",
    };
  }

  try {
    await execAsync(openclawBin, ["gateway", "restart"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env },
    });
    return {
      success: true,
      message: "OpenClaw gateway restarted",
    };
  } catch {
    try {
      await execAsync(openclawBin, ["gateway", "start"], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env },
      });
      return {
        success: true,
        message: "OpenClaw gateway started",
      };
    } catch {
      return {
        success: false,
        message: "OpenClaw gateway needs a manual restart: `openclaw gateway restart`.",
      };
    }
  }
}

/**
 * Writes agenr's OpenClaw plugin config into the user's `openclaw.json`.
 *
 * This enables the plugin entry, selects it as the active memory slot, and
 * stores the agenr DB/config paths needed by the adapter runtime.
 *
 * @param stateDir - OpenClaw state dir containing `openclaw.json`.
 * @param config - Agenr plugin config values to persist.
 * @returns The `openclaw.json` path that was updated.
 */
export async function writeOpenClawPluginConfig(stateDir: string, config: OpenClawPluginConfigInput): Promise<string> {
  const openclawConfigPath = path.join(stateDir, "openclaw.json");
  let root: JsonRecord = {};

  try {
    const raw = await fs.readFile(openclawConfigPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      root = parsed;
    }
  } catch {
    root = {};
  }

  const plugins = ensureRecord(root, "plugins");
  const allow = ensureArrayOfStrings(plugins, "allow");
  if (!allow.includes("agenr")) {
    allow.push("agenr");
  }

  const slots = ensureRecord(plugins, "slots");
  slots.memory = "agenr";

  const entries = ensureRecord(plugins, "entries");
  const agenrEntry = ensureRecord(entries, "agenr");
  agenrEntry.enabled = true;

  const entryConfig = ensureRecord(agenrEntry, "config");
  entryConfig.dbPath = config.dbPath;

  const normalizedConfigPath = config.configPath?.trim();
  if (normalizedConfigPath && shouldPersistPluginConfigPath(config.dbPath, normalizedConfigPath)) {
    entryConfig.configPath = normalizedConfigPath;
  } else {
    delete entryConfig.configPath;
  }

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(openclawConfigPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return openclawConfigPath;
}

/** Returns whether the plugin needs an explicit config path. */
function shouldPersistPluginConfigPath(dbPath: string, configPath: string): boolean {
  return path.dirname(dbPath) !== path.dirname(configPath);
}

/** Type guard for plain JSON objects. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ensures one nested object exists on the supplied record. */
function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  const value = target[key];
  if (isRecord(value)) {
    return value;
  }

  const created: JsonRecord = {};
  target[key] = created;
  return created;
}

/** Ensures one nested string-array exists on the supplied record. */
function ensureArrayOfStrings(target: JsonRecord, key: string): string[] {
  const value = target[key];
  if (Array.isArray(value)) {
    const normalized = value.filter((entry): entry is string => typeof entry === "string");
    target[key] = normalized;
    return normalized;
  }

  const created: string[] = [];
  target[key] = created;
  return created;
}
