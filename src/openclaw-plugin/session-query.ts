import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const EXCHANGE_TEXT_MAX_CHARS = 200;
const EXCHANGE_USER_TURN_LIMIT = 5;
const RECENT_TURN_MAX_CHARS = 150;
const SEMANTIC_SEED_PREVIOUS_TURNS_MAX_CHARS = 400;
const DEFAULT_RECENT_TURN_LIMIT = 7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractTextFromUserMessage(message: unknown): string {
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

export function extractTextFromAssistantMessage(message: unknown): string {
  if (!isRecord(message) || message["role"] !== "assistant") {
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

export function truncateMessageText(text: string, maxChars = EXCHANGE_TEXT_MAX_CHARS): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
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

export function extractLastExchangeText(messages: unknown[], maxTurns = EXCHANGE_USER_TURN_LIMIT): string {
  try {
    if (!Array.isArray(messages) || messages.length === 0) {
      return "";
    }
    if (maxTurns <= 0) {
      return "";
    }

    const collected: Array<{ role: "user" | "assistant"; text: string }> = [];
    let collectedUserTurns = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const userText = extractTextFromUserMessage(message);
      if (userText) {
        collected.push({ role: "user", text: truncateMessageText(userText) });
        collectedUserTurns += 1;
        if (collectedUserTurns >= maxTurns) {
          break;
        }
        continue;
      }

      const assistantText = extractTextFromAssistantMessage(message);
      if (assistantText) {
        collected.push({
          role: "assistant",
          text: truncateMessageText(assistantText),
        });
      }
    }

    if (collected.length === 0) {
      return "";
    }

    return collected
      .reverse()
      .map((turn) => `${turn.role === "user" ? "U" : "A"}: ${turn.text}`)
      .join(" | ");
  } catch {
    return "";
  }
}

export async function findPreviousSessionFile(
  sessionsDir: string,
  currentSessionId: string | undefined,
  logger?: { debug?: (msg: string) => void },
): Promise<string | null> {
  try {
    const normalizedSessionId = currentSessionId?.trim();
    const currentSessionFileName = normalizedSessionId ? `${normalizedSessionId}.jsonl` : undefined;
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const candidatePaths: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      if (entry.name.includes(".deleted.")) {
        continue;
      }
      if (currentSessionFileName && entry.name === currentSessionFileName) {
        continue;
      }
      candidatePaths.push(path.join(sessionsDir, entry.name));
    }

    if (candidatePaths.length === 0) {
      return null;
    }

    const statResults = await Promise.all(
      candidatePaths.map(async (filePath) => {
        try {
          const fileStats = await stat(filePath);
          return { filePath, mtimeMs: fileStats.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const candidates = statResults.filter(
      (result): result is { filePath: string; mtimeMs: number } => result !== null,
    );
    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.filePath ?? null;
  } catch (err) {
    logger?.debug?.(
      `[agenr] findPreviousSessionFile: failed to read sessions dir "${sessionsDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export async function extractRecentTurns(filePath: string, maxTurns = DEFAULT_RECENT_TURN_LIMIT): Promise<string> {
  try {
    if (!filePath) {
      return "";
    }
    const parsedMaxTurns = Number.isFinite(maxTurns) ? Math.max(0, Math.trunc(maxTurns)) : 0;
    if (parsedMaxTurns === 0) {
      return "";
    }
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) {
      return "";
    }

    const turns: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(record) || record["type"] !== "message") {
        continue;
      }
      const message = record["message"];
      const userText = extractTextFromUserMessage(message);
      if (userText) {
        turns.push(`U: ${truncateMessageText(userText, RECENT_TURN_MAX_CHARS)}`);
        continue;
      }
      const assistantText = extractTextFromAssistantMessage(message);
      if (assistantText) {
        turns.push(`A: ${truncateMessageText(assistantText, RECENT_TURN_MAX_CHARS)}`);
      }
    }

    if (turns.length === 0) {
      return "";
    }
    return turns.slice(-parsedMaxTurns).join(" | ");
  } catch {
    return "";
  }
}

export function buildSemanticSeed(
  previousTurns: string,
  firstUserMessage: string,
): string | undefined {
  const stripped = stripPromptMetadata(firstUserMessage).trim();
  // Minimum 5 words for user message to contribute signal to the seed.
  // Fewer than 5 words ("hey", "fix it", "on the other side") rarely carry enough
  // specificity to improve a recall query. Phase 1A transcript turns are the primary
  // seed - user message is additive signal on top.
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  const messageHasSignal = wordCount >= 5;

  const truncatedTurns = previousTurns.slice(0, SEMANTIC_SEED_PREVIOUS_TURNS_MAX_CHARS);

  if (truncatedTurns && messageHasSignal) {
    return `${truncatedTurns} ${stripped}`;
  }
  if (truncatedTurns) {
    return truncatedTurns;
  }
  if (messageHasSignal) {
    return stripped;
  }
  return undefined;
}
