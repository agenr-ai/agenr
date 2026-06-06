import type { AgenrOpenClawMemoryPromptSectionBuilder } from "../types.js";

const MEMORY_TOOL_NAMES = {
  recall: "agenr_recall",
  fetch: "agenr_fetch",
  store: "agenr_store",
  update: "agenr_update",
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
    "Before answering anything about prior work, decisions, preferences, people, dates, unfinished work, or past sessions, call agenr_recall first. Session-start recall is automatic, and conservative before-turn recall may also appear as injected background context; use agenr_recall mid-session when you need context you do not already have.",
    "agenr_recall supports exact fact recall plus historical and episodic recall behind one tool: use mode=durables for exact facts, decisions, thresholds, and versions; use mode=auto for prior-state questions like what was the previous approach, what did we use before, or what changed from X to Y; use mode=episodes when you explicitly want session narrative recall.",
    "agenr_recall returns truncated durable previews with ids, scores, and preview_truncated flags.",
    "For temporal narrative questions, put the time phrase in the query itself: examples include yesterday, last week, this month, 2 weeks ago, or in March.",
    "One focused agenr_recall call with the right scope beats several broad ones.",
    "When Agenr injects memory automatically, treat it as non-user background context and use it silently when relevant rather than forcing it into the reply.",
    "Memory authority, strongest to weakest:",
    "- Durable memory is the canonical record for verified facts, decisions, preferences, and lessons unless live evidence contradicts them.",
    "- Episode recall explains what happened in completed sessions, but it is a narrative summary, not an exact log.",
    "- Session handoffs and continuity summaries are approximate restart context and may be incomplete or stale.",
    "- Live verification beats stored memory whenever you can check quickly.",
    "The newest completed session may not be consolidated into episodes yet, so very recent work can be missing from episode recall.",
  ];

  if (availableTools.has(MEMORY_TOOL_NAMES.store)) {
    lines.push(
      "Use agenr_store for durable memory, not for logging. Apply the future-session test: will a fresh future session make a better decision because this was stored, or are you just recording that something happened?",
    );
    lines.push(
      "If another system already holds the canonical record - such as version control, a task or ticket tracker, a calendar, a signed document, a chat or email thread, or a database/CRM - usually do not store that record. Store only the durable takeaway: the standing rule, implication, lesson, preference, risk, or relationship.",
    );
    lines.push(
      "Type guide: fact = durable truth about a person, system, place, or how something works; decision = standing rule, constraint, policy, or chosen approach future sessions should follow; preference = what someone likes, wants, values, or wants avoided; lesson = non-obvious takeaway from experience that should change future behavior; milestone = rare one-time event with durable future significance, not ordinary task completion.",
    );
    lines.push("Do not use decision as a catch-all for important activity updates.");
    lines.push(
      "Usually do not store: 'I merged PR #123.', 'I filed a support ticket.', 'We had a meeting at 3 PM.', 'I sent the contract for signature.', or 'We spent two hours debugging the outage.'",
    );
    lines.push(
      "Do store the durable takeaway instead: 'Always use the structured export path because raw sync corrupts timestamps.' (decision or lesson), 'Jim prefers text-first updates and dislikes surprise calls.' (preference), 'Service restarts fail unless config Y is enabled.' (lesson), 'The office Wi-Fi name is Acorn-5G.' (fact).",
    );
    lines.push("Do not store progress snapshots or current-state narration about what is happening right now as durable memory.");
    lines.push("Do not store plans, checklists, or speculative future state as facts or decisions.");
    lines.push("Do not re-store recalled durables, episode summaries, continuity text, or conversation summaries as new evidence.");
    lines.push("Do not store meta narration about the current session.");
    lines.push(
      "Use memory lifetimes deliberately: core is injected at every session start and should be rare, permanent is durable recall-on-demand memory, and temporary is short-horizon. Importance is 1 to 10; 7 is normal durable memory and 9 to 10 is rare and critical.",
    );
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.update)) {
    lines.push("When memory is contradicted by live evidence, fix it with agenr_update instead of silently working around it.");
  }

  if (availableTools.has(MEMORY_TOOL_NAMES.fetch)) {
    lines.push("Call agenr_fetch with id when preview_truncated=true or exact stored wording is required.");
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
