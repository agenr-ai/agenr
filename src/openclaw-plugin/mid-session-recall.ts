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
  /^(?:do it|go ahead|ship it|sounds good|sounds like a plan|got it|makes sense|go for it|lgtm ship it|yes please|no thanks|that works|perfect thanks|will do|that(?:'|)s okay|one sec|one second|one moment|let me check|i(?:'|)ll take a look|let me see|hold on|brb|good call|fair enough|works for me|i(?:'|)m good|all good|no worries|no problem)$/i;
const TEMPORAL_PATTERNS =
  /\b(?:remember|remind|forgot|last time|last (?:week|month|year|night|session)|previously|earlier|the other day|a while ago|we decided|did we decide|have we|were we|you said|you told me|you mentioned|we discussed|we talked about|what was|who is|who was|who's|when did|how did|what happened)\b/i;
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
const MAX_QUERY_CHARS = 200;

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

export class RecentMessagesBuffer {
  private items: string[] = [];

  get length(): number {
    return this.items.length;
  }

  push(...messages: string[]): void {
    for (const msg of messages) {
      const normalized = normalizeBufferedMessage(msg);
      if (!normalized) {
        continue;
      }
      this.items.push(normalized);
    }
    while (this.items.length > MAX_RECENT_MESSAGES) {
      this.items.shift();
    }
  }

  slice(start?: number, end?: number): string[] {
    return this.items.slice(start, end);
  }

  toArray(): string[] {
    return [...this.items];
  }

  [Symbol.iterator](): Iterator<string> {
    return this.items[Symbol.iterator]();
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

  const words = trimmed
    .split(/\s+/)
    .map((word) => word.replace(/^[.!?,;:]+|[.!?,;:]+$/g, ""))
    .filter(Boolean);
  const wordCount = words.length;
  const lower = trimmed.toLowerCase();
  const stripped = lower.replace(/[.!?,;:]+$/g, "");
  const hasExplicitRecall = EXPLICIT_RECALL.test(trimmed);
  const hasTemporalPattern = TEMPORAL_PATTERNS.test(trimmed);
  const entityCount = countEntities(trimmed);

  if (wordCount === 1) {
    if (TRIVIAL_EXACT.has(stripped)) {
      return "trivial";
    }
    if (/^\d+$/.test(trimmed)) {
      return "trivial";
    }
    if (isSingleEmoji(trimmed)) {
      return "trivial";
    }
    if (entityCount > 0) {
      return "normal";
    }
    return "trivial";
  }

  if (TRIVIAL_PHRASES.test(stripped)) {
    return "trivial";
  }
  if (wordCount <= 3 && entityCount === 0) {
    return "trivial";
  }
  if (
    wordCount <= 8 &&
    entityCount === 0 &&
    !hasTemporalPattern &&
    !hasExplicitRecall &&
    !trimmed.endsWith("?")
  ) {
    return "trivial";
  }

  if (hasExplicitRecall) {
    return "complex";
  }
  if (hasTemporalPattern) {
    return "complex";
  }
  if (wordCount <= 6 && entityCount > 0) {
    return "complex";
  }
  if (entityCount >= 2) {
    return "complex";
  }
  if (wordCount > 6 && entityCount === 0 && !hasTemporalPattern && !hasExplicitRecall) {
    return "normal";
  }

  return "normal";
}

export function buildQuery(message: string): string {
  if (typeof message !== "string") {
    return "";
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.slice(0, MAX_QUERY_CHARS);
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
  if (queryTokens.size < 2) {
    return false;
  }
  if (!lastQuery) {
    return true;
  }
  const lastQueryTokens = tokenizeForSimilarity(lastQuery);
  return jaccardSimilarity(queryTokens, lastQueryTokens) <= threshold;
}

export interface MidSessionState {
  recentMessages: RecentMessagesBuffer;
  lastRecallQuery: string | null;
  recalledIds: Set<string>;
  turnCount: number;
  lastStoreTurn: number;
  nudgeCount: number;
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
      lastStoreTurn: 0,
      nudgeCount: 0,
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
    lastStoreTurn: 0,
    nudgeCount: 0,
  };
  midSessionStates.set(normalizedKey, nextState);
  return nextState;
}

export function markStoreCall(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    return;
  }
  const state = getMidSessionState(key);
  state.lastStoreTurn = state.turnCount;
}

export function clearMidSessionStates(): void {
  midSessionStates.clear();
}

export function clearMidSessionState(key: string): void {
  midSessionStates.delete(key.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
