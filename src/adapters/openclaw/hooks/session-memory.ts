import type { SessionArtifactInput, SessionMemoryTriggerEvent, SessionStartTransitionReason } from "../../../app/session-memory/types.js";
import { buildCompactionSourceRef, buildSessionEndSourceRef, buildSessionFileSourceRef } from "../../../app/session-memory/source-ref.js";
import { toWorkingScopeFromOpenClawSession, type AgenrOpenClawSessionScope } from "../session/scope.js";
import type { AgenrOpenClawSessionEndEvent } from "../types.js";
import type { OpenClawCompactionTranscriptEntry } from "../session/compaction-transcript.js";

/** OpenClaw session_start payload fields consumed by session-memory intake. */
export interface OpenClawSessionStartEvent {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
}

/** OpenClaw before_compaction payload fields consumed by session-memory intake. */
export interface OpenClawBeforeCompactionEvent {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
  sessionFile?: string;
}

/** OpenClaw after_compaction payload fields consumed by session-memory intake. */
export interface OpenClawAfterCompactionEvent {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  sessionFile?: string;
}

/** OpenClaw before_reset payload fields consumed by session-memory intake. */
export interface OpenClawBeforeResetEvent {
  sessionFile?: string;
  reason?: string;
}

/** OpenClaw session_end reasons that map to branch-reset tree intake. */
const TREE_SESSION_END_REASONS = new Set<AgenrOpenClawSessionEndEvent["reason"]>(["reset"]);

/**
 * Builds the session_start trigger event for the active OpenClaw scope.
 *
 * @param scope - Resolved session scope.
 * @param event - Optional host transition facts from OpenClaw.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildOpenClawSessionStartTriggerEvent(
  scope: AgenrOpenClawSessionScope,
  event: OpenClawSessionStartEvent = { sessionId: scope.sessionId },
): SessionMemoryTriggerEvent {
  const resumedFrom = event.resumedFrom?.trim();
  const transitionReason: SessionStartTransitionReason = resumedFrom ? "resume" : "new";
  const predecessor = resumedFrom ? { sourceRef: buildSessionFileSourceRef(resumedFrom) } : undefined;

  return {
    type: "session_start",
    sessionKey: scope.sessionKey,
    childSessionKey: scope.sessionKey,
    transitionReason,
    ...(predecessor ? { predecessor } : {}),
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a checkpoint-relevant session_before_compact trigger event.
 *
 * @param scope - Resolved session scope.
 * @param event - OpenClaw before-compaction payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildOpenClawSessionBeforeCompactTriggerEvent(
  scope: AgenrOpenClawSessionScope,
  event: OpenClawBeforeCompactionEvent,
): SessionMemoryTriggerEvent {
  return {
    type: "session_before_compact",
    sessionKey: scope.sessionKey,
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a session_compact trigger event with a compaction checkpoint artifact.
 *
 * @param scope - Resolved session scope.
 * @param event - OpenClaw after-compaction payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildOpenClawSessionCompactTriggerEvent(
  scope: AgenrOpenClawSessionScope,
  event: OpenClawAfterCompactionEvent,
  compactionEntry?: OpenClawCompactionTranscriptEntry,
): SessionMemoryTriggerEvent {
  return {
    type: "session_compact",
    sessionKey: scope.sessionKey,
    artifact: buildOpenClawCompactionCheckpointArtifact(scope.sessionKey, event, compactionEntry),
    workingScope: toWorkingScopeFromOpenClawSession(scope),
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a checkpoint-relevant session_before_tree trigger event.
 *
 * @param scope - Resolved session scope.
 * @param event - OpenClaw before-reset payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildOpenClawSessionBeforeTreeTriggerEvent(scope: AgenrOpenClawSessionScope, event: OpenClawBeforeResetEvent): SessionMemoryTriggerEvent {
  return {
    type: "session_before_tree",
    sessionKey: scope.sessionKey,
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a session_tree trigger event for branch-abandonment style resets.
 *
 * @param scope - Resolved session scope.
 * @param event - OpenClaw session-end payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildOpenClawSessionTreeTriggerEvent(
  scope: AgenrOpenClawSessionScope,
  event: Pick<AgenrOpenClawSessionEndEvent, "reason" | "sessionFile" | "messageCount">,
): SessionMemoryTriggerEvent {
  const reason = event.reason ?? "unknown";
  const artifact: SessionArtifactInput = {
    kind: "branch_abandonment",
    source: "openclaw",
    sourceId: `${scope.sessionKey}:${reason}`,
    sourceRef: buildSessionEndSourceRef(event.sessionFile ?? reason),
    summary: `OpenClaw session ended with reason ${reason} after ${event.messageCount} messages.`,
    metadata: {
      reason,
      ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
    },
  };

  return {
    type: "session_tree",
    sessionKey: scope.sessionKey,
    artifact,
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a checkpoint-relevant session_shutdown trigger event.
 *
 * @param scope - Resolved session scope.
 * @param event - OpenClaw session-end payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildOpenClawSessionShutdownTriggerEvent(
  scope: AgenrOpenClawSessionScope,
  event: Pick<AgenrOpenClawSessionEndEvent, "reason" | "sessionFile" | "messageCount" | "durationMs">,
): SessionMemoryTriggerEvent {
  return {
    type: "session_shutdown",
    sessionKey: scope.sessionKey,
    workingScope: toWorkingScopeFromOpenClawSession(scope),
    shutdownReason: event.reason ?? "unknown",
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Returns whether a session_end reason should route through session_tree intake.
 *
 * @param reason - OpenClaw session-end reason when present.
 * @returns True when the reason maps to branch abandonment.
 */
export function shouldRouteOpenClawSessionTreeTrigger(reason: AgenrOpenClawSessionEndEvent["reason"]): boolean {
  return reason !== undefined && TREE_SESSION_END_REASONS.has(reason);
}

/**
 * Returns whether session_end should skip session-memory intake because compaction
 * hooks already recorded the checkpoint.
 *
 * @param reason - OpenClaw session-end reason when present.
 * @returns True when intake should be skipped.
 */
export function shouldSkipOpenClawSessionEndMemoryTrigger(reason: AgenrOpenClawSessionEndEvent["reason"]): boolean {
  return reason === "compaction";
}
/** Builds one compaction checkpoint artifact from OpenClaw compaction facts. */
function buildOpenClawCompactionCheckpointArtifact(
  sessionKey: string,
  event: OpenClawAfterCompactionEvent,
  compactionEntry?: OpenClawCompactionTranscriptEntry,
): SessionArtifactInput {
  const sourceId = compactionEntry?.id?.trim() || event.sessionFile?.trim() || `${sessionKey}:${event.compactedCount}`;
  const summary = compactionEntry?.summary.trim() || `Compacted ${event.compactedCount} messages; ${event.messageCount} messages remain.`;

  return {
    kind: "compaction_checkpoint",
    sessionKey,
    source: "openclaw",
    sourceId,
    sourceRef: buildCompactionSourceRef(event.sessionFile ?? sourceId),
    summary,
    metadata: {
      compactedCount: event.compactedCount,
      messageCount: event.messageCount,
      ...(event.tokenCount !== undefined ? { tokenCount: event.tokenCount } : {}),
      ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
      ...(compactionEntry?.tokensBefore !== undefined ? { tokensBefore: compactionEntry.tokensBefore } : {}),
      ...(compactionEntry?.tokensAfter !== undefined ? { tokensAfter: compactionEntry.tokensAfter } : {}),
      ...(compactionEntry?.firstKeptEntryId ? { firstKeptEntryId: compactionEntry.firstKeptEntryId } : {}),
      ...(compactionEntry?.fromHook !== undefined ? { fromHook: compactionEntry.fromHook } : {}),
    },
  };
}
