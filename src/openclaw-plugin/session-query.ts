export const SESSION_TOPIC_TTL_MS = 60 * 60 * 1000;
// Raised from 20 to 40 to filter trivial conversational closers.
export const SESSION_TOPIC_MIN_LENGTH = 40;
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

const sweepInterval = setInterval(sweepExpiredStash, 5 * 60 * 1000);
if (typeof sweepInterval.unref === "function") {
  sweepInterval.unref();
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
    return normalized;
  }
  return stashedText;
}

export function stashSessionTopic(sessionKey: string, text: string): void {
  // Keep an internal length guard so callers cannot bypass minimum quality.
  // Word-count checks are handled by shouldStashTopic at call sites.
  if (text.length < SESSION_TOPIC_MIN_LENGTH) {
    return;
  }
  sessionTopicStash.set(sessionKey, {
    text,
    storedAt: Date.now(),
  });
}

export function clearStash(): void {
  sessionTopicStash.clear();
}
