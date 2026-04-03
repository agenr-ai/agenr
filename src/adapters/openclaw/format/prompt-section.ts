import type { AgenrOpenClawMemoryPromptSectionBuilder } from "../types.js";

const MEMORY_TOOL_NAMES = {
  recall: "agenr_recall",
  store: "agenr_store",
  update: "agenr_update",
  retire: "agenr_retire",
  trace: "agenr_trace",
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
    "## Memory Recall",
    "Before answering anything about prior work, decisions, preferences, people, dates, unfinished work, or past sessions, call agenr_recall first. Session-start recall is automatic; use agenr_recall mid-session when you need context you do not already have.",
    "agenr_recall supports exact fact recall plus historical and episodic recall behind one tool: use mode=entries for exact facts, decisions, thresholds, and versions; use mode=auto for prior-state questions like what was the previous approach, what did we use before, or what changed from X to Y; use mode=episodes when you explicitly want session narrative recall.",
    "For temporal narrative questions, put the time phrase in the query itself: examples include yesterday, last week, this month, 2 weeks ago, or in March.",
    "One focused agenr_recall call with the right scope beats several broad ones.",
    "Memory authority, strongest to weakest:",
    "- Durable entries are the canonical record for verified facts, decisions, preferences, and lessons unless live evidence contradicts them.",
    "- Episode recall explains what happened in completed sessions, but it is a narrative summary, not an exact log.",
    "- Session handoffs and continuity summaries are approximate restart context and may be incomplete or stale.",
    "- Live verification beats stored memory whenever you can check quickly.",
    "The newest completed session may not be consolidated into episodes yet, so very recent work can be missing from episode recall.",
  ];

  if (availableTools.has(MEMORY_TOOL_NAMES.store)) {
    lines.push(
      "Store decisions, preferences, lessons, durable facts, and important open risks with agenr_store immediately after they happen. Apply the future-session test: will a fresh session need this to make a better decision?",
    );
    lines.push("Do not store progress snapshots or current-state narration about what is happening right now as durable memory.");
    lines.push("Do not store plans, checklists, or speculative future state as facts or decisions.");
    lines.push("Do not re-store recalled entries, episode summaries, continuity text, or conversation summaries as new evidence.");
    lines.push("Do not store meta narration about the current session.");
    lines.push(
      "Use memory lifetimes deliberately: core is injected at every session start and should be rare, permanent is durable recall-on-demand memory, and temporary is short-horizon. Importance is 1 to 10; 7 is normal durable memory and 9 to 10 is rare and critical.",
    );
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.update) || availableTools.has(MEMORY_TOOL_NAMES.retire)) {
    lines.push("When memory is contradicted by live evidence, fix it with agenr_update or agenr_retire instead of silently working around it.");
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.trace)) {
    lines.push("Use agenr_trace when provenance, recall history, or supersession matters.");
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
