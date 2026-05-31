import type { EpisodeIngestLlmPort } from "../../app/episode-ingest/index.js";
import { createLlmClient } from "../llm.js";

/**
 * Wraps the configured agenr LLM client in episode-ingest metadata.
 *
 * @param provider - Resolved model provider.
 * @param modelId - Resolved model identifier.
 * @param apiKey - Provider API key.
 * @returns Episode-ingest LLM port backed by the shared agenr client.
 */
export function createAgenrEpisodeSummaryLlm(provider: string, modelId: string, apiKey: string): EpisodeIngestLlmPort {
  const client = createLlmClient(provider, modelId, { apiKey });
  return {
    complete: client.complete,
    completeJson: client.completeJson,
    metadata: {
      modelRef: `${provider}/${modelId}`,
      pricing: {
        input: client.metadata.model.cost?.input ?? 0,
        output: client.metadata.model.cost?.output ?? 0,
        cacheRead: client.metadata.model.cost?.cacheRead ?? 0,
        cacheWrite: client.metadata.model.cost?.cacheWrite ?? 0,
      },
      usage: client.metadata.usage,
    },
  };
}
