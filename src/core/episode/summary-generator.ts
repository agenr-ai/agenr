import type { LlmPort } from "../ports.js";

import { buildEpisodeSummaryPrompt, EPISODE_SUMMARY_SYSTEM_PROMPT, parseEpisodeSummaryResponse, type EpisodeSummaryOutput } from "./summary-prompt.js";

/**
 * Generates one structured episodic summary from a rendered transcript.
 *
 * @param transcript - Rendered transcript text for the completed session.
 * @param llm - Model client used to generate the summary.
 * @returns Structured summary output, or null when the model response cannot be parsed.
 */
export async function generateEpisodeSummary(transcript: string, llm: LlmPort): Promise<EpisodeSummaryOutput | null> {
  const response = await llm.complete(EPISODE_SUMMARY_SYSTEM_PROMPT, buildEpisodeSummaryPrompt(transcript));
  return parseEpisodeSummaryResponse(response);
}
