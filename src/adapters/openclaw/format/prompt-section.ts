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
    "## Memory Recall",
    "Before answering anything about prior work, decisions, preferences, people, dates, unfinished work, or past sessions, call agenr_recall first. Session-start recall is automatic; use agenr_recall mid-session when you need context you do not already have.",
    "agenr_recall supports temporal recall: when the user asks about a specific time period, always use temporal filters - semantic search alone matches meaning, not dates.",
    'Use around plus aroundRadius to bias recall toward a period: last week -> around: "7d", aroundRadius: 3; two weeks ago -> around: "14d", aroundRadius: 4.',
    'Use since and until for hard bounds: in the last month -> since: "30d"; before March -> until: "2026-03-01". Combine temporal filters with a focused query.',
  ];

  if (availableTools.has(MEMORY_TOOL_NAMES.store)) {
    lines.push(
      "Store decisions, preferences, lessons, durable facts, and important open risks with agenr_store immediately after they happen. Apply the future-session test: will a fresh session need this to make a better decision?",
    );
    lines.push(
      "Use memory lifetimes deliberately: core is injected at every session start and should be rare, permanent is durable recall-on-demand memory, and temporary is short-horizon. Importance is 1 to 10; 7 is normal durable memory and 9 to 10 is rare and critical.",
    );
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.update) || availableTools.has(MEMORY_TOOL_NAMES.retire)) {
    lines.push("When memory is stale or wrong, fix it with agenr_update or agenr_retire instead of silently working around it.");
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.trace)) {
    lines.push("Use agenr_trace when provenance, recall history, or supersession matters.");
  }

  if (citationsMode === "off") {
    lines.push("Citations are disabled: do not mention agenr entry IDs in user-facing replies unless the user asks for them.");
  } else {
    lines.push("Citations: mention the relevant agenr entry ID only when it helps the user verify a claim.");
  }

  lines.push("");
  return lines;
}
