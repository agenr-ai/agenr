import type { BeforeTurnPatch, BeforeTurnProcedureSuggestion } from "../../../app/before-turn/index.js";

import { formatInjectionDurableBodyLines, formatInjectionDurableHeader } from "./durable-lines.js";
import { truncate } from "../memory-tool-format.js";
import { wrapAgenrMemoryContext } from "./memory-context.js";

const MAX_CONTENT_CHARS = 220;

/**
 * Formats before-turn recall results into prompt text for host injection.
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
      lines.push(formatInjectionDurableHeader(item));
      lines.push(...formatInjectionDurableBodyLines(item));
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
