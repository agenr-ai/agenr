import { createHash } from "node:crypto";

import type { SessionMemoryFeatureFlags } from "../features/types.js";
import type { WorkingMemoryService } from "../working-memory/service.js";
import { normalizeOptionalString } from "./normalize.js";
import type { RecordTriggerIntakeInput, SessionMemoryRepository, UpsertSessionLineageEdgeInput } from "./repository.js";
import type {
  SessionMemoryTriggerAcceptedResult,
  SessionMemoryTriggerAction,
  SessionMemoryTriggerRejectedResult,
  SessionMemoryTriggerResult,
} from "./results.js";
import {
  SESSION_LINEAGE_REASONS,
  type NormalizedSessionArtifactInput,
  type SessionArtifact,
  type SessionArtifactInput,
  type SessionLineageEdge,
  type SessionLineageReason,
  type SessionMemoryTriggerEvent,
  type SessionMemoryTriggerType,
} from "./types.js";

export type {
  SessionMemoryTriggerAcceptedResult,
  SessionMemoryTriggerAction,
  SessionMemoryTriggerFailureReason,
  SessionMemoryTriggerRejectedResult,
  SessionMemoryTriggerResult,
} from "./results.js";

/** Dependencies used by the session-memory trigger router. */
export interface SessionMemoryTriggerRouterDeps {
  /** Repository used once session-memory feature flags are enabled. */
  repository?: SessionMemoryRepository;
  /** Whether working-memory checkpoint refresh is enabled for lifecycle intake. */
  workingMemoryEnabled?: boolean;
  /** Working-memory service used to refresh checkpoints after compaction intake. */
  workingMemory?: WorkingMemoryService;
}

/**
 * Feature flag required for each session-memory lifecycle trigger.
 */
const SESSION_MEMORY_TRIGGER_FLAGS: Record<SessionMemoryTriggerType, keyof SessionMemoryFeatureFlags> = {
  session_start: "sessionTreeLineage",
  session_before_fork: "sessionTreeLineage",
  session_before_compact: "sessionTreeCompaction",
  session_compact: "sessionTreeCompaction",
  session_before_tree: "sessionTreeCompaction",
  session_tree: "sessionTreeLineage",
  session_shutdown: "sessionTreeLineage",
};

const LINEAGE_REASONS = new Set<SessionLineageReason>(SESSION_LINEAGE_REASONS);

/**
 * Routes session-memory lifecycle triggers through feature gates and schema v12
 * persistence.
 *
 * @param event - Host lifecycle event.
 * @param featureFlags - Resolved runtime feature flags.
 * @param deps - Optional persistence dependencies.
 * @returns Intake result for the lifecycle event.
 */
export async function routeSessionMemoryTrigger(
  event: SessionMemoryTriggerEvent,
  featureFlags: SessionMemoryFeatureFlags,
  deps: SessionMemoryTriggerRouterDeps = {},
): Promise<SessionMemoryTriggerResult> {
  const flagKey = SESSION_MEMORY_TRIGGER_FLAGS[event.type];
  if (!featureFlags[flagKey]) {
    return {
      accepted: false,
      reason: "feature_disabled",
      message: `Session-memory trigger ${event.type} is disabled by feature flags.`,
    };
  }

  if (!deps.repository) {
    return {
      accepted: false,
      reason: "misconfigured",
      message: `Session-memory trigger ${event.type} is enabled, but no session-memory repository was wired into the runtime.`,
    };
  }

  const artifactInput = normalizeArtifactInput(event);
  if (artifactInput.kind === "invalid") {
    return invalidEvent(artifactInput.message);
  }

  const lineageInput = normalizeLineageInput(event);
  if (lineageInput.kind === "invalid") {
    return invalidEvent(lineageInput.message);
  }

  if (artifactInput.kind === "none" && lineageInput.kind === "none") {
    return maybeAttachWorkingCheckpointRefresh(
      event,
      {
        accepted: true,
        action: isCheckpointRelevantTrigger(event.type) ? "checkpoint_relevant" : "no_lineage",
        message: isCheckpointRelevantTrigger(event.type)
          ? `Session-memory trigger ${event.type} was accepted for checkpoint-relevant lifecycle handling.`
          : `Session-memory trigger ${event.type} did not include lineage or artifact facts.`,
      },
      deps,
    );
  }

  const intakeInput: RecordTriggerIntakeInput = {
    ...(artifactInput.kind === "artifact" ? { artifact: artifactInput.input } : {}),
    ...(lineageInput.kind === "lineage" ? { lineage: lineageInput.input } : {}),
  };
  const intake = await deps.repository.recordTriggerIntake(intakeInput);
  const artifact = intake.artifact;
  const lineageEdge = intake.lineageEdge;
  const action = resolveTriggerAction(artifact, lineageEdge);

  return maybeAttachWorkingCheckpointRefresh(
    event,
    {
      accepted: true,
      action,
      message: buildAcceptedMessage(event.type, action, artifact, lineageEdge),
      ...(lineageEdge ? { lineageEdge } : {}),
      ...(artifact ? { artifact } : {}),
    },
    deps,
  );
}

/**
 * Enriches accepted intake results with working-checkpoint refresh diagnostics when enabled.
 *
 * @param event - Session lifecycle event already accepted by session-memory intake.
 * @param result - Accepted intake result to enrich when checkpoint refresh applies.
 * @param deps - Router dependencies including working-memory wiring.
 * @returns The accepted result, optionally enriched with refresh diagnostics.
 */
async function maybeAttachWorkingCheckpointRefresh(
  event: SessionMemoryTriggerEvent,
  result: SessionMemoryTriggerAcceptedResult,
  deps: SessionMemoryTriggerRouterDeps,
): Promise<SessionMemoryTriggerAcceptedResult> {
  if (!deps.workingMemoryEnabled) {
    return result;
  }

  const { attachWorkingCheckpointRefresh } = await import("../working-memory/lifecycle-checkpoint.js");
  return attachWorkingCheckpointRefresh(event, result, deps.workingMemory);
}

/** Resolves a lineage edge payload from one lifecycle event. */
function normalizeLineageInput(
  event: SessionMemoryTriggerEvent,
): { kind: "lineage"; input: UpsertSessionLineageEdgeInput } | { kind: "none" } | { kind: "invalid"; message: string } {
  if (!event.transitionReason || event.transitionReason === "new" || event.transitionReason === "unknown") {
    return { kind: "none" };
  }

  if (!LINEAGE_REASONS.has(event.transitionReason)) {
    return { kind: "invalid", message: `Unsupported session lineage reason "${event.transitionReason}".` };
  }

  const childSessionKey = normalizeOptionalString(event.childSessionKey) ?? normalizeOptionalString(event.sessionKey);
  if (!childSessionKey) {
    return { kind: "invalid", message: "Session lineage requires a child session key." };
  }

  const parentSessionKey = normalizeOptionalString(event.predecessor?.sessionKey);
  const parentSourceRef = normalizeOptionalString(event.predecessor?.sourceRef);
  if (!parentSessionKey && !parentSourceRef) {
    return { kind: "none" };
  }

  const forkEntryId = normalizeOptionalString(event.predecessor?.forkEntryId);
  const forkPosition = normalizeOptionalString(event.predecessor?.forkPosition);

  return {
    kind: "lineage",
    input: {
      childSessionKey,
      ...(parentSessionKey ? { parentSessionKey } : {}),
      ...(parentSourceRef ? { parentSourceRef } : {}),
      reason: event.transitionReason,
      ...(forkEntryId ? { forkEntryId } : {}),
      ...(forkPosition ? { forkPosition } : {}),
      observedAt: event.observedAt,
    },
  };
}

/** Resolves a session artifact payload from one lifecycle event. */
function normalizeArtifactInput(
  event: SessionMemoryTriggerEvent,
): { kind: "artifact"; input: NormalizedSessionArtifactInput } | { kind: "none" } | { kind: "invalid"; message: string } {
  if (!event.artifact) {
    return { kind: "none" };
  }

  const sessionKey = normalizeOptionalString(event.artifact.sessionKey) ?? normalizeOptionalString(event.sessionKey);
  if (!sessionKey) {
    return { kind: "invalid", message: "Session artifact intake requires a session key." };
  }

  const source = normalizeOptionalString(event.artifact.source);
  const sourceId = normalizeOptionalString(event.artifact.sourceId);
  const summary = normalizeOptionalString(event.artifact.summary);
  if (!source || !sourceId || !summary) {
    return { kind: "invalid", message: "Session artifact intake requires source, sourceId, and summary." };
  }

  const contentHash = normalizeOptionalString(event.artifact.contentHash) ?? hashArtifactContent(event.artifact);
  return {
    kind: "artifact",
    input: {
      ...event.artifact,
      sessionKey,
      source,
      sourceId,
      summary,
      contentHash,
    },
  };
}

/** Builds a stable hash when callers do not provide one. */
function hashArtifactContent(artifact: SessionArtifactInput): string {
  const payload = JSON.stringify({
    kind: artifact.kind,
    source: artifact.source,
    sourceId: artifact.sourceId,
    sourceRef: artifact.sourceRef,
    summary: artifact.summary,
    metadata: artifact.metadata,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** Resolves the accepted action from persisted facts. */
function resolveTriggerAction(artifact: SessionArtifact | undefined, lineageEdge: SessionLineageEdge | undefined): SessionMemoryTriggerAction {
  if (artifact && lineageEdge) {
    return "recorded";
  }

  if (artifact) {
    return "artifact_recorded";
  }

  return "lineage_recorded";
}

/** Builds a human-readable accepted-event message. */
function buildAcceptedMessage(
  triggerType: SessionMemoryTriggerType,
  action: SessionMemoryTriggerAction,
  artifact: SessionArtifact | undefined,
  lineageEdge: SessionLineageEdge | undefined,
): string {
  if (action === "recorded" && artifact && lineageEdge) {
    return `Session-memory trigger ${triggerType} recorded ${lineageEdge.reason} lineage edge ${lineageEdge.id} and ${artifact.kind} artifact ${artifact.id}.`;
  }

  if (action === "artifact_recorded" && artifact) {
    return `Session-memory trigger ${triggerType} recorded ${artifact.kind} artifact ${artifact.id}.`;
  }

  if (lineageEdge) {
    return `Session-memory trigger ${triggerType} recorded ${lineageEdge.reason} lineage edge ${lineageEdge.id}.`;
  }

  return `Session-memory trigger ${triggerType} was accepted.`;
}

/** Builds a stable invalid-event response. */
function invalidEvent(message: string): SessionMemoryTriggerRejectedResult {
  return {
    accepted: false,
    reason: "invalid_event",
    message,
  };
}

/** Whether a trigger may be accepted without lineage or artifact facts yet. */
function isCheckpointRelevantTrigger(type: SessionMemoryTriggerType): boolean {
  return type === "session_before_fork" || type === "session_before_compact" || type === "session_before_tree" || type === "session_shutdown";
}

export { SESSION_MEMORY_TRIGGER_FLAGS };
