import type { Expiry, StoreEntryInput } from "../types.js";

const IMPORTANCE_TIER_MAP: Record<string, number> = {
  high: 8,
  standard: 6,
  low: 4,
};

const TYPE_ALIAS_MAP: Record<string, StoreEntryInput["type"]> = {
  fact: "fact",
  facts: "fact",
  decision: "decision",
  decisions: "decision",
  preference: "preference",
  preferences: "preference",
  lesson: "lesson",
  lessons: "lesson",
  event: "event",
  events: "event",
  relationship: "relationship",
  relationships: "relationship",
  todo: "todo",
  todos: "todo",
  task: "todo",
  tasks: "todo",
};

const EXPIRY_ALIAS_MAP: Record<string, Expiry> = {
  permanent: "permanent",
  perm: "permanent",
  temporary: "temporary",
  temp: "temporary",
  core: "core",
};

const BLOCKED_SUBJECTS = new Set([
  "user",
  "assistant",
  "human",
  "ai",
  "bot",
  "developer",
  "engineer",
  "maintainer",
  "team",
  "we",
  "the conversation",
  "this session",
  "the transcript",
]);

/**
 * Parsed extraction response with accepted entries and validation warnings.
 */
export interface ExtractionResponse {
  entries: StoreEntryInput[];
  warnings: string[];
}

/**
 * Parses and validates a raw extraction response into store-ready entries.
 *
 * @param raw - Raw JSON-compatible data returned by the extraction model.
 * @returns Valid entries plus warnings for rejected items.
 */
export function parseExtractionResponse(raw: unknown): ExtractionResponse {
  const warnings: string[] = [];
  const payload = coerceResponseObject(raw);

  if (!payload) {
    return {
      entries: [],
      warnings: ["Extraction response was not a valid JSON object."],
    };
  }

  if (!Array.isArray(payload.entries)) {
    return {
      entries: [],
      warnings: ['Extraction response must have an "entries" array.'],
    };
  }

  const entries: StoreEntryInput[] = [];
  for (const [index, value] of payload.entries.entries()) {
    const entry = parseEntry(value, index, warnings);
    if (entry) {
      entries.push(entry);
    }
  }

  return { entries, warnings };
}

function coerceResponseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(stripCodeFence(raw)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }

  return null;
}

function parseEntry(value: unknown, index: number, warnings: string[]): StoreEntryInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Dropped entry ${index + 1}: entry must be an object.`);
    return null;
  }

  const record = value as Record<string, unknown>;
  const type = coerceType(record.type);
  if (!type) {
    warnings.push(`Dropped entry ${index + 1}: invalid type.`);
    return null;
  }

  const subject = normalizeString(record.subject);
  if (!subject) {
    warnings.push(`Dropped entry ${index + 1}: subject is required.`);
    return null;
  }

  if (BLOCKED_SUBJECTS.has(subject.toLowerCase())) {
    warnings.push(`Dropped entry ${index + 1}: subject "${subject}" is blocked.`);
    return null;
  }

  const content = normalizeString(record.content);
  if (!content) {
    warnings.push(`Dropped entry ${index + 1}: content is required.`);
    return null;
  }

  if (content.length < 20) {
    warnings.push(`Dropped entry ${index + 1}: content must be at least 20 characters.`);
    return null;
  }

  const expiry = coerceExpiry(record.expiry, index, warnings);
  const sourceContext = coerceOptionalString(record.source_context);

  return {
    type,
    subject,
    content,
    importance: coerceImportance(record.importance),
    expiry,
    tags: coerceTags(record.tags),
    source_context: sourceContext,
  };
}

function coerceType(value: unknown): StoreEntryInput["type"] | null {
  if (typeof value !== "string") {
    return null;
  }

  return TYPE_ALIAS_MAP[normalizeToken(value)] ?? null;
}

function coerceImportance(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = normalizeToken(value);
    const mappedTier = IMPORTANCE_TIER_MAP[normalized];
    if (mappedTier !== undefined) {
      return mappedTier;
    }

    const parsed = Number(normalized);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) {
      return parsed;
    }
  }

  return 6;
}

function coerceExpiry(value: unknown, index: number, warnings: string[]): Exclude<Expiry, "core"> {
  if (typeof value !== "string") {
    return "temporary";
  }

  const normalized = EXPIRY_ALIAS_MAP[normalizeToken(value)];
  if (!normalized) {
    return "temporary";
  }

  if (normalized === "core") {
    warnings.push(`Entry ${index + 1}: expiry "core" is reserved and was changed to "temporary".`);
    return "temporary";
  }

  return normalized;
}

function coerceTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== "string") {
      continue;
    }

    const normalized = normalizeToken(tag);
    if (!normalized) {
      continue;
    }

    unique.add(normalized);
    if (unique.size === 4) {
      break;
    }
  }

  return Array.from(unique);
}

function coerceOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }

  const normalized = normalizeWhitespace(String(value));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? normalizeWhitespace(value) : "";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeToken(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]+?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}
