import type { AgenrOpenClawMemoryPromptSectionBuilder } from "../types.js";

const MEMORY_TOOL_NAMES = {
  recall: "agenr_recall",
  store: "agenr_store",
  update: "agenr_update",
  retire: "agenr_retire",
  trace: "agenr_trace",
} as const;

/**
 * Builds the static memory guidance inserted into the OpenClaw system prompt.
 *
 * @param params - Available memory tools plus citation preferences.
 * @returns Prompt lines for the active agenr memory slot.
 */
export function buildAgenrMemoryPromptSection({
  availableTools,
  citationsMode,
}: Parameters<AgenrOpenClawMemoryPromptSectionBuilder>[0]): ReturnType<AgenrOpenClawMemoryPromptSectionBuilder> {
  if (!availableTools.has(MEMORY_TOOL_NAMES.recall)) {
    return [];
  }

  const lines = [
    "## Agenr Memory",
    "Before answering questions about prior decisions, preferences, constraints, unfinished work, or past sessions, call agenr_recall first.",
  ];

  if (availableTools.has(MEMORY_TOOL_NAMES.store)) {
    lines.push("Store durable facts, decisions, lessons, preferences, and todos with agenr_store when they are likely to matter later.");
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.update) || availableTools.has(MEMORY_TOOL_NAMES.retire)) {
    lines.push("When memory is stale or wrong, fix it with agenr_update or agenr_retire instead of silently working around it.");
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.trace)) {
    lines.push("Use agenr_trace when provenance, recall history, or supersession matters.");
  }

  if (citationsMode === "off") {
    lines.push("Do not mention agenr entry IDs in user-facing replies unless the user asks for them.");
  } else {
    lines.push("When it helps the user verify a claim, you may mention the relevant agenr entry ID.");
  }

  lines.push("");
  return lines;
}
