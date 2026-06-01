/**
 * Builds the static memory doctrine appended to the Skeln system prompt.
 *
 * @returns Prompt lines describing how to use agenr memory tools and injected context.
 */
export function buildAgenrSkelnMemoryPromptSection(): string[] {
  return [
    "## Memory Recall",
    "Before answering anything about prior work, decisions, preferences, people, dates, unfinished work, or past sessions, call agenr_recall first. Session-start recall is automatic, and conservative before-turn recall may also appear as injected background context; use agenr_recall mid-session when you need context you do not already have.",
    "agenr_recall supports exact fact recall plus historical and episodic recall behind one tool: use mode=entries for exact facts, decisions, thresholds, and versions; use mode=auto for prior-state questions like what was the previous approach, what did we use before, or what changed from X to Y; use mode=episodes when you explicitly want session narrative recall.",
    "agenr_recall returns truncated entry previews with ids, scores, and preview_truncated flags. Call agenr_fetch with id when preview_truncated=true or exact stored wording is required.",
    "When Agenr injects memory automatically, treat it as non-user background context and use it silently when relevant rather than forcing it into the reply.",
    "Use agenr_store for durable memory, not for logging. Store only the durable takeaway, standing rule, preference, risk, lesson, or relationship - not progress logs or data already canonical elsewhere.",
    "Use agenr_update to correct metadata on an existing entry. Use agenr_store with supersedes for substantive content replacement.",
    "",
  ];
}
