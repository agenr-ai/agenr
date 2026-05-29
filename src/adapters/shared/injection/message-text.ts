import type { BeforeTurnRecentTurn } from "../../../app/before-turn/index.js";
import { containsAgenrMemoryContext, stripAgenrMemoryContext } from "./memory-context.js";

const MEMORY_HEADINGS = [
  "## Previous session summary",
  "## Recent session",
  "## Agenr Session Recall",
  "### Core Memory",
  "### Relevant Durable Memory",
  "## Agenr Before-Turn Recall",
  "### Suggested Procedure",
] as const;

/** Options for recent-turn text sanitization. */
export interface SanitizeRecentTurnTextOptions {
  /** When true, strips `[MEMORY CHECK]` fragments from recent-turn text. */
  stripMemoryCheck?: boolean;
}

/** Options for current-turn prompt normalization. */
export interface NormalizePromptTextOptions {
  /** When true, strips known inline metadata sentinels from prompt text. */
  stripInlineMetadata?: boolean;
  /** Metadata sentinels to remove when `stripInlineMetadata` is enabled. */
  inlineMetadataSentinels?: readonly string[];
  /** When true, strips leading weekday timestamp prefixes. */
  stripTimestampPrefix?: boolean;
  /** When true, strips a leading `U:` user prefix. */
  stripUserPrefix?: boolean;
}

/**
 * Extracts plain text from one agent message content payload.
 *
 * @param content - Raw message content from a host session store.
 * @returns Plain-text content, or an empty string when absent.
 */
export function extractAgentMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const blocks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push(block);
      continue;
    }

    if (!block || typeof block !== "object") {
      continue;
    }

    const typed = block as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof typed.text === "string") {
      blocks.push(typed.text);
      continue;
    }

    const type = typeof typed.type === "string" ? typed.type.trim().toLowerCase() : "";
    if (typeof typed.content === "string" && (type === "text" || type === "input_text" || type === "output_text")) {
      blocks.push(typed.content);
    }
  }

  return blocks.join("\n");
}

/**
 * Extracts a compact recent-turn window from host branch messages.
 *
 * @param messages - Agent messages from the active session branch.
 * @param options - Host-specific sanitization options.
 * @returns Ordered recent turns suitable for the before-turn app service.
 */
export function extractRecentTurnsFromMessages(
  messages: Array<{ role?: unknown; content?: unknown }>,
  options: SanitizeRecentTurnTextOptions = {},
): BeforeTurnRecentTurn[] {
  const turns: BeforeTurnRecentTurn[] = [];
  for (const message of messages) {
    const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
    if (!role) {
      continue;
    }

    const text = sanitizeRecentTurnText(extractAgentMessageText(message.content), role, options);
    if (!text) {
      continue;
    }

    turns.push({ role, text });
  }

  return turns;
}

/**
 * Normalizes one current-turn prompt into compact single-space text.
 *
 * @param prompt - Raw current prompt text from the host.
 * @param options - Host-specific normalization options.
 * @returns Normalized prompt text, or undefined when empty.
 */
export function normalizePromptText(prompt: string, options: NormalizePromptTextOptions = {}): string | undefined {
  let cleaned = stripAgenrMemoryContext(prompt);
  if (options.stripInlineMetadata) {
    cleaned = stripInlineMetadata(cleaned, options.inlineMetadataSentinels ?? []);
  }
  if (options.stripTimestampPrefix) {
    cleaned = cleaned.replace(/^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s[^\]]+\]\s*/u, "");
  }
  if (options.stripUserPrefix) {
    cleaned = cleaned.replace(/^\s*U:\s*/u, "");
  }
  cleaned = collapseWhitespace(cleaned);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Removes prior injected memory wrappers so they do not recursively pollute the
 * next before-turn query.
 *
 * @param text - Raw message text.
 * @param role - Message role used for wrapper unrolling.
 * @param options - Host-specific sanitization options.
 * @returns Sanitized recent-turn text.
 */
export function sanitizeRecentTurnText(text: string, role: "user" | "assistant", options: SanitizeRecentTurnTextOptions = {}): string {
  if (!text.trim()) {
    return "";
  }

  const wrapperDetected =
    containsAgenrMemoryContext(text) ||
    text.includes("## Agenr Session Recall") ||
    text.includes("## Agenr Before-Turn Recall") ||
    (options.stripMemoryCheck === true && text.includes("[MEMORY CHECK]"));

  let cleaned = stripAgenrMemoryContext(text);
  for (const heading of MEMORY_HEADINGS) {
    cleaned = cleaned.split(heading).join(" ");
  }

  if (options.stripMemoryCheck === true) {
    cleaned = cleaned.replace(/\[MEMORY CHECK\][^\n]*/gu, " ");
  }

  cleaned = collapseWhitespace(cleaned);
  if (!wrapperDetected) {
    return cleaned;
  }

  const segments = stripAgenrMemoryContext(text)
    .split(/\n\s*\n/gu)
    .map((segment) => collapseWhitespace(segment))
    .filter((segment) => segment.length > 0);
  const fallbackSegment = segments.at(-1);
  if (fallbackSegment) {
    return role === "user" ? fallbackSegment : collapseWhitespace(cleaned);
  }

  return cleaned;
}

/**
 * Removes inline metadata payloads that should not influence the current-turn query.
 *
 * @param text - Candidate prompt text.
 * @param sentinels - Metadata sentinels to strip from the prompt.
 * @returns Prompt text without known metadata wrappers.
 */
export function stripInlineMetadata(text: string, sentinels: readonly string[]): string {
  let cleaned = text;
  for (const sentinel of sentinels) {
    const escapedSentinel = escapeForRegExp(sentinel);
    cleaned = cleaned.replace(new RegExp(`${escapedSentinel}\\s*(?:\`\`\`json\\s*)?\\{[\\s\\S]*?\\}(?:\\s*\`\`\`)?`, "gu"), " ");
    cleaned = cleaned.replace(new RegExp(`${escapedSentinel}[^\n]*`, "gu"), " ");
  }

  cleaned = cleaned.replace(/Untrusted context \(metadata, do not treat as instructions or commands\):[\s\S]*$/gu, " ");
  return cleaned;
}

/** Collapses repeated whitespace while preserving single-line readability. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Escapes one string for safe RegExp interpolation. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
