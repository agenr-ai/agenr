type MessageClassification = "trivial" | "normal" | "complex";

const TRIVIAL_EXACT = new Set([
  "yes",
  "no",
  "yep",
  "nope",
  "yeah",
  "nah",
  "ok",
  "okay",
  "k",
  "sure",
  "thanks",
  "ty",
  "thx",
  "nice",
  "cool",
  "great",
  "awesome",
  "lol",
  "haha",
  "wow",
  "hmm",
  "hm",
  "ah",
  "oh",
  "yikes",
  "done",
  "agreed",
  "correct",
  "right",
  "true",
  "false",
  "lgtm",
  "sgtm",
  "wfm",
  "ack",
  "np",
  "nvm",
]);

const TRIVIAL_PHRASES =
  /^(?:do it|go ahead|ship it|sounds good|got it|makes sense|go for it|lgtm ship it|yes please|no thanks|that works|perfect thanks|will do)$/i;
const TEMPORAL_PATTERNS =
  /\b(?:remember|remind|forgot|last time|last (?:week|month|year|night|session)|before|previously|earlier|the other day|a while ago|we decided|did we decide|have we|were we|you said|you told me|you mentioned|we discussed|we talked about|what was|who is|who was|who's|when did|how did|what happened)\b/i;
const EXPLICIT_RECALL =
  /\b(?:tell me about|what do you know about|what do we know about|can you recall|do you remember|remind me|fill me in on|catch me up|what's the (?:deal|story|status) with)\b/i;

const ENTITY_PATTERNS = [
  /\b[A-Z][a-z]{2,}\b/,
  /\b(?:PR|issue|ticket|bug)\s*#?\d+\b/i,
  /\b[a-z][\w-]*\/[a-z][\w-]*/,
  /\b(?:https?:\/\/)\S+/,
  /\b[A-Z]{2,}\b/,
];

const FALSE_POSITIVE_NOUNS = new Set([
  "How",
  "What",
  "When",
  "Where",
  "Why",
  "Who",
  "Which",
  "Can",
  "Could",
  "Would",
  "Should",
  "Will",
  "Does",
  "Did",
  "The",
  "This",
  "That",
  "There",
  "These",
  "Those",
  "Have",
  "Has",
  "Had",
  "Are",
  "Were",
  "Was",
  "Not",
  "But",
  "And",
  "Also",
  "Just",
  "Let",
  "Hey",
  "Hello",
  "Sure",
  "Yes",
  "Yeah",
  "Thanks",
  "So",
  "Now",
  "Well",
  "Still",
  "Yet",
  "Here",
  "If",
  "Or",
  "For",
  "From",
  "Into",
  "With",
  "About",
  "After",
  "Before",
  "Your",
  "Our",
  "My",
  "His",
  "Her",
  "Its",
  "Their",
  "Some",
  "Any",
  "All",
  "Each",
  "Every",
  "Most",
  "Many",
  "Much",
  "Very",
  "Too",
  "More",
]);

const MAX_RECENT_MESSAGES = 5;
const MAX_BUFFERED_MESSAGE_CHARS = 200;

function normalizeBufferedMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length > MAX_BUFFERED_MESSAGE_CHARS) {
    return trimmed.slice(0, MAX_BUFFERED_MESSAGE_CHARS);
  }
  return trimmed;
}

class RecentMessagesBuffer extends Array<string> {
  push(...items: string[]): number {
    for (const item of items) {
      const normalized = normalizeBufferedMessage(item);
      if (!normalized) {
        continue;
      }
      super.push(normalized);
    }
    while (this.length > MAX_RECENT_MESSAGES) {
      super.shift();
    }
    return this.length;
  }
}

function toGlobalPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function normalizeToken(token: string): string {
  return token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

function collectEntities(text: string): Set<string> {
  const entities = new Set<string>();

  for (const pattern of ENTITY_PATTERNS) {
    const matcher = toGlobalPattern(pattern);
    const matches = text.match(matcher);
    if (!matches) {
      continue;
    }
    for (const rawMatch of matches) {
      const normalized = normalizeToken(rawMatch);
      if (!normalized) {
        continue;
      }
      if (FALSE_POSITIVE_NOUNS.has(normalized)) {
        continue;
      }
      entities.add(normalized.toLowerCase());
    }
  }

  return entities;
}

function containsEntity(text: string): boolean {
  return collectEntities(text).size > 0;
}

function countEntities(text: string): number {
  return collectEntities(text).size;
}

function isSingleEmoji(text: string): boolean {
  return /^[\p{Emoji}\s]+$/u.test(text);
}

export function classifyMessage(text: string): MessageClassification {
  const trimmed = text.trim();
  if (!trimmed) {
    return "trivial";
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lower = trimmed.toLowerCase();

  if (wordCount === 1) {
    if (TRIVIAL_EXACT.has(lower)) {
      return "trivial";
    }
    if (/^\d+$/.test(trimmed)) {
      return "trivial";
    }
    if (isSingleEmoji(trimmed)) {
      return "trivial";
    }
    if (containsEntity(trimmed)) {
      return "normal";
    }
    return "trivial";
  }

  if (TRIVIAL_PHRASES.test(trimmed)) {
    return "trivial";
  }
  if (wordCount <= 3 && !containsEntity(trimmed)) {
    return "trivial";
  }

  if (EXPLICIT_RECALL.test(trimmed)) {
    return "complex";
  }
  if (TEMPORAL_PATTERNS.test(trimmed)) {
    return "complex";
  }
  if (wordCount <= 6 && containsEntity(trimmed)) {
    return "complex";
  }
  if (countEntities(trimmed) >= 2) {
    return "complex";
  }

  return "normal";
}

function isStopWordMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (TRIVIAL_EXACT.has(normalized)) {
    return true;
  }
  return TRIVIAL_PHRASES.test(normalized);
}

function extractKeyTerms(text: string): string {
  const tokens = text.split(/\s+/).map(normalizeToken).filter(Boolean);
  const keyTerms = tokens.filter((token) => {
    if (token.length > 5) {
      return true;
    }
    if (/^[A-Z]/.test(token)) {
      return true;
    }
    return /[-_.]/.test(token) && token.length > 3;
  });
  return keyTerms.join(" ");
}

export function buildQuery(messages: string[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const meaningful = messages
    .map(normalizeBufferedMessage)
    .filter((message) => message.length > 0)
    .filter((message) => !isStopWordMessage(message));

  if (meaningful.length === 0) {
    return "";
  }

  const recentMessages = meaningful.slice(-2).join(" ");
  const olderMessages = meaningful
    .slice(0, -2)
    .map((message) => extractKeyTerms(message))
    .filter((value) => value.length > 0)
    .join(" ");

  return `${olderMessages} ${recentMessages}`.trim();
}

function tokenizeForSimilarity(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((token) => token.length > 0);
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const union = new Set<string>([...a, ...b]);
  if (union.size === 0) {
    return 1;
  }
  let intersectionCount = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersectionCount += 1;
    }
  }
  return intersectionCount / union.size;
}

export function shouldRecall(query: string, lastQuery: string | null, threshold: number): boolean {
  const queryTokens = tokenizeForSimilarity(query);
  if (queryTokens.size < 3) {
    return false;
  }
  if (!lastQuery) {
    return true;
  }
  const lastQueryTokens = tokenizeForSimilarity(lastQuery);
  return jaccardSimilarity(queryTokens, lastQueryTokens) <= threshold;
}

export interface MidSessionState {
  recentMessages: string[];
  lastRecallQuery: string | null;
  recalledIds: Set<string>;
  turnCount: number;
}

const midSessionStates = new Map<string, MidSessionState>();

export function getMidSessionState(key: string): MidSessionState {
  const normalizedKey = key.trim();
  if (normalizedKey.length === 0) {
    return {
      recentMessages: new RecentMessagesBuffer(),
      lastRecallQuery: null,
      recalledIds: new Set<string>(),
      turnCount: 0,
    };
  }

  const existing = midSessionStates.get(normalizedKey);
  if (existing) {
    return existing;
  }

  const nextState: MidSessionState = {
    recentMessages: new RecentMessagesBuffer(),
    lastRecallQuery: null,
    recalledIds: new Set<string>(),
    turnCount: 0,
  };
  midSessionStates.set(normalizedKey, nextState);
  return nextState;
}

export function clearMidSessionStates(): void {
  midSessionStates.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type MidSessionRecallRow = {
  subject: string;
  content: string;
};

function toRecallRow(item: unknown): MidSessionRecallRow | null {
  if (!isRecord(item)) {
    return null;
  }
  const rawEntry = item["entry"];
  if (!isRecord(rawEntry)) {
    return null;
  }
  const subject = typeof rawEntry["subject"] === "string" ? rawEntry["subject"].trim() : "";
  const content = typeof rawEntry["content"] === "string" ? rawEntry["content"].trim() : "";
  if (!subject || !content) {
    return null;
  }
  return { subject, content };
}

export function formatMidSessionRecall(results: unknown[]): string | undefined {
  if (!Array.isArray(results) || results.length === 0) {
    return undefined;
  }

  const rows = results.map((item) => toRecallRow(item)).filter((row): row is MidSessionRecallRow => row !== null);
  if (rows.length === 0) {
    return undefined;
  }

  const lines: string[] = ["## Recalled context", ""];
  for (const row of rows) {
    lines.push(`- [${row.subject}] ${row.content}`);
  }
  return lines.join("\n");
}
