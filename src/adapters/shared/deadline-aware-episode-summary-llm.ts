import type { EpisodeIngestLlmPort, EpisodeIngestUsageStats } from "../../app/episode-ingest/index.js";
import { raceEpisodeSummaryWithinTimeout } from "./bounded-episode-summary.js";

/**
 * Wraps one episode-ingest LLM port so each completion races the shared summary deadline.
 *
 * @param baseLlm - Underlying LLM port.
 * @param deadlineMs - Absolute deadline in epoch milliseconds.
 * @returns LLM port that enforces the remaining budget on every call.
 */
export function createDeadlineAwareEpisodeSummaryLlm(baseLlm: EpisodeIngestLlmPort, deadlineMs: number): EpisodeIngestLlmPort {
  const usage = cloneUsageStats(baseLlm.metadata.usage);
  const completeWithTimeout = async <T>(task: Promise<T>): Promise<T> => {
    usage.calls += 1;
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    return raceEpisodeSummaryWithinTimeout(task, remainingMs);
  };

  return {
    complete: async (systemPrompt: string, userMessage: string): Promise<string> => completeWithTimeout(baseLlm.complete(systemPrompt, userMessage)),
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => completeWithTimeout(baseLlm.completeJson<T>(systemPrompt, userMessage)),
    metadata: {
      ...baseLlm.metadata,
      usage,
    },
  };
}

/** Clones usage counters so deadline wrapping can track call counts independently. */
function cloneUsageStats(usage: EpisodeIngestUsageStats): EpisodeIngestUsageStats {
  return { ...usage };
}
