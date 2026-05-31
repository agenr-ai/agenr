import { SESSION_ARTIFACT_KINDS, SESSION_LINEAGE_REASONS, type SessionArtifactKind, type SessionLineageReason } from "../../app/session-memory/types.js";

/**
 * Parses one stored session-artifact kind.
 *
 * @param value - Raw database value.
 * @returns Parsed artifact kind.
 */
export function parseSessionArtifactKind(value: string): SessionArtifactKind {
  if ((SESSION_ARTIFACT_KINDS as readonly string[]).includes(value)) {
    return value as SessionArtifactKind;
  }

  throw new Error(`Unsupported session artifact kind "${value}".`);
}

/**
 * Parses one stored session-lineage reason.
 *
 * @param value - Raw database value.
 * @returns Parsed lineage reason.
 */
export function parseSessionLineageReason(value: string): SessionLineageReason {
  if ((SESSION_LINEAGE_REASONS as readonly string[]).includes(value)) {
    return value as SessionLineageReason;
  }

  throw new Error(`Unsupported session lineage reason "${value}".`);
}
