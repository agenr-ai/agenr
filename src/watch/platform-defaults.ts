import os from "node:os";
import path from "node:path";
import type { WatchPlatform } from "./resolvers/index.js";

export function getDefaultPlatformDir(platform: WatchPlatform, homeDir = os.homedir()): string {
  if (platform === "openclaw") {
    return path.join(homeDir, ".openclaw", "agents", "main", "sessions");
  }
  if (platform === "codex") {
    return path.join(homeDir, ".codex", "sessions");
  }
  if (platform === "claude-code") {
    return path.join(homeDir, ".claude", "projects");
  }

  throw new Error(`No default directory for platform: ${platform}`);
}

