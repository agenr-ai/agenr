import type { KnowledgePlatform } from "./types.js";

export function normalizeKnowledgePlatform(value: string | undefined): KnowledgePlatform | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "openclaw") {
    return "openclaw";
  }
  if (normalized === "claude-code" || normalized === "claude") {
    return "claude-code";
  }
  if (normalized === "codex") {
    return "codex";
  }
  if (normalized === "plaud") {
    return "plaud";
  }
  return null;
}
