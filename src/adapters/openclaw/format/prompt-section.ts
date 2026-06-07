import { buildOpenClawStorePromptLines, MEMORY_DOCTRINE, MEMORY_RECALL_SECTION_HEADER } from "../../shared/memory-prompt-doctrine.js";
import type { AgenrOpenClawMemoryPromptSectionBuilder } from "../types.js";

const MEMORY_TOOL_NAMES = {
  recall: "agenr_recall",
  fetch: "agenr_fetch",
  store: "agenr_store",
  update: "agenr_update",
} as const;

const MEMORY_TOOL_NAME_SET = new Set<string>(Object.values(MEMORY_TOOL_NAMES));
const ORCHESTRATION_TOOL_PATTERNS = [/subagent/iu, /delegate/iu, /background/iu, /fork/iu, /teammate/iu, /parallel/iu, /spawn/iu];

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

  const hasOrchestrationTool = [...availableTools].some(
    (toolName) => !MEMORY_TOOL_NAME_SET.has(toolName) && ORCHESTRATION_TOOL_PATTERNS.some((pattern) => pattern.test(toolName)),
  );

  const lines = [
    MEMORY_RECALL_SECTION_HEADER,
    MEMORY_DOCTRINE.recall.first,
    MEMORY_DOCTRINE.recall.modes,
    MEMORY_DOCTRINE.recall.truncatedPreviews,
    "For temporal narrative questions, put the time phrase in the query itself: examples include yesterday, last week, this month, 2 weeks ago, or in March.",
    "One focused agenr_recall call with the right scope beats several broad ones.",
    MEMORY_DOCTRINE.recall.injectedContext,
    "Memory authority, strongest to weakest:",
    "- Durable memory is the canonical record for verified facts, decisions, preferences, and lessons unless live evidence contradicts them.",
    "- Episode recall explains what happened in completed sessions, but it is a narrative summary, not an exact log.",
    "- Live verification beats stored memory whenever you can check quickly.",
    "The newest completed session may not be consolidated into episodes yet, so very recent work can be missing from episode recall.",
  ];

  if (availableTools.has(MEMORY_TOOL_NAMES.store)) {
    lines.push(...buildOpenClawStorePromptLines());
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.update)) {
    lines.push(MEMORY_DOCTRINE.update.vsSupersedes);
    lines.push(MEMORY_DOCTRINE.update.contradictedByEvidence);
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.fetch)) {
    lines.push(MEMORY_DOCTRINE.recall.fetchWhenTruncated);
  }

  if (hasOrchestrationTool) {
    lines.push("Do not summarize or assert results from unfinished background work.");
    lines.push("Do not fabricate completion status for delegated tasks.");
  }

  if (citationsMode === "off") {
    lines.push("Citations are disabled: do not mention agenr entry IDs in user-facing replies unless the user asks for them.");
  } else {
    lines.push("Citations: mention the relevant agenr entry ID only when it helps the user verify a claim.");
  }

  lines.push("");
  return lines;
}
