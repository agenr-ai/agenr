import type { EpisodeDatabasePort, RecallPorts } from "../../core/ports.js";
import { recall } from "../../core/recall/search.js";
import { parseTemporalWindow } from "../../core/episode/temporal-window.js";
import { searchEpisodes } from "../../core/episode/search.js";
import type { RecallInput } from "../../core/recall/types.js";

import type { UnifiedRecallInput, UnifiedRecallMode, UnifiedRecallResult, UnifiedRecallRouting } from "./types.js";

const EPISODE_FRESHNESS_NOTICE = "Episodes cover consolidated prior sessions only; the most recent completed session may not appear yet.";
const EPISODE_TIME_NOTICE =
  "Episode recall needs a supported time phrase in the query, such as 'yesterday', 'last week', 'this month', '2 weeks ago', or 'in March'.";
const ENTRY_FILTER_NOTICE = "Threshold, type filters, and tag filters were applied to entries only.";

/**
 * Dependencies needed by the unified recall orchestration layer.
 */
export interface UnifiedRecallDeps {
  database: EpisodeDatabasePort;
  recall: RecallPorts;
  embeddingAvailable: boolean;
  embeddingError?: string;
  now?: Date;
}

/**
 * Runs unified recall across semantic entries and episodic memory using routing rules.
 *
 * @param input - Agent-facing recall request.
 * @param deps - Episode database, entry recall ports, and embedding availability facts.
 * @returns Structured recall response with routing metadata and separate result sections.
 */
export async function runUnifiedRecall(input: UnifiedRecallInput, deps: UnifiedRecallDeps): Promise<UnifiedRecallResult> {
  const now = deps.now ?? new Date();
  const requested = normalizeMode(input.mode);
  const parsedTimeWindow = parseTemporalWindow(input.text, now);
  const routing = routeRecall({
    requested,
    text: input.text,
    parsedTimeWindow: parsedTimeWindow !== null,
    hasEntryFilters: Boolean((input.types?.length ?? 0) > 0 || (input.tags?.length ?? 0) > 0),
  });
  const notices: string[] = [];
  const episodes =
    routing.queried.includes("episodes") && parsedTimeWindow
      ? await searchEpisodes(
          {
            text: input.text,
            limit: input.limit,
            timeWindow: parsedTimeWindow.window,
          },
          deps.database,
          now,
        )
      : [];

  if (routing.queried.includes("episodes")) {
    notices.push(EPISODE_FRESHNESS_NOTICE);
    if (!parsedTimeWindow) {
      notices.push(EPISODE_TIME_NOTICE);
    }
  }

  if (routing.queried.includes("episodes") && hasEntryScopedFilters(input)) {
    notices.push(ENTRY_FILTER_NOTICE);
  }

  const entries = await maybeRunEntryRecall({
    input,
    deps,
    parsedTimeWindow,
    routing,
  });
  if (routing.queried.includes("entries") && entries.kind === "skipped") {
    notices.push(entries.notice);
  }

  return {
    routing,
    ...(parsedTimeWindow
      ? {
          parsedTimeWindow,
          timeWindow: {
            start: parsedTimeWindow.bounds.start.toISOString(),
            end: parsedTimeWindow.bounds.end.toISOString(),
            timezone: parsedTimeWindow.timezone,
            resolvedFrom: parsedTimeWindow.resolvedFrom,
          },
        }
      : {}),
    episodes,
    entries: entries.kind === "results" ? entries.results : [],
    notices: dedupePreservingOrder(notices),
    count: episodes.length + (entries.kind === "results" ? entries.results.length : 0),
  };
}

/**
 * Routes one unified recall request into entry and/or episode subqueries.
 *
 * @param params - Recall mode, query text, and detected signals.
 * @returns Stable routing metadata reported to the caller.
 */
export function routeRecall(params: { requested: UnifiedRecallMode; text: string; parsedTimeWindow: boolean; hasEntryFilters: boolean }): UnifiedRecallRouting {
  const lower = params.text.trim().toLowerCase();
  const factual = /^(when did|when was|what decision|what preference|what(?:'s| is) the default|which version|what threshold)\b/.test(lower);
  const narrative = /\b(what happened|what were we doing|what was going on|summarize|catch me up)\b/.test(lower);
  const topicAnchor = params.hasEntryFilters || /\b(about|regarding|with)\b/.test(lower) || /\bon\s+[a-z][a-z0-9_-]{1,}\b/.test(lower);

  if (params.requested === "entries") {
    return {
      requested: params.requested,
      detectedIntent: factual ? "factual" : params.parsedTimeWindow ? "mixed" : "factual",
      queried: ["entries"],
      reason: "Explicit mode=entries override.",
    };
  }

  if (params.requested === "episodes") {
    return {
      requested: params.requested,
      detectedIntent: params.parsedTimeWindow ? "temporal_narrative" : "mixed",
      queried: ["episodes"],
      reason: params.parsedTimeWindow
        ? "Explicit mode=episodes override with a resolved time window."
        : "Explicit mode=episodes override without a resolved time window.",
    };
  }

  if (factual && params.parsedTimeWindow) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["entries", "episodes"],
      reason: "The query combines a factual phrase with a supported time expression, so both entries and episodes were queried.",
    };
  }

  if (factual) {
    return {
      requested: params.requested,
      detectedIntent: "factual",
      queried: ["entries"],
      reason: "The query looks like an exact fact lookup, so entry recall was used.",
    };
  }

  if (params.parsedTimeWindow && narrative && topicAnchor) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["episodes", "entries"],
      reason: "The query combines narrative time-based recall with a topic anchor, so both episodes and entries were queried.",
    };
  }

  if (params.parsedTimeWindow && narrative) {
    return {
      requested: params.requested,
      detectedIntent: "temporal_narrative",
      queried: ["episodes"],
      reason: "The query asks for what happened during a time period, so episode recall was used first.",
    };
  }

  if (params.parsedTimeWindow && topicAnchor) {
    return {
      requested: params.requested,
      detectedIntent: "mixed",
      queried: ["episodes", "entries"],
      reason: "The query contains both a supported time expression and a topic anchor, so both episodes and entries were queried.",
    };
  }

  return {
    requested: params.requested,
    detectedIntent: "factual",
    queried: ["entries"],
    reason: params.parsedTimeWindow
      ? "The query did not clearly ask for narrative recall, so entry recall was used."
      : "No supported episode time window was detected, so entry recall was used.",
  };
}

/**
 * Executes entry recall when the router selected it and embeddings are available.
 *
 * @param params - Recall inputs, dependencies, parsed time window, and routing result.
 * @returns Entry results, a skip notice, or an error for explicit entry mode failures.
 */
async function maybeRunEntryRecall(params: {
  input: UnifiedRecallInput;
  deps: UnifiedRecallDeps;
  parsedTimeWindow: ReturnType<typeof parseTemporalWindow>;
  routing: UnifiedRecallRouting;
}): Promise<
  | {
      kind: "results";
      results: import("../../core/recall/types.js").RecallOutput[];
    }
  | {
      kind: "skipped";
      notice: string;
    }
> {
  if (!params.routing.queried.includes("entries")) {
    return {
      kind: "results",
      results: [],
    };
  }

  if (!params.deps.embeddingAvailable) {
    const message = params.deps.embeddingError ?? "Embeddings are unavailable, so entry recall could not run.";
    if (params.routing.requested === "entries") {
      throw new Error(message);
    }

    return {
      kind: "skipped",
      notice: `${message} Entry recall was skipped.`,
    };
  }

  return {
    kind: "results",
    results: await recall(buildEntryRecallInput(params.input, params.parsedTimeWindow), params.deps.recall),
  };
}

/**
 * Builds the internal semantic-recall request, including derived temporal bias.
 *
 * @param input - Unified recall request.
 * @param parsedTimeWindow - Optional resolved episode-style time window.
 * @returns Core entry recall input.
 */
function buildEntryRecallInput(input: UnifiedRecallInput, parsedTimeWindow: ReturnType<typeof parseTemporalWindow>): RecallInput {
  const request: RecallInput = {
    text: input.text,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(input.types && input.types.length > 0 ? { types: input.types } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  };

  if (!parsedTimeWindow) {
    return request;
  }

  const start = parsedTimeWindow.bounds.start;
  const end = parsedTimeWindow.bounds.end;
  const midpoint = new Date((start.getTime() + end.getTime()) / 2);
  const radiusDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 2 / (24 * 60 * 60 * 1000)));

  return {
    ...request,
    since: start.toISOString(),
    until: end.toISOString(),
    around: midpoint.toISOString(),
    aroundRadius: radiusDays,
  };
}

/**
 * Normalizes the public recall mode into a supported value.
 *
 * @param value - Optional caller-supplied mode.
 * @returns Normalized recall mode.
 */
function normalizeMode(value: UnifiedRecallMode | undefined): UnifiedRecallMode {
  return value === "entries" || value === "episodes" ? value : "auto";
}

/**
 * Returns whether the request uses filters that only affect entry recall in phase 4.
 *
 * @param input - Unified recall input.
 * @returns True when entry-only filters were supplied.
 */
function hasEntryScopedFilters(input: UnifiedRecallInput): boolean {
  return Boolean(input.threshold !== undefined || (input.types?.length ?? 0) > 0 || (input.tags?.length ?? 0) > 0);
}

/**
 * Removes duplicate notices while keeping stable insertion order.
 *
 * @param values - Ordered notice list.
 * @returns Deduplicated notice list.
 */
function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}
