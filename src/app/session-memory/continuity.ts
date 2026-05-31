import type { SessionMemoryRepository } from "./repository.js";
import type { SessionArtifact, SessionLineageEdge } from "./types.js";

/** Continuity artifact kinds resolved for predecessor lookup. */
const CONTINUITY_ARTIFACT_KINDS = ["continuity_summary", "recent_session"] as const;

/** Request accepted by host-neutral predecessor-continuity lookup. */
export interface ResolvePredecessorContinuityInput {
  /** Child session key receiving continuity context. */
  sessionKey: string;
}

/** Host-neutral predecessor-continuity lookup result. */
export interface PredecessorContinuityContext {
  /** Latest lineage edge for the requested child session. */
  lineageEdge?: SessionLineageEdge;
  /** Artifacts selected from the predecessor session. */
  artifacts: SessionArtifact[];
  /** Continuity summary text when available. */
  continuitySummaryText?: string;
  /** Recent-session tail text when available. */
  recentSessionText?: string;
}

/**
 * Resolves predecessor continuity from schema v12 lineage and artifact rows.
 *
 * @param input - Child session key to resolve.
 * @param repository - Session-memory repository.
 * @returns Continuity text derived from predecessor artifacts.
 */
export async function resolvePredecessorContinuityContext(
  input: ResolvePredecessorContinuityInput,
  repository: SessionMemoryRepository,
): Promise<PredecessorContinuityContext> {
  const sessionKey = input.sessionKey.trim();
  if (!sessionKey) {
    return {
      artifacts: [],
    };
  }

  const lineageEdge = await repository.getLatestLineageEdgeForChild(sessionKey);
  const predecessorSessionKey = lineageEdge?.parentSessionKey?.trim();
  const parentSourceRef = lineageEdge?.parentSourceRef?.trim();
  if (!predecessorSessionKey && !parentSourceRef) {
    return {
      ...(lineageEdge ? { lineageEdge } : {}),
      artifacts: [],
    };
  }

  let artifacts: SessionArtifact[] = [];
  if (predecessorSessionKey) {
    artifacts = await repository.listSessionArtifacts({
      sessionKey: predecessorSessionKey,
      kinds: [...CONTINUITY_ARTIFACT_KINDS],
      limit: 10,
    });
  } else if (parentSourceRef) {
    artifacts = await repository.listSessionArtifactsBySourceRef({
      sourceRef: parentSourceRef,
      kinds: [...CONTINUITY_ARTIFACT_KINDS],
      limit: 10,
    });
  }
  const continuitySummaryText = latestArtifactSummary(artifacts, "continuity_summary");
  const recentSessionText = latestArtifactSummary(artifacts, "recent_session");

  return {
    ...(lineageEdge ? { lineageEdge } : {}),
    artifacts,
    ...(continuitySummaryText ? { continuitySummaryText } : {}),
    ...(recentSessionText ? { recentSessionText } : {}),
  };
}

/** Selects the newest artifact summary for one kind. */
function latestArtifactSummary(artifacts: SessionArtifact[], kind: (typeof CONTINUITY_ARTIFACT_KINDS)[number]): string | undefined {
  const artifact = artifacts.find((candidate) => candidate.kind === kind);
  return artifact?.summary.trim() || undefined;
}
