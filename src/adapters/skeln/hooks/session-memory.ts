import type { SessionMemoryTriggerResult } from "../../../app/session-memory/results.js";
import type { SessionArtifactInput, SessionMemoryTriggerEvent, SessionStartTransitionReason } from "../../../app/session-memory/types.js";

import { toWorkingScopeFromSkelnSession } from "../session/scope.js";
import type { AgenrSkelnSessionScope } from "../types.js";

/** Skeln session_start payload fields consumed by session-memory intake. */
export interface SkelnSessionStartTransition {
  reason?: "startup" | "reload" | "new" | "fork" | "clone" | "resume";
  previousSessionFile?: string;
}

/** Skeln session_before_fork payload fields consumed by session-memory intake. */
export interface SkelnSessionBeforeForkEvent {
  entryId?: string;
  position: "before" | "at";
}

/** Skeln session_compact payload fields consumed by session-memory intake. */
export interface SkelnSessionCompactEvent {
  compactionEntry: {
    id: string;
    summary: string;
    firstKeptEntryId: string;
  };
  fromExtension: boolean;
}

/** Skeln session_before_tree payload fields consumed by session-memory intake. */
export interface SkelnSessionBeforeTreeEvent {
  preparation: {
    targetId: string;
    oldLeafId: string | null;
    commonAncestorId: string | null;
    entriesToSummarize: unknown[];
    userWantsSummary: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  };
  signal?: AbortSignal;
}

/** Skeln session_tree payload fields consumed by session-memory intake. */
export interface SkelnSessionTreeEvent {
  oldLeafId: string | null;
  newLeafId: string | null;
  summaryEntry?: {
    id: string;
    summary: string;
    fromId: string;
    details?: unknown;
    fromHook?: boolean;
  };
  fromExtension?: boolean;
}

/** Registers deferred shutdown work with the Skeln host when reason is `quit`. */
export type SkelnSessionShutdownDeferWork = (work: Promise<unknown>) => void;

/** Skeln session_shutdown payload fields consumed by session-memory intake. */
export type SkelnSessionShutdownEvent =
  | {
      reason: "quit";
      targetSessionFile?: string;
      /** When provided, the host keeps the process alive until episode capture and DB close finish. */
      deferWork?: SkelnSessionShutdownDeferWork;
    }
  | {
      reason: "reload" | "new" | "fork" | "clone" | "resume";
      targetSessionFile?: string;
    };

/** Skeln session_start reasons that create lineage edges. */
type SkelnLineageSessionStartReason = Extract<SessionStartTransitionReason, "fork" | "clone" | "resume">;

const LINEAGE_SESSION_START_REASONS = new Set<SkelnLineageSessionStartReason>(["fork", "clone", "resume"]);

/**
 * Builds the session_start trigger event for the active Skeln scope.
 *
 * @param scope - Resolved session scope.
 * @param transition - Optional host transition facts from Skeln.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildSkelnSessionStartTriggerEvent(scope: AgenrSkelnSessionScope, transition: SkelnSessionStartTransition = {}): SessionMemoryTriggerEvent {
  const previousSessionFile = transition.previousSessionFile?.trim();
  const transitionReason = resolveSessionStartTransitionReason(transition.reason, previousSessionFile);
  const predecessor = buildSessionStartPredecessor(transitionReason, previousSessionFile);

  return {
    type: "session_start",
    sessionKey: scope.sessionKey,
    childSessionKey: scope.sessionKey,
    transitionReason,
    ...(predecessor ? { predecessor } : {}),
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a checkpoint-relevant session_before_fork trigger event.
 *
 * @param scope - Resolved session scope.
 * @param event - Skeln before-fork payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildSkelnSessionBeforeForkTriggerEvent(scope: AgenrSkelnSessionScope, event: SkelnSessionBeforeForkEvent): SessionMemoryTriggerEvent {
  const forkEntryId = event.entryId?.trim();

  return {
    type: "session_before_fork",
    sessionKey: scope.sessionKey,
    ...(forkEntryId
      ? {
          predecessor: {
            forkEntryId,
            forkPosition: event.position,
          },
        }
      : {}),
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a checkpoint-relevant session_before_compact trigger event.
 *
 * @param scope - Resolved session scope.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildSkelnSessionBeforeCompactTriggerEvent(scope: AgenrSkelnSessionScope): SessionMemoryTriggerEvent {
  return {
    type: "session_before_compact",
    sessionKey: scope.sessionKey,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a session_compact trigger event with a compaction checkpoint artifact.
 *
 * @param scope - Resolved session scope.
 * @param event - Skeln compaction payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildSkelnSessionCompactTriggerEvent(scope: AgenrSkelnSessionScope, event: SkelnSessionCompactEvent): SessionMemoryTriggerEvent {
  const compactionEntry = event.compactionEntry;

  return {
    type: "session_compact",
    sessionKey: scope.sessionKey,
    artifact: buildCompactionCheckpointArtifact(scope.sessionKey, compactionEntry, event.fromExtension),
    workingScope: toWorkingScopeFromSkelnSession(scope),
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a checkpoint-relevant session_before_tree trigger event.
 *
 * @param scope - Resolved session scope.
 * @param event - Skeln before-tree payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildSkelnSessionBeforeTreeTriggerEvent(scope: AgenrSkelnSessionScope, event: SkelnSessionBeforeTreeEvent): SessionMemoryTriggerEvent {
  return {
    type: "session_before_tree",
    sessionKey: scope.sessionKey,
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a session_tree trigger event, optionally carrying a branch-abandonment artifact.
 *
 * @param scope - Resolved session scope.
 * @param event - Skeln tree-navigation payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildSkelnSessionTreeTriggerEvent(scope: AgenrSkelnSessionScope, event: SkelnSessionTreeEvent): SessionMemoryTriggerEvent {
  const summaryEntry = event.summaryEntry;
  const artifact = summaryEntry
    ? ({
        kind: "branch_abandonment",
        source: "skeln",
        sourceId: summaryEntry.id,
        sourceRef: `branch_summary:${summaryEntry.id}`,
        summary: summaryEntry.summary,
        metadata: {
          fromId: summaryEntry.fromId,
          oldLeafId: event.oldLeafId,
          newLeafId: event.newLeafId,
          ...(event.fromExtension !== undefined ? { fromExtension: event.fromExtension } : {}),
        },
      } satisfies SessionArtifactInput)
    : undefined;

  return {
    type: "session_tree",
    sessionKey: scope.sessionKey,
    ...(artifact ? { artifact } : {}),
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Builds a checkpoint-relevant session_shutdown trigger event.
 *
 * @param scope - Resolved session scope.
 * @param event - Skeln shutdown payload.
 * @returns Canonical session-memory lifecycle event.
 */
export function buildSkelnSessionShutdownTriggerEvent(scope: AgenrSkelnSessionScope, event: SkelnSessionShutdownEvent): SessionMemoryTriggerEvent {
  return {
    type: "session_shutdown",
    sessionKey: scope.sessionKey,
    workingScope: toWorkingScopeFromSkelnSession(scope),
    shutdownReason: event.reason,
    payload: event,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Logs structured session-memory trigger outcomes for Skeln lifecycle hooks.
 *
 * @param result - Router result for one lifecycle trigger.
 */
export function logSessionMemoryTriggerResult(result: SessionMemoryTriggerResult): void {
  if (result.accepted || result.reason === "feature_disabled") {
    return;
  }

  console.warn(`[agenr] session-memory trigger rejected: ${result.reason} (${result.message})`);
}

/** Resolves the canonical session-start transition reason from Skeln facts. */
function resolveSessionStartTransitionReason(
  reason: SkelnSessionStartTransition["reason"],
  previousSessionFile: string | undefined,
): SessionStartTransitionReason {
  if (isLineageSessionStartReason(reason)) {
    return reason;
  }

  return previousSessionFile ? "resume" : "new";
}

/** Checks whether a Skeln session_start reason creates lineage. */
function isLineageSessionStartReason(reason: SkelnSessionStartTransition["reason"] | undefined): reason is SkelnLineageSessionStartReason {
  return reason !== undefined && LINEAGE_SESSION_START_REASONS.has(reason as SkelnLineageSessionStartReason);
}

/** Builds predecessor facts for session-start lineage intake. */
function buildSessionStartPredecessor(
  transitionReason: SessionStartTransitionReason,
  previousSessionFile: string | undefined,
): SessionMemoryTriggerEvent["predecessor"] | undefined {
  if (transitionReason === "new") {
    return undefined;
  }

  const sourceRef = previousSessionFile?.trim();
  if (!sourceRef) {
    return undefined;
  }

  return { sourceRef };
}

/** Builds one compaction checkpoint artifact from Skeln compaction facts. */
function buildCompactionCheckpointArtifact(
  sessionKey: string,
  compactionEntry: SkelnSessionCompactEvent["compactionEntry"],
  fromExtension: boolean,
): SessionArtifactInput {
  return {
    kind: "compaction_checkpoint",
    sessionKey,
    source: "skeln",
    sourceId: compactionEntry.id,
    sourceRef: `compaction:${compactionEntry.id}`,
    summary: compactionEntry.summary,
    metadata: {
      firstKeptEntryId: compactionEntry.firstKeptEntryId,
      fromExtension,
    },
  };
}
