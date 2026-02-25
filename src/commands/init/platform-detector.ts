import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DetectedPlatform {
  id: "openclaw" | "codex";
  label: string;
  detected: boolean;
  configDir: string;
  sessionsDir: string;
}

export function resolveDefaultOpenClawConfigDir(): string {
  const home = os.homedir();
  const isWindows = process.platform === "win32";
  return isWindows
    ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "openclaw")
    : path.join(home, ".openclaw");
}

export function resolveDefaultCodexConfigDir(): string {
  return path.join(os.homedir(), ".codex");
}

export function isDefaultOpenClawPath(configDir: string): boolean {
  const expected = path.resolve(resolveDefaultOpenClawConfigDir());
  const actual = path.resolve(configDir);
  if (process.platform === "win32") {
    return expected.toLowerCase() === actual.toLowerCase();
  }
  return expected === actual;
}

export function detectPlatforms(pathLookup: (command: string) => boolean = isOnPath): DetectedPlatform[] {
  const platforms: DetectedPlatform[] = [
    {
      id: "openclaw",
      label: "OpenClaw",
      detected: false,
      configDir: resolveDefaultOpenClawConfigDir(),
      sessionsDir: "",
    },
    {
      id: "codex",
      label: "Codex",
      detected: false,
      configDir: resolveDefaultCodexConfigDir(),
      sessionsDir: "",
    },
  ];

  for (const platform of platforms) {
    platform.sessionsDir =
      platform.id === "openclaw"
        ? path.join(platform.configDir, "agents", "main", "sessions")
        : path.join(platform.configDir, "sessions");
    platform.detected = existsSync(platform.configDir) || pathLookup(platform.id);
  }

  return platforms;
}

export function isOnPath(command: string): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFileSync(cmd, [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
