import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveUserPath } from "../../ui.js";

/** Facts about the local OpenClaw installation used by `agenr init`. */
export interface OpenClawDetection {
  /** Whether OpenClaw looks installed enough to offer plugin onboarding. */
  detected: boolean;
  /** OpenClaw state directory used for config and session discovery. */
  stateDir: string;
  /** OpenClaw JSON config path inside the state directory. */
  configPath: string;
  /** Root directory scanned for session transcript files. */
  sessionsRoot: string;
  /** Whether detection came from environment overrides or the default path. */
  source: "environment" | "default";
}

/**
 * Resolves the default OpenClaw state directory for the current user.
 *
 * @returns Absolute default OpenClaw state dir.
 */
export function resolveDefaultOpenClawStateDir(): string {
  return path.join(os.homedir(), ".openclaw");
}

/**
 * Detects whether OpenClaw is present and where its state lives.
 *
 * @param env - Environment used to resolve optional OpenClaw overrides.
 * @param existsSyncFn - Injectable filesystem existence check for tests.
 * @returns Detection facts used by the init wizard.
 */
export function detectOpenClawInstallation(
  env: NodeJS.ProcessEnv = process.env,
  existsSyncFn: (targetPath: string) => boolean = fs.existsSync,
): OpenClawDetection {
  const envStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR) ?? normalizeOptionalString(env.OPENCLAW_HOME);
  const source = envStateDir ? "environment" : "default";
  const stateDir = envStateDir ? resolveUserPath(envStateDir) : resolveDefaultOpenClawStateDir();

  return {
    detected: envStateDir !== undefined || existsSyncFn(stateDir),
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    sessionsRoot: path.join(stateDir, "agents"),
    source,
  };
}

/** Normalizes optional string values into trimmed non-empty strings. */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
