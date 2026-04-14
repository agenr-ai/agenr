import type { BeforeTurnPatch, BeforeTurnPatchItem, BeforeTurnProcedureSuggestion } from "../../../app/before-turn/index.js";

import { wrapAgenrMemoryContext } from "./memory-context.js";

const MAX_CONTENT_CHARS = 220;

/**
 * Formats before-turn recall results into prompt text for OpenClaw injection.
 *
 * @param patch - Structured before-turn patch returned by the app layer.
 * @returns Prompt-ready text, or an empty string when nothing should be injected.
 */
export function formatAgenrBeforeTurnRecall(patch: BeforeTurnPatch): string {
  if (patch.durableMemory.length === 0 && !patch.procedure) {
    return "";
  }

  const lines: string[] = [
    "## Agenr Before-Turn Recall",
    "Use this only when it materially helps the current turn. Treat it as background context and prefer the live conversation if anything conflicts with it.",
    "",
  ];

  if (patch.durableMemory.length > 0) {
    lines.push("### Relevant Durable Memory");
    for (const item of patch.durableMemory) {
      lines.push(formatEntryHeader(item));
      lines.push(...formatEntryBodyLines(item));
    }
    lines.push("");
  }

  if (patch.procedure) {
    lines.push("### Suggested Procedure");
    lines.push(formatProcedureHeader(patch.procedure));
    lines.push(...formatProcedureBodyLines(patch.procedure));
    lines.push("");
  }

  return wrapAgenrMemoryContext(lines.join("\n").trim());
}

/** Formats one memory entry header line for prompt injection. */
function formatEntryHeader(item: BeforeTurnPatchItem): string {
  const metadata = [
    `rank ${item.rank}`,
    item.entry.id,
    item.entry.type,
    item.entry.expiry,
    `importance ${item.entry.importance}`,
    `score ${item.score.toFixed(2)}`,
  ];

  return `- [${metadata.join(" | ")}] ${item.entry.subject}`;
}

/** Formats one memory entry body block for prompt injection. */
function formatEntryBodyLines(item: BeforeTurnPatchItem): string[] {
  const lines = [`  ${truncate(item.entry.content.trim(), MAX_CONTENT_CHARS)}`];
  lines.push(`  why: ${item.whySurfaced.summary}`);

  const metadata = [
    item.entry.tags.length > 0 ? `tags: ${item.entry.tags.join(", ")}` : undefined,
    item.freshnessLabel ? `freshness: ${item.freshnessLabel}` : undefined,
    item.provenanceSummary ? `provenance: ${truncate(item.provenanceSummary, MAX_CONTENT_CHARS)}` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (metadata.length > 0) {
    lines.push(`  ${metadata.join(" | ")}`);
  }

  return lines;
}

/** Formats one proactive procedure header line for prompt injection. */
function formatProcedureHeader(suggestion: BeforeTurnProcedureSuggestion): string {
  const metadata = [
    suggestion.procedure.id,
    suggestion.procedure.procedure_key,
    `score ${suggestion.score.toFixed(2)}`,
    `lexical ${suggestion.scores.lexical.toFixed(2)}`,
    `vector ${suggestion.scores.vector.toFixed(2)}`,
  ];

  return `- [${metadata.join(" | ")}] ${suggestion.procedure.title}`;
}

/** Formats one proactive procedure body block for prompt injection. */
function formatProcedureBodyLines(suggestion: BeforeTurnProcedureSuggestion): string[] {
  const lines = [`  goal: ${truncate(suggestion.procedure.goal.trim(), MAX_CONTENT_CHARS)}`];
  lines.push(`  why: ${suggestion.whySurfaced.summary}`);

  if (suggestion.procedure.when_to_use.length > 0) {
    lines.push(`  when to use: ${truncate(suggestion.procedure.when_to_use.join("; "), MAX_CONTENT_CHARS)}`);
  }

  if (suggestion.procedure.verification.length > 0) {
    lines.push(`  verification: ${truncate(suggestion.procedure.verification.join("; "), MAX_CONTENT_CHARS)}`);
  }

  return lines;
}

/** Truncates long memory content to keep prompt injection bounded. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}
