export {
  buildEpisodeSummaryPrompt as buildOpenClawEpisodeSummaryPrompt,
  EPISODE_SUMMARY_SYSTEM_PROMPT as OPENCLAW_EPISODE_SUMMARY_SYSTEM_PROMPT,
  parseEpisodeSummaryResponse as parseOpenClawEpisodeSummaryResponse,
  type EpisodeSummaryOutput as OpenClawEpisodeSummaryOutput,
} from "../../../core/episode/summary-prompt.js";

/**
 * Fixed generator version stored on episodic-memory rows written by the
 * OpenClaw adapter.
 */
// eslint-disable-next-line jsdoc/require-jsdoc
export const OPENCLAW_EPISODE_GENERATOR_VERSION = "openclaw-episodic-summary-v1";
