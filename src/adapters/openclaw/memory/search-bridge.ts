import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

import { createEmbedQuery } from "../../plugin-runtime/embed-query.js";
import { runUnifiedRecall } from "../../../app/recall/index.js";
import type { RecallOutput } from "../../../core/recall/types.js";
import type { AgenrOpenClawServices } from "../types.js";

/**
 * Runs durable unified recall and maps results into OpenClaw memory-host search hits.
 *
 * @param query - Search query from OpenClaw memory tooling.
 * @param services - Shared OpenClaw runtime services.
 * @param options - Optional search limits and session scope.
 * @returns Memory search hits backed by agenr durable recall.
 */
export async function searchAgenrDurablesThroughMemoryHost(
  query: string,
  services: AgenrOpenClawServices,
  options: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  } = {},
): Promise<MemorySearchResult[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return [];
  }

  const limit = options.maxResults ?? 6;
  const minScore = options.minScore ?? 0;
  const result = await runUnifiedRecall(
    {
      text: trimmedQuery,
      mode: "durables",
      limit,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    },
    {
      database: services.episodes,
      procedures: services.procedures,
      recall: services.recall,
      embeddingAvailable: services.embeddingStatus.available,
      embeddingError: services.embeddingStatus.error,
      claimSlotPolicyConfig: services.pluginConfig.memoryPolicy?.slotPolicies,
      embedQuery: createEmbedQuery(services.embedding, services.embeddingStatus.available),
      recallOptions: {
        slotPolicyConfig: services.pluginConfig.memoryPolicy?.slotPolicies,
      },
    },
  );

  return result.entries
    .filter((entry) => entry.score >= minScore)
    .slice(0, limit)
    .map((entry) => toMemorySearchResult(entry));
}

/** Maps one durable recall hit into the OpenClaw memory-host search shape. */
function toMemorySearchResult(entry: RecallOutput): MemorySearchResult {
  const durable = entry.entry;
  const path = durable.claim_key?.trim() || durable.subject.trim() || durable.id;
  const snippet = durable.content.trim().slice(0, 400);

  return {
    path,
    startLine: 1,
    endLine: Math.max(1, snippet.split("\n").length),
    score: entry.score,
    snippet,
    source: "memory",
    citation: durable.id,
  };
}
