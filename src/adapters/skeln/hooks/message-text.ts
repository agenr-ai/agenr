import type { BeforeTurnRecentTurn } from "../../../app/before-turn/index.js";
import { containsAgenrMemoryContext, stripAgenrMemoryContext } from "../../shared/injection/memory-context.js";

const MEMORY_HEADINGS = [
  "## Previous session summary",
  "## Recent session",
  "## Agenr Session Recall",
  "### Core Memory",
  "### Relevant Durable Memory",
  "## Agenr Before-Turn Recall",
  "### Suggested Procedure",
] as const;

/**
 * Extracts plain text from one agent message content payload.
 *
 * @param content - Raw message content from the Skeln session store.
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
 * Extracts a compact recent-turn window from Skeln branch messages.
 *
 * @param messages - Agent messages from the active session branch.
 * @returns Ordered recent turns suitable for the before-turn app service.
 */
export function extractRecentTurnsFromMessages(messages: Array<{ role?: unknown; content?: unknown }>): BeforeTurnRecentTurn[] {
  const turns: BeforeTurnRecentTurn[] = [];
  for (const message of messages) {
    const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
    if (!role) {
      continue;
    }

    const text = sanitizeRecentTurnText(extractAgentMessageText(message.content), role);
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
 * @param prompt - Raw current prompt text from Skeln.
 * @returns Normalized prompt text, or undefined when empty.
 */
export function normalizePromptText(prompt: string): string | undefined {
  let cleaned = stripAgenrMemoryContext(prompt);
  cleaned = collapseWhitespace(cleaned);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Removes prior injected memory wrappers so they do not recursively pollute the
 * next before-turn query.
 *
 * @param text - Raw message text.
 * @param role - Message role used for wrapper unrolling.
 * @returns Sanitized recent-turn text.
 */
export function sanitizeRecentTurnText(text: string, role: "user" | "assistant"): string {
  if (!text.trim()) {
    return "";
  }

  const wrapperDetected = containsAgenrMemoryContext(text) || text.includes("## Agenr Session Recall") || text.includes("## Agenr Before-Turn Recall");

  let cleaned = stripAgenrMemoryContext(text);
  for (const heading of MEMORY_HEADINGS) {
    cleaned = cleaned.split(heading).join(" ");
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

/** Collapses repeated whitespace while preserving single-line readability. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
