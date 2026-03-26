import type { TranscriptMessage } from "../../../core/types.js";
import { asRecord, getString } from "./tool-summarization.js";

/** Normalized OpenClaw message roles used during transcript parsing. */
export type OpenClawRole = "user" | "assistant" | "toolResult" | "system" | "unknown";

const TEXT_BLOCK_TYPES = new Set(["input_text", "output_text", "text"]);

/** Collapses whitespace to keep transcript text compact and stable. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Extracts normalized text blocks from mixed OpenClaw content arrays. */
function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const textBlocks: string[] = [];
  let nonTextBlockCount = 0;

  for (const block of content) {
    if (typeof block === "string") {
      const normalized = normalizeWhitespace(block);
      if (normalized) {
        textBlocks.push(normalized);
      }
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      const normalized = normalizeWhitespace(record.text);
      if (normalized) {
        textBlocks.push(normalized);
      }
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (typeof record.content === "string" && TEXT_BLOCK_TYPES.has(type)) {
      const normalized = normalizeWhitespace(record.content);
      if (normalized) {
        textBlocks.push(normalized);
      }
      continue;
    }

    nonTextBlockCount += 1;
  }

  if (textBlocks.length === 0 && nonTextBlockCount > 0) {
    textBlocks.push(`[non-text content omitted: ${nonTextBlockCount} block${nonTextBlockCount === 1 ? "" : "s"}]`);
  }

  return textBlocks;
}

/** Extracts raw text blocks without whitespace normalization. */
function extractRawTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      textBlocks.push(block);
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      textBlocks.push(record.text);
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (typeof record.content === "string" && TEXT_BLOCK_TYPES.has(type)) {
      textBlocks.push(record.content);
    }
  }

  return textBlocks;
}

/** Normalizes a free-form label into a slug-like session label. */
function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Collapses message content blocks into a single normalized text string.
 *
 * @param content - Raw OpenClaw message content.
 * @returns Whitespace-normalized transcript text.
 */
export function normalizeMessageText(content: unknown): string {
  return normalizeWhitespace(extractTextBlocks(content).join("\n"));
}

/**
 * Maps OpenClaw role values into the parser's normalized role set.
 *
 * @param value - Raw message role from the transcript.
 * @returns Normalized role label used by the parser.
 */
export function normalizeOpenClawRole(value: unknown): OpenClawRole {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "user" || normalized === "human") {
    return "user";
  }

  if (normalized === "assistant" || normalized === "ai" || normalized === "developer") {
    return "assistant";
  }

  if (normalized === "system") {
    return "system";
  }

  if (normalized === "tool" || normalized === "toolresult" || normalized === "tool_result") {
    return "toolResult";
  }

  return "unknown";
}

/**
 * Truncates long transcript text and appends a truncation marker.
 *
 * @param text - Transcript text to truncate.
 * @param maxChars - Maximum number of characters to retain before the marker.
 * @returns Original text when it fits, otherwise a truncated form with a marker.
 */
export function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[...truncated]`;
}

/**
 * Detects large base64-like blobs that should be dropped from transcripts.
 *
 * @param text - Candidate transcript text.
 * @returns True when the text looks like a base64 payload rather than natural language.
 */
export function isPureBase64(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 500) {
    return false;
  }

  if (!/[+/=]/.test(trimmed)) {
    return false;
  }

  return /^[A-Za-z0-9+/=\s]{500,}$/.test(trimmed);
}

/**
 * Normalizes a session label and drops empty results.
 *
 * @param value - Raw label candidate from transcript metadata.
 * @returns Slug-like label, or `undefined` when empty after normalization.
 */
export function normalizeSessionLabel(value: string): string | undefined {
  const normalized = normalizeLabel(value);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Extracts an embedded conversation label from fenced JSON metadata.
 *
 * @param content - Raw user message content to inspect.
 * @returns Normalized conversation label when present.
 */
export function extractConversationLabel(content: unknown): string | undefined {
  const rawTextBlocks = extractRawTextBlocks(content);

  for (const block of rawTextBlocks) {
    const matches = block.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
    for (const match of matches) {
      const candidate = match[1];
      if (!candidate) {
        continue;
      }

      try {
        const parsed = JSON.parse(candidate);
        const record = asRecord(parsed);
        const conversationLabel = record ? getString(record.conversation_label) : undefined;
        const normalizedLabel = conversationLabel ? normalizeSessionLabel(conversationLabel) : undefined;
        if (normalizedLabel) {
          return normalizedLabel;
        }
      } catch {
        // Ignore malformed metadata blocks embedded in user content.
      }
    }
  }

  return undefined;
}

/**
 * Extracts normalized assistant-visible text blocks from mixed content.
 *
 * @param content - Raw assistant message content.
 * @returns Visible assistant text chunks in order.
 */
export function extractAssistantTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      const normalized = normalizeWhitespace(block);
      if (normalized) {
        textParts.push(normalized);
      }
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      const normalized = normalizeWhitespace(record.text);
      if (normalized) {
        textParts.push(normalized);
      }
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (typeof record.content === "string" && TEXT_BLOCK_TYPES.has(type)) {
      const normalized = normalizeWhitespace(record.content);
      if (normalized) {
        textParts.push(normalized);
      }
    }
  }

  return textParts;
}

/**
 * Appends a normalized transcript message with the next sequential index.
 *
 * @param messages - Transcript message accumulator to update in place.
 * @param role - Normalized message role to append.
 * @param text - Normalized transcript text.
 * @param timestamp - Optional message timestamp.
 */
export function pushMessage(messages: TranscriptMessage[], role: "user" | "assistant", text: string, timestamp?: string): void {
  messages.push({
    index: messages.length,
    role,
    text,
    timestamp,
  });
}
