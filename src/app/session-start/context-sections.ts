import { normalizeOptionalString } from "../session-memory/normalize.js";
import type { SessionStartContextSection } from "./types.js";

/** Continuity artifact kinds surfaced as session-start context sections. */
export type SessionStartContinuitySectionKind = SessionStartContextSection["kind"];

/**
 * Builds session-start context sections from optional predecessor text.
 *
 * @param continuitySummaryText - Optional predecessor continuity summary.
 * @param recentSessionText - Optional recent-session tail text.
 * @returns Ordered non-empty context sections.
 */
export function buildSessionStartContextSections(
  continuitySummaryText: string | undefined,
  recentSessionText: string | undefined,
): SessionStartContextSection[] {
  const sections: SessionStartContextSection[] = [];
  const normalizedContinuitySummary = normalizeOptionalString(continuitySummaryText);
  if (normalizedContinuitySummary) {
    sections.push({
      kind: "continuity_summary",
      title: "Previous session summary",
      content: normalizedContinuitySummary,
    });
  }

  const normalizedRecentSession = normalizeOptionalString(recentSessionText);
  if (normalizedRecentSession) {
    sections.push({
      kind: "recent_session",
      title: "Recent session",
      content: normalizedRecentSession,
    });
  }

  return sections;
}
