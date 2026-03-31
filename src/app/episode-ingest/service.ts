import path from "node:path";

import { generateEpisodeSummary } from "../../core/episode/summary-generator.js";
import { buildEpisodeSummaryPrompt, EPISODE_SUMMARY_SYSTEM_PROMPT } from "../../core/episode/summary-prompt.js";
import { MAX_EPISODE_TRANSCRIPT_CHARS, MIN_EPISODE_MESSAGES, capEpisodeTranscript, renderTranscript } from "../../core/episode/transcript-render.js";
import { parseRelativeDate } from "../../core/recall/temporal.js";
import type { Episode } from "../../core/types.js";
import type { EpisodeIngestModelInfo, EpisodeIngestPorts, EpisodeIngestUsageStats, SessionMeta } from "./ports.js";
import type {
  BackfillEpisodeEmbeddingsOptions,
  CreateEpisodeIngestPlanOptions,
  EpisodeEmbeddingBackfillResult,
  EpisodeIngestCandidate,
  EpisodeIngestCandidateOverrides,
  EpisodeIngestExecutionResult,
  EpisodeIngestInvalidSession,
  EpisodeIngestPlan,
  EpisodeIngestPreflightResult,
  EpisodeTranscriptIngestResult,
  EpisodeIngestSessionResult,
  EpisodeIngestSkippedSession,
  ExecuteEpisodeIngestPlanOptions,
  IngestEpisodeTranscriptOptions,
  PrepareEpisodeIngestOptions,
} from "./types.js";

const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Internal classification options shared by batch and single-transcript ingest.
 */
interface ClassifyPreflightTranscriptOptions {
  /**
   * Reference time for active-session detection.
   */
  referenceNow: Date;
  /**
   * Whether existing episodes should remain eligible for regeneration.
   */
  regenerate: boolean;
  /**
   * Whether to bypass the active-session skip rule.
   */
  skipActiveSessionCheck?: boolean;
}

/**
 * Discovers OpenClaw transcripts, applies Stage 1 eligibility checks, and
 * prepares render-ready candidates for later episode generation.
 *
 * @param targetPath - File or directory path to inspect.
 * @param ports - Discovery, transcript, registry metadata, and episode lookup ports.
 * @param options - Optional regenerate flag, reference time, and preflight overrides.
 * @returns Aggregate Stage 1 preflight result.
 */
export async function prepareEpisodeIngest(
  targetPath: string,
  ports: EpisodeIngestPorts,
  options: PrepareEpisodeIngestOptions = {},
): Promise<EpisodeIngestPreflightResult> {
  const files = await ports.files.discoverFiles(targetPath);
  if (files.length === 0) {
    return createEmptyPreflightResult();
  }

  if (ports.sessionRegistry) {
    await ports.sessionRegistry.listSessions();
  }

  const requestedPreflightConcurrency = options.preflightConcurrency ?? 20;
  const preflightConcurrency = Number.isFinite(requestedPreflightConcurrency) ? Math.max(1, Math.trunc(requestedPreflightConcurrency)) : 20;
  const workerCount = Math.min(preflightConcurrency, files.length);
  const skippedByIndex = new Array<EpisodeIngestSkippedSession | undefined>(files.length);
  const invalidByIndex = new Array<EpisodeIngestInvalidSession | undefined>(files.length);
  const candidatesByIndex = new Array<EpisodeIngestCandidate | undefined>(files.length);
  const referenceNow = options.now ?? new Date();
  let nextIndex = 0;
  let completed = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= files.length) {
          return;
        }

        const filePath = files[currentIndex];
        if (!filePath) {
          return;
        }

        const result = await classifyPreflightTranscript(filePath, ports, {
          referenceNow,
          regenerate: options.regenerate === true,
        });
        if (result.kind === "candidate") {
          candidatesByIndex[currentIndex] = result.value;
        } else if (result.kind === "skipped") {
          skippedByIndex[currentIndex] = result.value;
        } else {
          invalidByIndex[currentIndex] = result.value;
        }

        completed += 1;
        options.onPreflightProgress?.(completed, files.length);
      }
    }),
  );

  const skipped = skippedByIndex.flatMap((entry) => (entry ? [entry] : []));
  const invalid = invalidByIndex.flatMap((entry) => (entry ? [entry] : []));
  const candidates = candidatesByIndex.flatMap((entry) => (entry ? [entry] : []));

  candidates.sort(compareCandidatesByEndedAt);

  return {
    files,
    candidates,
    skipped,
    invalid,
    totals: {
      discovered: files.length,
      candidates: candidates.length,
      skipped: skipped.length,
      invalid: invalid.length,
      skippedShort: skipped.filter((entry) => entry.reason === "skipped_short").length,
      skippedActive: skipped.filter((entry) => entry.reason === "skipped_active").length,
      skippedExists: skipped.filter((entry) => entry.reason === "skipped_exists").length,
    },
  };
}

/**
 * Stable classification result produced for one preflight transcript.
 */
type PreflightTranscriptClassification =
  | { kind: "candidate"; value: EpisodeIngestCandidate }
  | { kind: "skipped"; value: EpisodeIngestSkippedSession }
  | { kind: "invalid"; value: EpisodeIngestInvalidSession };

/**
 * Parses one transcript file and classifies it for Stage 1 preflight.
 *
 * @param filePath - Absolute transcript path.
 * @param ports - Episode-ingest service ports.
 * @param options - Reference time plus eligibility controls for this classification.
 * @returns One candidate, skipped-session record, or invalid-session record.
 */
async function classifyPreflightTranscript(
  filePath: string,
  ports: EpisodeIngestPorts,
  options: ClassifyPreflightTranscriptOptions,
): Promise<PreflightTranscriptClassification> {
  const parsedTranscript = await ports.transcript.parseFile(filePath);
  const cleanedMessages = parsedTranscript.messages.filter((message) => message.text.trim().length > 0);
  const parsedSessionId = parsedTranscript.metadata.sessionId?.trim() || undefined;
  const registryMeta = parsedSessionId ? await ports.sessionRegistry?.getSessionMeta(parsedSessionId) : undefined;
  const reconstructedMeta = registryMeta
    ? undefined
    : {
        surface: parsedTranscript.metadata.reconstructedSurface ?? null,
        metadataSource: parsedTranscript.metadata.surfaceReconstructionSource ?? "none",
      };
  const resolvedMeta = resolveSessionMeta(filePath, parsedSessionId, registryMeta, reconstructedMeta);

  if (!resolvedMeta.sessionId && cleanedMessages.length === 0) {
    return {
      kind: "invalid",
      value: {
        filePath,
        sessionId: undefined,
        transcriptHash: parsedTranscript.metadata.transcriptHash,
        messageCount: 0,
        metadataSource: resolvedMeta.metadataSource,
      },
    };
  }

  const existingEpisode = await findExistingEpisode(ports, resolvedMeta.sessionId, parsedTranscript.metadata.transcriptHash);
  if (existingEpisode && options.regenerate !== true) {
    return {
      kind: "skipped",
      value: {
        filePath,
        reason: "skipped_exists",
        sessionId: resolvedMeta.sessionId,
        transcriptHash: parsedTranscript.metadata.transcriptHash,
        messageCount: cleanedMessages.length,
        startedAt: parsedTranscript.metadata.startedAt,
        endedAt: parsedTranscript.metadata.endedAt,
        agentId: resolvedMeta.agentId,
        surface: resolvedMeta.surface,
        metadataSource: resolvedMeta.metadataSource,
        existingEpisode,
      },
    };
  }

  if (cleanedMessages.length < MIN_EPISODE_MESSAGES) {
    return {
      kind: "skipped",
      value: {
        filePath,
        reason: "skipped_short",
        sessionId: resolvedMeta.sessionId,
        transcriptHash: parsedTranscript.metadata.transcriptHash,
        messageCount: cleanedMessages.length,
        startedAt: parsedTranscript.metadata.startedAt,
        endedAt: parsedTranscript.metadata.endedAt,
        agentId: resolvedMeta.agentId,
        surface: resolvedMeta.surface,
        metadataSource: resolvedMeta.metadataSource,
      },
    };
  }

  if (options.skipActiveSessionCheck !== true && isActiveSession(parsedTranscript.metadata.endedAt, options.referenceNow)) {
    return {
      kind: "skipped",
      value: {
        filePath,
        reason: "skipped_active",
        sessionId: resolvedMeta.sessionId,
        transcriptHash: parsedTranscript.metadata.transcriptHash,
        messageCount: cleanedMessages.length,
        startedAt: parsedTranscript.metadata.startedAt,
        endedAt: parsedTranscript.metadata.endedAt,
        agentId: resolvedMeta.agentId,
        surface: resolvedMeta.surface,
        metadataSource: resolvedMeta.metadataSource,
      },
    };
  }

  const renderedTranscript = capEpisodeTranscript(renderTranscript(cleanedMessages), MAX_EPISODE_TRANSCRIPT_CHARS);
  return {
    kind: "candidate",
    value: {
      filePath,
      sessionId: resolvedMeta.sessionId,
      sourceRef: resolvedMeta.sourceRef,
      transcriptHash: parsedTranscript.metadata.transcriptHash,
      startedAt: parsedTranscript.metadata.startedAt,
      endedAt: parsedTranscript.metadata.endedAt,
      messageCount: cleanedMessages.length,
      agentId: resolvedMeta.agentId,
      surface: resolvedMeta.surface,
      metadataSource: resolvedMeta.metadataSource,
      renderedTranscript,
      estimatedInputTokens: estimateInputTokens(renderedTranscript),
      ...(existingEpisode ? { existingEpisode } : {}),
    },
  };
}

/**
 * Creates a pure Stage 2 plan from Stage 1 preflight output and model metadata.
 *
 * @param preflight - Stage 1 candidate set and aggregate counts.
 * @param model - Summary-generation model metadata used for estimation.
 * @param options - Optional recent filter and reference time.
 * @returns Immutable Stage 2 execution plan.
 */
export function createEpisodeIngestPlan(
  preflight: EpisodeIngestPreflightResult,
  model: EpisodeIngestModelInfo,
  options: CreateEpisodeIngestPlanOptions = {},
): EpisodeIngestPlan {
  const cutoff = resolveRecentCutoff(options.recent, options.now);
  let excludedByRecent = 0;
  let excludedUndated = 0;

  const candidates = preflight.candidates.flatMap((candidate) => {
    const estimatedInputTokens = estimateEpisodeSummaryInputTokens(candidate.renderedTranscript);
    const plannedCandidate = {
      ...candidate,
      estimatedInputTokens,
    };

    if (!cutoff) {
      return [plannedCandidate];
    }

    const endedAt = parseCandidateEndedAt(candidate.endedAt);
    if (!endedAt) {
      excludedByRecent += 1;
      excludedUndated += 1;
      return [];
    }

    if (endedAt.getTime() < cutoff.getTime()) {
      excludedByRecent += 1;
      return [];
    }

    return [plannedCandidate];
  });

  const inputTokens = candidates.reduce((total, candidate) => total + candidate.estimatedInputTokens, 0);
  const outputTokens = candidates.length * 500;
  const estimatedCostUsd = (inputTokens / 1_000_000) * model.pricing.input + (outputTokens / 1_000_000) * model.pricing.output;

  return {
    candidates,
    model,
    estimate: {
      candidateCount: candidates.length,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd,
    },
    ...(options.recent?.trim() ? { recent: options.recent.trim() } : {}),
    ...(cutoff ? { recentCutoff: cutoff.toISOString() } : {}),
    totals: {
      preflightCandidates: preflight.candidates.length,
      selectedCandidates: candidates.length,
      excludedByRecent,
      excludedUndated,
    },
  };
}

/**
 * Ingests one transcript directly into episodic memory using the shared app workflow.
 *
 * @param filePath - Absolute transcript path to parse and ingest.
 * @param ports - Transcript, database, summary-generation, and embedding ports.
 * @param options - Generator version plus optional host-specific overrides.
 * @returns Single-transcript ingest outcome.
 */
export async function ingestEpisodeTranscript(
  filePath: string,
  ports: EpisodeIngestPorts,
  options: IngestEpisodeTranscriptOptions,
): Promise<EpisodeTranscriptIngestResult> {
  const createSummaryLlm = ports.createSummaryLlm;
  if (!createSummaryLlm) {
    throw new Error("Episode transcript ingest requires createSummaryLlm().");
  }

  const classification = await classifyPreflightTranscript(filePath, ports, {
    referenceNow: options.now ?? new Date(),
    regenerate: options.regenerate === true,
    skipActiveSessionCheck: options.skipActiveSessionCheck === true,
  });
  if (classification.kind === "skipped") {
    return {
      kind: "skipped",
      skipped: classification.value,
    };
  }

  if (classification.kind === "invalid") {
    return {
      kind: "invalid",
      invalid: classification.value,
    };
  }

  const candidate = applyCandidateOverrides(classification.value, options.candidateOverrides);
  const session = await executeEpisodeCandidate(candidate, createSummaryLlm, ports, options.genVersion, async <T>(task: () => Promise<T>) => task());

  return {
    kind: "executed",
    candidate,
    session,
  };
}

/**
 * Executes a Stage 2 plan using concurrency-limited summary generation and serialized writes.
 *
 * @param plan - Precomputed Stage 2 execution plan.
 * @param ports - Episode database and summary-generation client factory.
 * @param options - Concurrency, generator version, and progress reporting options.
 * @returns Aggregate execution results and actual usage totals.
 */
export async function executeEpisodeIngestPlan(
  plan: EpisodeIngestPlan,
  ports: EpisodeIngestPorts,
  options: ExecuteEpisodeIngestPlanOptions,
): Promise<EpisodeIngestExecutionResult> {
  const createSummaryLlm = ports.createSummaryLlm;
  if (!createSummaryLlm) {
    throw new Error("Episode ingest execution requires createSummaryLlm().");
  }

  if (!Number.isFinite(options.concurrency) || Math.trunc(options.concurrency) <= 0) {
    throw new Error(`Episode ingest concurrency must be a positive integer. Received: ${options.concurrency}.`);
  }

  if (plan.candidates.length === 0) {
    return {
      sessions: [],
      usage: createEmptyUsageStats(),
      modelRef: plan.model.modelRef,
      totals: {
        attempted: 0,
        written: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
      },
    };
  }

  const results = new Array<EpisodeIngestSessionResult>(plan.candidates.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(Math.trunc(options.concurrency), plan.candidates.length);
  const runSerializedWrite = createSerializedExecutor();

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= plan.candidates.length) {
          return;
        }

        const candidate = plan.candidates[currentIndex];
        if (!candidate) {
          return;
        }

        const result = await executeEpisodeCandidate(candidate, createSummaryLlm, ports, options.genVersion, runSerializedWrite);
        results[currentIndex] = result;

        completed += 1;
        options.onProgress?.(completed, plan.candidates.length, result);
      }
    }),
  );

  const usage = results.reduce((total, result) => addUsageStats(total, result.usage), createEmptyUsageStats());

  return {
    sessions: results,
    usage,
    modelRef: plan.model.modelRef,
    totals: {
      attempted: results.length,
      written: results.filter((result) => result.action === "written").length,
      updated: results.filter((result) => result.action === "updated").length,
      unchanged: results.filter((result) => result.action === "unchanged").length,
      failed: results.filter((result) => result.action === "failed").length,
    },
  };
}

/**
 * Backfills embeddings for active episodes that are currently missing them.
 *
 * @param ports - Episode database plus an embedding provider.
 * @param options - Concurrency and progress-reporting settings.
 * @returns Aggregate embedding-backfill outcome.
 */
export async function backfillEpisodeEmbeddings(ports: EpisodeIngestPorts, options: BackfillEpisodeEmbeddingsOptions): Promise<EpisodeEmbeddingBackfillResult> {
  const embedding = ports.embedding;
  if (!embedding) {
    throw new Error("Episode embedding backfill requires an embedding provider.");
  }

  if (!Number.isFinite(options.concurrency) || Math.trunc(options.concurrency) <= 0) {
    throw new Error(`Episode embedding backfill concurrency must be a positive integer. Received: ${options.concurrency}.`);
  }

  const pendingEpisodes = await ports.episodes.listEpisodesWithoutEmbeddings();
  if (pendingEpisodes.length === 0) {
    return {
      totalMissing: 0,
      attempted: 0,
      embedded: 0,
      failed: 0,
      estimatedInputTokens: 0,
    };
  }

  const estimatedInputTokens = pendingEpisodes.reduce((total, episode) => total + estimateInputTokens(episode.summary), 0);
  const workerCount = Math.min(Math.trunc(options.concurrency), pendingEpisodes.length);
  let nextIndex = 0;
  let completed = 0;
  let embeddedCount = 0;
  let failedCount = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= pendingEpisodes.length) {
          return;
        }

        const episode = pendingEpisodes[currentIndex];
        if (!episode) {
          return;
        }

        let status: "embedded" | "failed" = "failed";

        try {
          const vector = await embedEpisodeSummaryWithPort(episode.summary, embedding);
          if (vector) {
            await ports.episodes.updateEpisodeEmbedding(episode.id, vector);
            embeddedCount += 1;
            status = "embedded";
          } else {
            failedCount += 1;
          }
        } catch {
          failedCount += 1;
        }

        completed += 1;
        options.onProgress?.(completed, pendingEpisodes.length, episode, status);
      }
    }),
  );

  return {
    totalMissing: pendingEpisodes.length,
    attempted: pendingEpisodes.length,
    embedded: embeddedCount,
    failed: failedCount,
    estimatedInputTokens,
  };
}

/**
 * Builds a default empty preflight result for empty discovery runs.
 *
 * @returns Empty result shape.
 */
function createEmptyPreflightResult(): EpisodeIngestPreflightResult {
  return {
    files: [],
    candidates: [],
    skipped: [],
    invalid: [],
    totals: {
      discovered: 0,
      candidates: 0,
      skipped: 0,
      invalid: 0,
      skippedShort: 0,
      skippedActive: 0,
      skippedExists: 0,
    },
  };
}

/**
 * Resolves an optional recent filter into a concrete cutoff date.
 *
 * @param recent - Recent filter string supplied by the caller.
 * @param now - Optional reference time for relative parsing.
 * @returns Parsed cutoff date, or undefined when no recent filter was supplied.
 */
function resolveRecentCutoff(recent: string | undefined, now: Date | undefined): Date | undefined {
  const trimmedRecent = recent?.trim();
  if (!trimmedRecent) {
    return undefined;
  }

  const cutoff = parseRelativeDate(trimmedRecent, now ?? new Date());
  if (!cutoff) {
    throw new Error(`Unsupported recent value "${trimmedRecent}". Use day shorthand like 30d or an ISO timestamp.`);
  }

  return cutoff;
}

/**
 * Resolves registry and reconstructed metadata with fixed precedence rules.
 *
 * @param filePath - Transcript path.
 * @param parsedSessionId - Session id reported by the transcript parser.
 * @param registryMeta - Registry metadata when present.
 * @param reconstructedMeta - Reconstructed metadata when present.
 * @returns Resolved metadata payload for one transcript.
 */
function resolveSessionMeta(
  filePath: string,
  parsedSessionId: string | undefined,
  registryMeta: SessionMeta | undefined,
  reconstructedMeta: Pick<SessionMeta, "surface" | "metadataSource"> | undefined,
): {
  sessionId?: string;
  sourceRef: string;
  agentId: string | null;
  surface: string | null;
  metadataSource: "registry" | "reconstructed" | "none";
} {
  if (registryMeta) {
    return {
      sessionId: parsedSessionId ?? registryMeta.sessionId,
      sourceRef: registryMeta.sourceRef,
      agentId: registryMeta.agentId,
      surface: registryMeta.surface,
      metadataSource: "registry",
    };
  }

  return {
    sessionId: parsedSessionId,
    sourceRef: filePath,
    agentId: deriveAgentIdFromPath(filePath),
    surface: reconstructedMeta?.surface ?? null,
    metadataSource: reconstructedMeta?.metadataSource ?? "none",
  };
}

/**
 * Derives an agent identifier from the transcript file path when it follows
 * the OpenClaw directory convention: `.openclaw/agents/{agentId}/sessions/{file}`.
 *
 * Returns `null` when the path does not match the expected structure.
 *
 * @param filePath - Absolute or relative transcript file path.
 * @returns Agent identifier, or `null` when the path is not an OpenClaw sessions directory.
 */
function deriveAgentIdFromPath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  const parent = path.basename(path.dirname(resolved));
  const grandparent = path.basename(path.dirname(path.dirname(resolved)));

  if (parent !== "sessions") {
    return null;
  }

  const candidate = grandparent.trim();
  if (!candidate || candidate === "." || candidate === "/") {
    return null;
  }

  return candidate;
}

/**
 * Detects whether a transcript should be treated as an active session.
 *
 * @param endedAt - Session end timestamp from transcript metadata.
 * @param now - Reference time for active-session detection.
 * @returns `true` when the transcript appears to still be active.
 */
function isActiveSession(endedAt: string | undefined, now: Date): boolean {
  if (!endedAt) {
    return false;
  }

  const endedAtDate = new Date(endedAt);
  if (Number.isNaN(endedAtDate.getTime())) {
    return false;
  }

  return endedAtDate.getTime() > now.getTime() - ACTIVE_SESSION_WINDOW_MS;
}

/**
 * Finds an existing episode using source id first and transcript hash second.
 *
 * @param ports - Episode database port container.
 * @param sessionId - Stable session identifier when present.
 * @param transcriptHash - Stable transcript hash fallback.
 * @returns Existing stored episode, or `null`.
 */
async function findExistingEpisode(ports: EpisodeIngestPorts, sessionId: string | undefined, transcriptHash: string): Promise<Episode | null> {
  const bySourceId = sessionId ? await ports.episodes.getEpisodeBySourceId("openclaw", sessionId) : null;
  if (bySourceId) {
    return bySourceId;
  }

  return ports.episodes.getEpisodeByTranscriptHash("openclaw", transcriptHash);
}

/**
 * Estimates Stage 1 prompt input tokens using a coarse character-based heuristic.
 *
 * @param renderedTranscript - Rendered transcript prompt text.
 * @returns Approximate input-token count.
 */
function estimateInputTokens(renderedTranscript: string): number {
  return Math.max(1, Math.ceil(renderedTranscript.length / CHARS_PER_TOKEN_ESTIMATE));
}

/**
 * Estimates the full episode-summary prompt input tokens for one transcript.
 *
 * @param renderedTranscript - Rendered transcript prompt text.
 * @returns Approximate input-token count for the complete request.
 */
function estimateEpisodeSummaryInputTokens(renderedTranscript: string): number {
  return estimateInputTokens(EPISODE_SUMMARY_SYSTEM_PROMPT) + estimateInputTokens(buildEpisodeSummaryPrompt(renderedTranscript));
}

/**
 * Best-effort episode summary embedding helper.
 *
 * @param summary - Episode summary text to embed.
 * @param ports - Embedding strategy and optional default embedding provider.
 * @returns Embedding vector when available and successful.
 */
async function embedEpisodeSummary(summary: string, ports: Pick<EpisodeIngestPorts, "embedSummary" | "embedding">): Promise<number[] | undefined> {
  if (ports.embedSummary) {
    try {
      return normalizeEmbeddingVector(await ports.embedSummary(summary));
    } catch {
      return undefined;
    }
  }

  return embedEpisodeSummaryWithPort(summary, ports.embedding);
}

/**
 * Best-effort episode summary embedding using the default embedding port.
 *
 * @param summary - Episode summary text to embed.
 * @param embeddingPort - Optional embedding provider.
 * @returns Embedding vector when available and successful.
 */
async function embedEpisodeSummaryWithPort(summary: string, embeddingPort: EpisodeIngestPorts["embedding"]): Promise<number[] | undefined> {
  if (!embeddingPort) {
    return undefined;
  }

  try {
    const vectors = await embeddingPort.embed([summary]);
    return normalizeEmbeddingVector(vectors[0]);
  } catch {
    return undefined;
  }
}

/**
 * Normalizes one embedding vector into finite numeric values.
 *
 * @param vector - Candidate embedding vector.
 * @returns Stable embedding vector, or `undefined` when invalid.
 */
function normalizeEmbeddingVector(vector: number[] | undefined): number[] | undefined {
  const normalized = vector?.map((value) => (Number.isFinite(value) ? value : 0));
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Parses one candidate end timestamp into a valid Date when possible.
 *
 * @param endedAt - Candidate end timestamp.
 * @returns Parsed Date, or undefined when invalid.
 */
function parseCandidateEndedAt(endedAt: string | undefined): Date | undefined {
  if (!endedAt) {
    return undefined;
  }

  const parsed = new Date(endedAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Executes one Stage 2 candidate and returns its stable result payload.
 *
 * @param candidate - Candidate selected by the Stage 2 planning pass.
 * @param createSummaryLlm - Factory for per-candidate summary clients.
 * @param ports - Episode-ingest service ports.
 * @param genVersion - Generator version persisted with successful writes.
 * @param runSerializedWrite - Serialized write executor used for database upserts.
 * @returns One stable execution result.
 */
async function executeEpisodeCandidate(
  candidate: EpisodeIngestCandidate,
  createSummaryLlm: NonNullable<EpisodeIngestPorts["createSummaryLlm"]>,
  ports: EpisodeIngestPorts,
  genVersion: string,
  runSerializedWrite: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<EpisodeIngestSessionResult> {
  const startedAt = trimOptionalString(candidate.startedAt) ?? trimOptionalString(candidate.existingEpisode?.startedAt);
  const endedAt = trimOptionalString(candidate.endedAt) ?? trimOptionalString(candidate.existingEpisode?.endedAt);
  if (!startedAt) {
    return {
      action: "failed",
      filePath: candidate.filePath,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      error: "missing_started_at",
      usage: createEmptyUsageStats(),
    };
  }

  const llm = createSummaryLlm();
  try {
    const structured = await generateEpisodeSummary(candidate.renderedTranscript, llm);
    if (!structured) {
      return {
        action: "failed",
        filePath: candidate.filePath,
        ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
        error: "invalid_response",
        usage: cloneUsageStats(llm.metadata.usage),
      };
    }

    const existingEpisode = candidate.existingEpisode;
    const embedding = await embedEpisodeSummary(structured.summary, ports);
    const writeResult = await runSerializedWrite(async () =>
      ports.episodes.upsertEpisode({
        source: "openclaw",
        ...(candidate.sessionId ? { sourceId: candidate.sessionId } : {}),
        sourceRef: candidate.metadataSource === "registry" || !existingEpisode?.sourceRef ? candidate.sourceRef : existingEpisode.sourceRef,
        transcriptHash: candidate.transcriptHash,
        ...((trimOptionalString(candidate.agentId) ?? trimOptionalString(existingEpisode?.agentId))
          ? { agentId: trimOptionalString(candidate.agentId) ?? trimOptionalString(existingEpisode?.agentId) }
          : {}),
        ...((trimOptionalString(candidate.surface) ?? trimOptionalString(existingEpisode?.surface))
          ? { surface: trimOptionalString(candidate.surface) ?? trimOptionalString(existingEpisode?.surface) }
          : {}),
        startedAt,
        ...(endedAt ? { endedAt } : {}),
        summary: structured.summary,
        tags: structured.tags,
        activityLevel: structured.activityLevel,
        ...(structured.project ? { project: structured.project } : {}),
        genModel: llm.metadata.modelRef,
        genVersion,
        messageCount: candidate.messageCount,
        ...(embedding ? { embedding } : {}),
      }),
    );

    return {
      action: mapWriteAction(writeResult.action),
      filePath: candidate.filePath,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      activityLevel: structured.activityLevel,
      episodeId: writeResult.episode.id,
      usage: cloneUsageStats(llm.metadata.usage),
    };
  } catch (error) {
    return {
      action: "failed",
      filePath: candidate.filePath,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      error: formatExecutionError(error),
      usage: cloneUsageStats(llm.metadata.usage),
    };
  }
}

/**
 * Applies host-specific metadata overrides to one prepared candidate.
 *
 * @param candidate - Transcript-derived candidate produced by classification.
 * @param overrides - Optional override fields supplied by the caller.
 * @returns Candidate copy with the requested overrides applied.
 */
function applyCandidateOverrides(candidate: EpisodeIngestCandidate, overrides: EpisodeIngestCandidateOverrides | undefined): EpisodeIngestCandidate {
  if (!overrides) {
    return candidate;
  }

  return {
    ...candidate,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.sourceRef !== undefined ? { sourceRef: overrides.sourceRef } : {}),
    ...("agentId" in overrides ? { agentId: overrides.agentId ?? null } : {}),
    ...("surface" in overrides ? { surface: overrides.surface ?? null } : {}),
    ...(overrides.metadataSource !== undefined ? { metadataSource: overrides.metadataSource } : {}),
  };
}

/**
 * Maps database upsert actions into Stage 2 session-result actions.
 *
 * @param action - Raw database action.
 * @returns User-facing Stage 2 action.
 */
function mapWriteAction(action: "inserted" | "updated" | "unchanged"): "written" | "updated" | "unchanged" {
  if (action === "inserted") {
    return "written";
  }

  return action;
}

/**
 * Creates a serialized async executor that never lets failures poison the queue.
 *
 * @returns Function that runs asynchronous tasks one at a time.
 */
function createSerializedExecutor(): <T>(task: () => Promise<T>) => Promise<T> {
  let pending = Promise.resolve();

  return async <T>(task: () => Promise<T>): Promise<T> => {
    const current = pending.then(task, task);
    pending = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

/**
 * Creates an empty usage snapshot.
 *
 * @returns Zeroed usage totals.
 */
function createEmptyUsageStats(): EpisodeIngestUsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

/**
 * Clones one usage snapshot so callers cannot mutate the source client state.
 *
 * @param usage - Usage stats to clone.
 * @returns Detached usage snapshot.
 */
function cloneUsageStats(usage: EpisodeIngestUsageStats): EpisodeIngestUsageStats {
  return {
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    totalCost: usage.totalCost,
  };
}

/**
 * Adds one usage snapshot into an aggregate total.
 *
 * @param total - Aggregate usage accumulator.
 * @param usage - Usage stats to add.
 * @returns Updated aggregate usage totals.
 */
function addUsageStats(total: EpisodeIngestUsageStats, usage: EpisodeIngestUsageStats): EpisodeIngestUsageStats {
  total.calls += usage.calls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.totalTokens += usage.totalTokens;
  total.totalCost += usage.totalCost;
  return total;
}

/**
 * Normalizes an optional string into a trimmed value.
 *
 * @param value - Optional string value.
 * @returns Trimmed string, or undefined when absent.
 */
function trimOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Formats an unknown execution error into a stable result string.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error message.
 */
function formatExecutionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

/**
 * Orders candidates by newest finished session first.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Stable descending sort order.
 */
function compareCandidatesByEndedAt(left: EpisodeIngestCandidate, right: EpisodeIngestCandidate): number {
  const leftTime = left.endedAt ? new Date(left.endedAt).getTime() : Number.NEGATIVE_INFINITY;
  const rightTime = right.endedAt ? new Date(right.endedAt).getTime() : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return left.filePath.localeCompare(right.filePath);
}
