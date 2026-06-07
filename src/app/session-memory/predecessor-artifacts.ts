import type { SessionMemoryRepository } from "./repository.js";
import type { SessionArtifact, SessionLineageEdge } from "./types.js";

export /** Artifact kinds that can seed session-start durable recall from predecessor context. */ const SESSION_START_ARTIFACT_KINDS = [
  "compaction_checkpoint",
  "branch_abandonment",
  "session_episode",
] as const;

/** Request accepted by host-neutral predecessor artifact lookup. */
export interface ResolvePredecessorSessionArtifactsInput {
  /** Child session key receiving predecessor context. */
  sessionKey: string;
}

/** Host-neutral predecessor artifact lookup result. */
export interface PredecessorSessionArtifacts {
  /** Latest lineage edge for the requested child session. */
  lineageEdge?: SessionLineageEdge;
  /** Artifacts selected from the predecessor session. */
  artifacts: SessionArtifact[];
}

/**
 * Resolves predecessor session artifacts from schema v12 lineage and artifact rows.
 *
 * @param input - Child session key to resolve.
 * @param repository - Session-memory repository.
 * @returns Predecessor artifacts selected for session-start recall seeding.
 */
export async function resolvePredecessorSessionArtifacts(
  input: ResolvePredecessorSessionArtifactsInput,
  repository: SessionMemoryRepository,
): Promise<PredecessorSessionArtifacts> {
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

  const artifacts = predecessorSessionKey
    ? await repository.listSessionArtifacts({
        sessionKey: predecessorSessionKey,
        kinds: [...SESSION_START_ARTIFACT_KINDS],
        limit: 10,
      })
    : await repository.listSessionArtifactsBySourceRef({
        sourceRef: parentSourceRef!,
        kinds: [...SESSION_START_ARTIFACT_KINDS],
        limit: 10,
      });

  return {
    ...(lineageEdge ? { lineageEdge } : {}),
    artifacts,
  };
}
