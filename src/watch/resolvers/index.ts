import type { SessionResolver } from "../session-resolver.js";
import { claudeCodeSessionResolver } from "./claude-code.js";
import { codexSessionResolver } from "./codex.js";
import { mtimeResolver } from "./mtime.js";
import { openClawSessionResolver } from "./openclaw.js";

export type WatchPlatform = "openclaw" | "claude-code" | "codex" | "mtime";

export function normalizePlatform(value: string): WatchPlatform | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openclaw") {
    return "openclaw";
  }
  if (normalized === "claude-code" || normalized === "claude") {
    return "claude-code";
  }
  if (normalized === "codex") {
    return "codex";
  }
  if (normalized === "mtime" || normalized === "generic") {
    return "mtime";
  }
  return null;
}

function detectPlatformFromDir(dir?: string): WatchPlatform {
  const normalized = (dir ?? "").replace(/\\/g, "/").toLowerCase();

  if (normalized.includes("/.openclaw/")) {
    return "openclaw";
  }
  if (normalized.includes("/.claude/")) {
    return "claude-code";
  }
  if (normalized.includes("/.codex/")) {
    return "codex";
  }
  return "mtime";
}

const RESOLVER_REGISTRY: Record<WatchPlatform, SessionResolver> = {
  openclaw: openClawSessionResolver,
  "claude-code": claudeCodeSessionResolver,
  codex: codexSessionResolver,
  mtime: mtimeResolver,
};

export function getResolver(platform?: string, dir?: string): SessionResolver {
  if (platform && platform.trim().length > 0) {
    const normalized = normalizePlatform(platform);
    if (!normalized) {
      throw new Error(`Unsupported platform: ${platform}. Expected one of: openclaw, claude-code, codex, mtime.`);
    }
    return RESOLVER_REGISTRY[normalized];
  }

  const detected = detectPlatformFromDir(dir);
  return RESOLVER_REGISTRY[detected];
}

export function detectWatchPlatform(platform?: string, dir?: string): WatchPlatform {
  if (platform && platform.trim().length > 0) {
    const normalized = normalizePlatform(platform);
    if (!normalized) {
      throw new Error(`Unsupported platform: ${platform}. Expected one of: openclaw, claude-code, codex, mtime.`);
    }
    return normalized;
  }

  return detectPlatformFromDir(dir);
}
