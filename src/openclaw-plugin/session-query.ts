import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const SESSION_TOPIC_TTL_MS = 60 * 60 * 1000;
// Raised from 20 to 40 to filter trivial conversational closers.
export const SESSION_TOPIC_MIN_LENGTH = 40;
// Must exceed SESSION_TOPIC_TTL_MS (1h) to cover back-to-back sessions
export const ARCHIVED_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Number of most-recent user messages considered for query seed text.
const SESSION_QUERY_LOOKBACK = 3;

export type TopicStashEntry = {
  text: string;
  storedAt: number;
};

const sessionTopicStash = new Map<string, TopicStashEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextFromUserMessage(message: unknown): string {
  if (!isRecord(message) || message["role"] !== "user") {
    return "";
  }

  const content = message["content"];
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part["type"] !== "text") {
      continue;
    }
    const partText = part["text"];
    if (typeof partText !== "string") {
      continue;
    }
    const trimmed = partText.trim();
    if (trimmed) {
      textParts.push(trimmed);
    }
  }

  return textParts.join(" ").trim();
}

export function isThinPrompt(prompt: string): boolean {
  const trimmed = prompt.trim().toLowerCase();
  return trimmed === "" || trimmed === "/new" || trimmed === "/reset";
}

export function stripPromptMetadata(raw: string): string {
  if (!raw) {
    return "";
  }

  try {
    // Local regex (no g-flag state leak): matches OpenClaw timestamp prefixes.
    // Covers named abbreviations (CST, AEST) and offset-style (GMT+5, GMT-10).
    const pattern = /\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:[A-Z]{2,5}|GMT[+-]\d{1,2})\] /g;
    let lastMatchEnd = -1;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(raw)) !== null) {
      lastMatchEnd = match.index + match[0].length;
    }

    if (lastMatchEnd >= 0) {
      return raw.slice(lastMatchEnd).trim();
    }

    return raw.trim();
  } catch {
    return "";
  }
}

export function extractLastUserText(messages: unknown[]): string {
  try {
    const collected: string[] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const extracted = extractTextFromUserMessage(messages[index]);
      if (!extracted) {
        continue;
      }
      collected.push(extracted);
      if (collected.length >= SESSION_QUERY_LOOKBACK) {
        break;
      }
    }

    // reverse to restore chronological order (oldest first) before joining
    const joined = collected.reverse().join(" ").trim();
    return joined || "";
  } catch {
    return "";
  }
}

export async function readLatestArchivedUserMessages(
  sessionsDir: string,
  maxAgeMs = ARCHIVED_SESSION_MAX_AGE_MS,
): Promise<string[]> {
  try {
    const now = Date.now();
    const archivedFiles: Array<{ filePath: string; mtimeMs: number }> = [];
    const entries = await readdir(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(".reset.")) {
        continue;
      }
      const filePath = path.join(sessionsDir, entry.name);
      const fileStats = await stat(filePath);
      if (now - fileStats.mtimeMs > maxAgeMs) {
        continue;
      }
      archivedFiles.push({ filePath, mtimeMs: fileStats.mtimeMs });
    }

    if (archivedFiles.length === 0) {
      return [];
    }

    archivedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const best = archivedFiles[0];
    if (!best) {
      return [];
    }
    const raw = await readFile(best.filePath, "utf8");
    const userMessages: string[] = [];

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || parsed["type"] !== "message") {
        continue;
      }
      const text = extractTextFromUserMessage(parsed["message"]);
      if (!text) {
        continue;
      }
      userMessages.push(text);
    }

    return userMessages.slice(-SESSION_QUERY_LOOKBACK);
  } catch {
    return [];
  }
}

// Quality gate for deciding whether extracted topic text is stash eligible.
export function shouldStashTopic(text: string): boolean {
  if (text.length < SESSION_TOPIC_MIN_LENGTH) {
    return false;
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount >= 5;
}

function sweepExpiredStash(): void {
  const now = Date.now();
  for (const [key, entry] of sessionTopicStash) {
    if (now - entry.storedAt > SESSION_TOPIC_TTL_MS) {
      sessionTopicStash.delete(key);
    }
  }
}

export let sweepInterval: ReturnType<typeof setInterval> | undefined =
  setInterval(sweepExpiredStash, 5 * 60 * 1000);
if (sweepInterval !== undefined && typeof sweepInterval.unref === "function") {
  sweepInterval.unref();
}

function stripResetPrefix(prompt: string): string {
  const lower = prompt.toLowerCase();
  for (const cmd of ["/new", "/reset"]) {
    if (lower.startsWith(cmd + " ")) {
      return prompt.slice(cmd.length).trim();
    }
  }
  return prompt;
}

export function resolveSessionQuery(prompt: string | undefined, sessionKey?: string): string | undefined {
  let stashedText: string | undefined;
  if (sessionKey) {
    const entry = sessionTopicStash.get(sessionKey);
    if (entry) {
      sessionTopicStash.delete(sessionKey);
      const expired = Date.now() - entry.storedAt > SESSION_TOPIC_TTL_MS;
      if (!expired && entry.text.length > 0) {
        stashedText = entry.text;
      }
    }
  }

  const normalized = (prompt ?? "").trim();
  if (!isThinPrompt(normalized)) {
    const stripped = stripResetPrefix(normalized);
    if (!stashedText) {
      // No stash - use live prompt as-is.
      return stripped;
    }
    // Stash exists: blend when live prompt carries real signal; otherwise stash wins.
    if (shouldStashTopic(stripped)) {
      // High-signal live prompt: stash provides topic continuity, prompt appends new intent.
      return `${stashedText} ${stripped}`;
    }
    // Low-signal live prompt (short opener like "did the plugin fire?"): stash wins.
    return stashedText;
  }
  return stashedText;
}

export function stashSessionTopic(sessionKey: string, text: string): void {
  if (!shouldStashTopic(text)) {
    return;
  }
  sessionTopicStash.set(sessionKey, {
    text,
    storedAt: Date.now(),
  });
}

export function clearStash(): void {
  sessionTopicStash.clear();
  if (sweepInterval !== undefined) {
    clearInterval(sweepInterval);
    sweepInterval = undefined;
  }
}
