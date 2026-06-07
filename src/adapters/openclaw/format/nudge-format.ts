import type { MidSessionState } from "../types.js";

const MAX_DISPLAY_SUBJECTS = 3;
const MAX_SUBJECT_LENGTH = 48;

/**
 * Builds the mid-session `[MEMORY CHECK]` prompt injected into user context.
 *
 * The copy reinforces the existing static memory doctrine at the moment it
 * matters: capture durable cross-session knowledge, record validated wins as
 * well as corrections, and skip transient session-state narration.
 *
 * @param state - Current mid-session store-tracking state.
 * @param maxPerSession - Maximum nudges allowed for the session lifetime.
 * @returns Prompt-ready nudge text.
 */
export function buildStoreNudgeMessage(state: MidSessionState, maxPerSession: number): string {
  const isFirstNudge = state.nudgeCount === 1;
  const isFinalNudge = state.nudgeCount >= maxPerSession;
  const hasStoredDurables = state.durablesStored > 0;
  const subjectsLabel = formatStoredSubjects(state.storedSubjects) ?? "recent durable session memory";

  if (hasStoredDurables) {
    if (isFinalNudge) {
      return "[MEMORY CHECK] Session may end soon. Capture final durable takeaways: validated preferences, confirmed lessons, important decisions, open risks. Skip transient progress and derivable project state.";
    }

    if (isFirstNudge) {
      return `[MEMORY CHECK] You've stored ${state.durablesStored} ${state.durablesStored === 1 ? "durable" : "durables"} this session covering ${subjectsLabel}. Review recent conversation for anything else worth keeping - decisions, confirmed approaches, preferences, lessons, or open risks. Store both corrections and validated wins. Skip transient progress and derivable repo facts.`;
    }

    return `[MEMORY CHECK] Session memory covers ${subjectsLabel}. Check for newer durable knowledge - especially non-obvious approaches the user confirmed worked well. Use memory for future-session knowledge, not current task state.`;
  }

  if (isFinalNudge) {
    return "[MEMORY CHECK] Session may end soon and nothing has been stored. Capture durable takeaways a future session would need: validated preferences, confirmed lessons, important decisions, durable facts, and open risks. Skip transient progress and derivable project state.";
  }

  if (isFirstNudge) {
    return "[MEMORY CHECK] You haven't stored anything this session. Review recent conversation for future-session knowledge: decisions, preferences, lessons (including confirmed successes, not just corrections), durable facts, and open risks. Skip transient progress, derivable repo facts, and conversation summaries.";
  }

  return "[MEMORY CHECK] Still no stores this session. If anything here matters after session reset, store it now. Record both what went wrong and what worked well. For lessons and preferences, capture the rule, why it matters, and when it applies.";
}

/**
 * Formats stored subjects into a compact human-readable label list.
 *
 * @param subjects - Deduplicated recent stored subjects from the session.
 * @returns Rendered subject label list, or `undefined` when empty.
 */
function formatStoredSubjects(subjects: string[]): string | undefined {
  if (subjects.length === 0) {
    return undefined;
  }

  const displaySubjects = subjects.slice(-MAX_DISPLAY_SUBJECTS).map((subject) => `"${truncateSubject(subject)}"`);
  const overflowCount = subjects.length - displaySubjects.length;
  if (overflowCount > 0) {
    displaySubjects.push(`and ${overflowCount} more`);
  }

  return displaySubjects.join(", ");
}

/**
 * Truncates one subject label so nudge prompts stay compact.
 *
 * @param subject - Stored subject to render.
 * @returns Safe display label.
 */
function truncateSubject(subject: string): string {
  const trimmedSubject = subject.trim();
  if (trimmedSubject.length <= MAX_SUBJECT_LENGTH) {
    return trimmedSubject;
  }

  return `${trimmedSubject.slice(0, MAX_SUBJECT_LENGTH - 3).trimEnd()}...`;
}
