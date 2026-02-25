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

export function detectPlatforms(pathLookup: (command: string) => boolean = isOnPath): DetectedPlatform[] {
  const home = os.homedir();
  const isWindows = process.platform === "win32";

  const platforms: DetectedPlatform[] = [
    {
      id: "openclaw",
      label: "OpenClaw",
      detected: false,
      configDir: isWindows
        ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "openclaw")
        : path.join(home, ".openclaw"),
      sessionsDir: "",
    },
    {
      id: "codex",
      label: "Codex",
      detected: false,
      configDir: path.join(home, ".codex"),
      sessionsDir: "",
    },
  ];

  for (const platform of platforms) {
    platform.sessionsDir = path.join(platform.configDir, "sessions");
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
