import path from "node:path";

import { resolveEpisodeActivityEligibility } from "../activity-threshold.js";
import type { EpisodeActivityThreshold } from "../activity-threshold.js";
import {
  MAX_EPISODE_TRANSCRIPT_CHARS,
  MIN_EPISODE_MESSAGES,
  capEpisodeTranscript,
  countMaterialTranscriptTurns,
  renderTranscript,
} from "../../../core/episode/transcript-render.js";
import type { Episode } from "../../../core/types.js";
import type { EpisodeIngestPorts, SessionMeta } from "../ports.js";
import type {
  EpisodeIngestCandidate,
  EpisodeIngestInvalidSession,
  EpisodeIngestPreflightResult,
  EpisodeIngestSkippedSession,
  PrepareEpisodeIngestOptions,
} from "../types.js";
import { compareCandidatesByEndedAt, estimateInputTokens } from "./shared.js";

const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Stable classification result produced for one preflight transcript.
 */
export type PreflightTranscriptClassification =
  | { kind: "candidate"; value: EpisodeIngestCandidate }
  | { kind: "skipped"; value: EpisodeIngestSkippedSession }
  | { kind: "invalid"; value: EpisodeIngestInvalidSession };

/**
 * Internal classification options shared by batch and single-transcript ingest.
 */
export interface ClassifyPreflightTranscriptOptions {
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
  /**
   * Optional minimum activity gate applied after generic short-session checks.
   */
  activityThreshold?: EpisodeActivityThreshold;
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
 * Parses one transcript file and classifies it for Stage 1 preflight.
 *
 * @param filePath - Absolute transcript path.
 * @param ports - Episode-ingest service ports.
 * @param options - Reference time plus eligibility controls for this classification.
 * @returns One candidate, skipped-session record, or invalid-session record.
 */
export async function classifyPreflightTranscript(
  filePath: string,
  ports: EpisodeIngestPorts,
  options: ClassifyPreflightTranscriptOptions,
): Promise<PreflightTranscriptClassification> {
  const parsedTranscript = await ports.transcript.parseFile(filePath);
  const cleanedMessages = parsedTranscript.messages.filter((message) => message.text.trim().length > 0);
  const materialTurns = countMaterialTranscriptTurns(parsedTranscript.messages);
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

  if (options.activityThreshold) {
    const eligibility = resolveEpisodeActivityEligibility(
      materialTurns,
      parsedTranscript.metadata.startedAt,
      parsedTranscript.metadata.endedAt,
      options.activityThreshold,
    );
    if (!eligibility.eligible) {
      return {
        kind: "skipped",
        value: {
          filePath,
          reason: eligibility.reason,
          sessionId: resolvedMeta.sessionId,
          transcriptHash: parsedTranscript.metadata.transcriptHash,
          messageCount: eligibility.materialTurns,
          startedAt: parsedTranscript.metadata.startedAt,
          endedAt: parsedTranscript.metadata.endedAt,
          agentId: resolvedMeta.agentId,
          surface: resolvedMeta.surface,
          metadataSource: resolvedMeta.metadataSource,
        },
      };
    }
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
