import { MAX_EPISODE_TRANSCRIPT_CHARS, MIN_EPISODE_MESSAGES, capEpisodeTranscript, renderTranscript } from "../../core/episode/transcript-render.js";
import type { Episode } from "../../core/types.js";
import type { EpisodeIngestPorts, SessionMeta } from "./ports.js";
import type {
  EpisodeIngestCandidate,
  EpisodeIngestInvalidSession,
  EpisodeIngestPreflightResult,
  EpisodeIngestSkippedSession,
  PrepareEpisodeIngestOptions,
} from "./types.js";

const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Discovers OpenClaw transcripts, applies Stage 1 eligibility checks, and
 * prepares render-ready candidates for later episode generation.
 *
 * @param targetPath - File or directory path to inspect.
 * @param ports - Discovery, transcript, metadata, and episode lookup ports.
 * @param options - Optional regenerate flag and reference time override.
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

  const skipped: EpisodeIngestSkippedSession[] = [];
  const invalid: EpisodeIngestInvalidSession[] = [];
  const candidates: EpisodeIngestCandidate[] = [];
  const referenceNow = options.now ?? new Date();

  for (const filePath of files) {
    const parsedTranscript = await ports.transcript.parseFile(filePath);
    const cleanedMessages = parsedTranscript.messages.filter((message) => message.text.trim().length > 0);
    const parsedSessionId = parsedTranscript.metadata.sessionId?.trim() || undefined;
    const registryMeta = parsedSessionId ? await ports.sessionRegistry?.getSessionMeta(parsedSessionId) : undefined;
    const reconstructedMeta = registryMeta ? undefined : await ports.sessionMetaInspector?.inspectFile(filePath);
    const resolvedMeta = resolveSessionMeta(filePath, parsedSessionId, registryMeta, reconstructedMeta);

    if (!resolvedMeta.sessionId && cleanedMessages.length === 0) {
      invalid.push({
        filePath,
        sessionId: undefined,
        transcriptHash: parsedTranscript.metadata.transcriptHash,
        messageCount: 0,
        metadataSource: resolvedMeta.metadataSource,
      });
      continue;
    }

    if (cleanedMessages.length < MIN_EPISODE_MESSAGES) {
      skipped.push({
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
      });
      continue;
    }

    if (isActiveSession(parsedTranscript.metadata.endedAt, referenceNow)) {
      skipped.push({
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
      });
      continue;
    }

    const existingEpisode = await findExistingEpisode(ports, resolvedMeta.sessionId, parsedTranscript.metadata.transcriptHash);
    if (existingEpisode && options.regenerate !== true) {
      skipped.push({
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
      });
      continue;
    }

    const renderedTranscript = capEpisodeTranscript(renderTranscript(cleanedMessages), MAX_EPISODE_TRANSCRIPT_CHARS);
    candidates.push({
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
    });
  }

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
    agentId: null,
    surface: reconstructedMeta?.surface ?? null,
    metadataSource: reconstructedMeta?.metadataSource ?? "none",
  };
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
 * Estimates prompt input tokens using a coarse character-based heuristic.
 *
 * @param renderedTranscript - Rendered transcript prompt text.
 * @returns Approximate input-token count.
 */
function estimateInputTokens(renderedTranscript: string): number {
  return Math.max(1, Math.ceil(renderedTranscript.length / CHARS_PER_TOKEN_ESTIMATE));
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
