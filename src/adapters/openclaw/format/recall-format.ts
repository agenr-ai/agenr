import type { Entry } from "../../../core/types.js";
import type { OpenClawPromptMemoryEntry, OpenClawPromptMemorySection, OpenClawSessionStartRecall } from "../types.js";

const MAX_CONTENT_CHARS = 280;

/**
 * Formats session-start recall results into prompt text for OpenClaw injection.
 *
 * @param recall - Structured session-start recall payload.
 * @returns Prompt-ready text, or an empty string when nothing should be injected.
 */
export function formatAgenrSessionStartRecall(recall: OpenClawSessionStartRecall): string {
  const sections = buildSections(recall);
  if (sections.length === 0) {
    return "";
  }

  const lines = ["## Agenr Session Recall", "Use this as prior context. Confirm anything important if the current conversation conflicts with it.", ""];

  for (const section of sections) {
    lines.push(`### ${section.title}`);

    for (const item of section.entries) {
      lines.push(formatEntryHeader(item));
      lines.push(formatEntryBody(item.entry));
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Builds the ordered memory sections that should appear in the system prompt.
 *
 * @param recall - Structured recall payload grouped by purpose.
 * @returns Non-empty prompt sections ready for rendering.
 */
export function buildSections(recall: OpenClawSessionStartRecall): OpenClawPromptMemorySection[] {
  const sections: OpenClawPromptMemorySection[] = [];

  const coreEntries = recall.core.map((entry) => ({ entry }));
  if (coreEntries.length > 0) {
    sections.push({ title: "Core Memory", entries: coreEntries });
  }

  const relevantEntries = recall.relevant.map((result) => ({
    entry: result.entry,
    score: result.score,
  }));
  if (relevantEntries.length > 0) {
    sections.push({ title: "Relevant Recall", entries: relevantEntries });
  }

  const handoffEntries = recall.handoffs.map((entry) => ({ entry }));
  if (handoffEntries.length > 0) {
    sections.push({ title: "Recent Handoffs", entries: handoffEntries });
  }

  const recentEntries = recall.recent.map((entry) => ({ entry }));
  if (recentEntries.length > 0) {
    sections.push({ title: "Recent Context", entries: recentEntries });
  }

  return sections;
}

/** Formats one memory entry header line for prompt injection. */
function formatEntryHeader(item: OpenClawPromptMemoryEntry): string {
  const metadata = [
    item.entry.id,
    item.entry.type,
    item.entry.expiry,
    `importance ${item.entry.importance}`,
    item.score !== undefined ? `score ${item.score.toFixed(2)}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return `- [${metadata.join(" | ")}] ${item.entry.subject}`;
}

/** Formats one memory entry body line for prompt injection. */
function formatEntryBody(entry: Entry): string {
  const content = truncate(entry.content.trim(), MAX_CONTENT_CHARS);
  const extra = [
    entry.tags.length > 0 ? `tags: ${entry.tags.join(", ")}` : undefined,
    entry.created_at ? `created: ${entry.created_at.slice(0, 10)}` : undefined,
  ].filter((value): value is string => value !== undefined);

  if (extra.length === 0) {
    return `  ${content}`;
  }

  return `  ${content} (${extra.join(" | ")})`;
}

/** Truncates long memory content to keep prompt injection bounded. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}
