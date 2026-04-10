import { EPISODE_ACTIVITY_LEVELS, type EpisodeActivityLevel } from "../types.js";

/**
 * Structured episodic summary payload returned by the episode generator.
 */
export interface EpisodeSummaryOutput {
  /**
   * Historical prose summary of the session.
   */
  summary: string;
  /**
   * Lowercase anchor tags drawn from the session content.
   */
  tags: string[];
  /**
   * Activity classification for the session.
   */
  activityLevel: EpisodeActivityLevel;
  /**
   * Optional project scope inferred from the session.
   */
  project?: string;
}

/**
 * System prompt used for episodic summary generation.
 *
 * @type {string}
 */
export const EPISODE_SUMMARY_SYSTEM_PROMPT = [
  "You write strict JSON episode summaries for historical recall.",
  "The transcript can be about any topic - technical work, casual conversation, planning, research, creative projects, life events, or anything else.",
  "Do not assume any particular domain.",
  "Describe only what happened in this session.",
  "Do not carry inherited context or open loops forward unless the session actively worked on them.",
  "Return exactly one JSON object with this shape:",
  '{ "summary": string, "tags": string[], "activityLevel": "substantial" | "minimal" | "none", "project": string | null }',
  "Requirements:",
  "- summary must be 100 to 300 words in plain prose (roughly 4 to 10 sentences)",
  "- describe what was discussed, decided, or accomplished - not a turn-by-turn replay",
  "- this is a narrative overview for historical recall, not a verbatim record",
  "- preserve concrete details worth remembering: names, places, dates, specific decisions, key topics, and notable specifics that would help someone recall this session months later",
  "- tags must be 3 to 8 short lowercase anchors drawn from the actual session content",
  "- project should be null when no clear project scope appears",
  "- activityLevel: use substantial when meaningful discussion or work occurred, minimal when the session was brief or lightweight, none when essentially nothing happened",
  "- do not include Markdown fences or extra commentary",
].join("\n");

/**
 * Builds the user prompt for one episodic summary generation call.
 *
 * @param transcript - Cleaned transcript text rendered for the summarizer.
 * @returns Prompt text sent to the model.
 */
export function buildEpisodeSummaryPrompt(transcript: string): string {
  return [
    "Produce a historical episodic summary for this completed session.",
    "Describe what was discussed, decided, or accomplished during this transcript window.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

/**
 * Parses and validates a best-effort structured summary response.
 *
 * @param value - Raw model text response.
 * @returns Structured episode summary output, or null when parsing fails.
 */
export function parseEpisodeSummaryResponse(value: string): EpisodeSummaryOutput | null {
  const parsed = parseJsonObject(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const parsedRecord = parsed as Record<string, unknown>;

  const summary = normalizeSummary(parsedRecord.summary);
  const activityLevel = normalizeActivityLevel(parsedRecord.activityLevel);
  if (!summary || !activityLevel) {
    return null;
  }

  return {
    summary,
    tags: normalizeTags(parsedRecord.tags),
    activityLevel,
    ...(normalizeProject(parsedRecord.project) ? { project: normalizeProject(parsedRecord.project) } : {}),
  };
}

/**
 * Normalizes a summary string while collapsing internal whitespace.
 *
 * @param value - Candidate summary value.
 * @returns Normalized summary, or null when invalid.
 */
function normalizeSummary(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized : null;
}

/**
 * Normalizes activity-level output into the supported enum values.
 *
 * @param value - Candidate activity-level value.
 * @returns Supported activity level, or null when invalid.
 */
function normalizeActivityLevel(value: unknown): EpisodeActivityLevel | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return EPISODE_ACTIVITY_LEVELS.includes(normalized as EpisodeActivityLevel) ? (normalized as EpisodeActivityLevel) : null;
}

/**
 * Normalizes tag output into lowercase deduped anchors.
 *
 * @param value - Candidate tag payload.
 * @returns Stable tag list capped to eight values.
 */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ).slice(0, 8);
}

/**
 * Normalizes the optional project field.
 *
 * @param value - Candidate project value.
 * @returns Normalized project string, or undefined when absent.
 */
function normalizeProject(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized : undefined;
}

/**
 * Attempts to parse a JSON object from plain text, fenced JSON, or extra
 * wrapper text.
 *
 * @param value - Raw model output.
 * @returns Parsed JSON value, or null when parsing fails.
 */
function parseJsonObject(value: string): unknown | null {
  const candidates = collectJsonCandidates(value);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Collects likely JSON substrings from a model response.
 *
 * @param value - Raw model output.
 * @returns Candidate JSON strings to try in order.
 */
function collectJsonCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates = new Set<string>();
  if (trimmed) {
    candidates.add(trimmed);
  }

  const fencedMatches = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/giu) ?? [];
  for (const match of fencedMatches) {
    const normalized = match
      .replace(/```(?:json)?/iu, "")
      .replace(/```/gu, "")
      .trim();
    if (normalized) {
      candidates.add(normalized);
    }
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.add(trimmed.slice(objectStart, objectEnd + 1));
  }

  return [...candidates];
}
