import { resolveAgenrFeatureFlags } from "../../app/features/resolve.js";
import type { SessionMemoryRepository } from "../../app/session-memory/repository.js";
import type { AgenrFeatureFlagConfig } from "../../app/features/types.js";
import type { CompactionPromptTracker } from "./compaction-prompt-tracker.js";
import { formatCompactionRecallContext } from "./injection/compaction-context.js";

/**
 * Resolves compaction checkpoint context for prompt injection after compaction.
 *
 * @param params - Session identity, feature flags, repository, and dedupe tracker.
 * @returns Markdown block for injection, or undefined when nothing should inject.
 */
export async function resolveCompactionPromptContext(params: {
  sessionId: string | undefined;
  sessionKey: string;
  features?: AgenrFeatureFlagConfig;
  sessionMemoryRepository?: SessionMemoryRepository;
  tracker: CompactionPromptTracker;
}): Promise<string | undefined> {
  const featureFlags = resolveAgenrFeatureFlags(params.features);
  if (!featureFlags.sessionTreeCompaction || !params.sessionMemoryRepository) {
    return undefined;
  }

  const artifacts = await params.sessionMemoryRepository.listSessionArtifacts({
    sessionKey: params.sessionKey,
    kinds: ["compaction_checkpoint"],
    limit: 1,
  });
  const artifact = artifacts[0];
  if (!artifact || !params.tracker.shouldInject(params.sessionId, params.sessionKey, artifact.sourceId)) {
    return undefined;
  }

  params.tracker.markInjected(params.sessionId, params.sessionKey, artifact.sourceId);
  return formatCompactionRecallContext(artifact);
}
