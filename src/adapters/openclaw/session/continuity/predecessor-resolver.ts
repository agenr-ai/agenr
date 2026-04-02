import * as fs from "node:fs/promises";
import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { AgenrOpenClawHookContext, AgenrOpenClawRuntime } from "../../types.js";
import { deriveOpenClawSessionIdFromFilePath } from "../session-id.js";
import { parseOpenClawSessionContinuityKey, type OpenClawSessionContinuityIdentity } from "../session-key-parser.js";
import { readOpenClawSessionsStore, type OpenClawSessionsStoreEntry } from "../sessions-store-reader.js";
import type { SessionStartTracker } from "../state.js";
import type { OpenClawSessionPredecessor } from "./types.js";

/**
 * One fully resolved predecessor candidate returned from `sessions.json` fallback.
 */
interface ResolvedCandidatePredecessor extends OpenClawSessionPredecessor {
  sessionKey: string;
}

/**
 * Stable fallback outcomes returned from `sessions.json` predecessor lookup.
 */
type SessionsStoreFallbackReason = "resolved" | "unsupported_kind" | "no_matching_sessions" | "missing_session_id" | "not_scan_eligible";

export type { OpenClawSessionPredecessor } from "./types.js";

/**
 * Resolves the predecessor session file for the active OpenClaw session.
 *
 * The resolver is surface-agnostic for current OpenClaw key shapes. It prefers
 * `session_start.resumedFrom` file discovery for every eligible session kind
 * and uses `sessions.json` scan fallback only for `main` and `tui` sessions.
 *
 * @param ctx - Active OpenClaw hook context.
 * @param tracker - In-process continuity tracker shared by the plugin.
 * @param params - Logger plus OpenClaw state-dir resolution helpers.
 * @returns Predecessor facts, or `undefined` when continuity cannot be resolved.
 */
export async function resolveOpenClawSessionPredecessor(
  ctx: AgenrOpenClawHookContext,
  tracker: SessionStartTracker,
  params: {
    logger?: PluginLogger;
    resolveStateDir: AgenrOpenClawRuntime["state"]["resolveStateDir"];
    mainKey?: string;
  },
): Promise<OpenClawSessionPredecessor | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const currentIdentity = parseOpenClawSessionContinuityKey(ctx.sessionKey ?? "", {
    mainKey: params.mainKey,
  });
  debugLog(
    params.logger,
    "predecessor",
    `parsed current identity for ${sessionContext}: kind=${currentIdentity.kind} stableLane=${currentIdentity.stableLane ?? "unknown"} eligible=${currentIdentity.eligible}`,
  );

  if (!currentIdentity.eligible || !currentIdentity.agentId) {
    debugLog(
      params.logger,
      "predecessor",
      `skipping predecessor resolution for ${sessionContext}: kind=${currentIdentity.kind} eligible=${currentIdentity.eligible} agentId=${currentIdentity.agentId ?? "unknown"}`,
    );
    return undefined;
  }

  const sessionsDir = resolveOpenClawSessionsDirectory(ctx, currentIdentity.agentId, params.resolveStateDir);
  if (!sessionsDir) {
    params.logger?.info?.(`[agenr] predecessor: no predecessor found for ${sessionContext} reason=no_sessions_dir`);
    return undefined;
  }

  const resumedFrom = tracker.getResumedFrom(ctx.sessionId);
  if (resumedFrom) {
    debugLog(params.logger, "predecessor", `session_start resumedFrom for ${sessionContext}: ${resumedFrom}`);
    const resumedFromPredecessor = await resolveResumedFromPredecessor(sessionsDir, resumedFrom, params.logger);
    if (resumedFromPredecessor) {
      params.logger?.info?.(
        `[agenr] predecessor: predecessor found for ${sessionContext} strategy=resumed_from predecessorKey=session_start predecessor=${resumedFromPredecessor.sessionFile}`,
      );
      return resumedFromPredecessor;
    }

    debugLog(
      params.logger,
      "predecessor",
      `session_start resumedFrom file not found for ${sessionContext}: resumedFrom=${resumedFrom} sessionsDir=${sessionsDir}`,
    );
  } else {
    debugLog(params.logger, "predecessor", `session_start resumedFrom unavailable for ${sessionContext}`);
  }

  if (!isSessionsStoreFallbackEligible(currentIdentity.kind)) {
    if (resumedFrom) {
      params.logger?.info?.(`[agenr] predecessor: no predecessor found for ${sessionContext} strategy=resumed_from reason=cold_start_after_resumed_from_miss`);
    }
    return undefined;
  }

  params.logger?.info?.(
    `[agenr] predecessor: predecessor resolution for ${sessionContext} strategy=sessions_json_scan sessionKey=${ctx.sessionKey?.trim() ?? "unknown"} kind=${currentIdentity.kind} stableLane=${currentIdentity.stableLane ?? "unknown"}`,
  );

  const fallbackResolution = await findSessionsStoreFallbackPredecessor(
    currentIdentity,
    ctx.sessionKey ?? "",
    ctx.sessionId,
    sessionsDir,
    resumedFrom,
    params.mainKey,
    params.logger,
  );
  if (!fallbackResolution.predecessor) {
    params.logger?.info?.(`[agenr] predecessor: no predecessor found for ${sessionContext} strategy=sessions_json_scan reason=${fallbackResolution.reason}`);
    return undefined;
  }

  params.logger?.info?.(
    `[agenr] predecessor: predecessor found for ${sessionContext} strategy=sessions_json_scan predecessorKey=${fallbackResolution.predecessor.sessionKey} predecessor=${fallbackResolution.predecessor.sessionFile}`,
  );
  return {
    sessionId: fallbackResolution.predecessor.sessionId,
    sessionFile: fallbackResolution.predecessor.sessionFile,
  };
}

/**
 * Resolves a predecessor transcript from one `session_start.resumedFrom` value.
 *
 * @param sessionsDir - Agent-scoped OpenClaw sessions directory.
 * @param resumedFrom - Predecessor session UUID from `session_start`.
 * @param logger - Optional plugin logger.
 * @returns Resolved predecessor facts, or `undefined` when no transcript exists.
 */
async function resolveResumedFromPredecessor(sessionsDir: string, resumedFrom: string, logger?: PluginLogger): Promise<OpenClawSessionPredecessor | undefined> {
  const normalizedResumedFrom = resumedFrom.trim();
  if (!normalizedResumedFrom) {
    return undefined;
  }

  const candidates = await findResumedFromTranscriptCandidates(sessionsDir, normalizedResumedFrom, logger);
  const winner = candidates[0];
  if (!winner) {
    return undefined;
  }

  const sessionId = resolvePredecessorSessionId(normalizedResumedFrom, winner, logger);
  if (!sessionId) {
    return undefined;
  }

  return {
    sessionId,
    sessionFile: winner,
  };
}

/**
 * Lists transcript candidates for one predecessor session id, preferring live
 * JSONL files over reset or deleted archives.
 *
 * @param sessionsDir - Agent-scoped OpenClaw sessions directory.
 * @param sessionId - Predecessor session UUID.
 * @param logger - Optional plugin logger.
 * @returns Ordered absolute transcript candidate paths.
 */
async function findResumedFromTranscriptCandidates(sessionsDir: string, sessionId: string, logger?: PluginLogger): Promise<string[]> {
  try {
    const dirEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const prefix = `${sessionId}.jsonl`;
    const liveMatches: string[] = [];
    const resetMatches: string[] = [];
    const deletedMatches: string[] = [];

    for (const entry of dirEntries) {
      if (!entry.isFile()) {
        continue;
      }

      const fileName = entry.name.trim();
      if (fileName === prefix) {
        liveMatches.push(path.join(sessionsDir, fileName));
        continue;
      }

      if (fileName.startsWith(`${prefix}.reset.`)) {
        resetMatches.push(path.join(sessionsDir, fileName));
        continue;
      }

      if (fileName.startsWith(`${prefix}.deleted.`)) {
        deletedMatches.push(path.join(sessionsDir, fileName));
      }
    }

    const ordered = [
      ...liveMatches.sort((left, right) => left.localeCompare(right)),
      ...resetMatches.sort(compareArchivePathsDescending),
      ...deletedMatches.sort(compareArchivePathsDescending),
    ];
    debugLog(logger, "predecessor", `resumedFrom file discovery for sessionId=${sessionId}: candidates=${ordered.length} sessionsDir=${sessionsDir}`);
    return ordered;
  } catch (error) {
    if (isFileNotFound(error)) {
      debugLog(logger, "predecessor", `resumedFrom file discovery skipped missing directory=${sessionsDir}`);
      return [];
    }

    throw error;
  }
}

/**
 * Finds the best `sessions.json` fallback predecessor for `main` and `tui`.
 *
 * @param currentIdentity - Parsed current session identity.
 * @param currentSessionKey - Active OpenClaw session key.
 * @param currentSessionId - Active OpenClaw session id.
 * @param sessionsDir - Agent-scoped OpenClaw sessions directory.
 * @param resumedFrom - Optional `session_start` predecessor session UUID.
 * @param mainKey - Optional configured OpenClaw main key.
 * @param logger - Optional plugin logger.
 * @returns Best-effort fallback resolution outcome.
 */
async function findSessionsStoreFallbackPredecessor(
  currentIdentity: OpenClawSessionContinuityIdentity,
  currentSessionKey: string,
  currentSessionId: string | undefined,
  sessionsDir: string,
  resumedFrom: string | undefined,
  mainKey: string | undefined,
  logger?: PluginLogger,
): Promise<
  | {
      predecessor: ResolvedCandidatePredecessor;
      reason: "resolved";
    }
  | {
      predecessor?: undefined;
      reason: SessionsStoreFallbackReason;
    }
> {
  if (!isSessionsStoreFallbackEligible(currentIdentity.kind)) {
    return {
      reason: "not_scan_eligible",
    };
  }

  const entries = await readOpenClawSessionsStore(sessionsDir, logger);
  debugLog(
    logger,
    "predecessor",
    `sessions.json read result for kind=${currentIdentity.kind} stableLane=${currentIdentity.stableLane ?? "unknown"} entries=${entries.length}`,
  );

  const sameAgentEntries = entries.filter((entry) => {
    const candidateIdentity = parseOpenClawSessionContinuityKey(entry.sessionKey, { mainKey });
    if (candidateIdentity.agentId !== currentIdentity.agentId) {
      debugLog(
        logger,
        "predecessor",
        `excluded candidate=${entry.sessionKey} reason=agent_mismatch expected=${currentIdentity.agentId} actual=${candidateIdentity.agentId ?? "unknown"}`,
      );
      return false;
    }

    return true;
  });
  debugLog(logger, "predecessor", `same-agent candidate count for current=${currentSessionKey}: count=${sameAgentEntries.length}`);

  const matchedEntries = sameAgentEntries.filter((entry) =>
    isMatchingFallbackCandidate(entry, currentIdentity, currentSessionKey, currentSessionId, mainKey, logger),
  );
  debugLog(logger, "predecessor", `lane-matched candidate count for current=${currentSessionKey}: count=${matchedEntries.length}`);

  if (matchedEntries.length === 0) {
    return {
      reason: "no_matching_sessions",
    };
  }

  if (resumedFrom?.trim()) {
    const resumedFromMatch = matchedEntries.find((entry) => resolveEntrySessionId(entry, logger) === resumedFrom.trim());
    if (resumedFromMatch) {
      const resolvedPredecessor = toResolvedCandidatePredecessor(resumedFromMatch, logger);
      if (resolvedPredecessor) {
        return {
          reason: "resolved",
          predecessor: resolvedPredecessor,
        };
      }
    }
  }

  const sortedCandidates = matchedEntries
    .filter((entry) => {
      if (!entry.sessionFile?.trim()) {
        debugLog(logger, "predecessor", `excluded candidate=${entry.sessionKey} reason=missing_session_file`);
        return false;
      }

      if (entry.updatedAt === undefined) {
        debugLog(logger, "predecessor", `excluded candidate=${entry.sessionKey} reason=missing_updated_at`);
        return false;
      }

      return true;
    })
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

  if (sortedCandidates.length === 0) {
    return {
      reason: "no_matching_sessions",
    };
  }

  for (const candidate of sortedCandidates) {
    const resolvedPredecessor = toResolvedCandidatePredecessor(candidate, logger);
    if (resolvedPredecessor) {
      return {
        reason: "resolved",
        predecessor: resolvedPredecessor,
      };
    }
  }

  return {
    reason: "missing_session_id",
  };
}

/**
 * Reports whether one parsed session kind should use `sessions.json` fallback.
 *
 * @param kind - Parsed continuity kind.
 * @returns `true` when `sessions.json` fallback is allowed.
 */
function isSessionsStoreFallbackEligible(kind: OpenClawSessionContinuityIdentity["kind"]): kind is "main" | "tui" {
  return kind === "main" || kind === "tui";
}

/**
 * Checks whether one sessions-store entry is continuity-compatible with the
 * current session for `main` or `tui` fallback.
 *
 * @param entry - Candidate sessions-store entry.
 * @param currentIdentity - Parsed current session identity.
 * @param currentSessionKey - Active OpenClaw session key.
 * @param currentSessionId - Active OpenClaw session id.
 * @param mainKey - Optional configured OpenClaw main key.
 * @param logger - Optional plugin logger.
 * @returns `true` when the candidate is eligible for fallback ranking.
 */
function isMatchingFallbackCandidate(
  entry: OpenClawSessionsStoreEntry,
  currentIdentity: OpenClawSessionContinuityIdentity,
  currentSessionKey: string,
  currentSessionId: string | undefined,
  mainKey: string | undefined,
  logger?: PluginLogger,
): boolean {
  const normalizedCandidateKey = entry.sessionKey.trim();
  const candidateSessionId = resolveEntrySessionId(entry, logger);
  if (candidateSessionId && currentSessionId?.trim() === candidateSessionId) {
    debugLog(logger, "predecessor", `excluded candidate=${entry.sessionKey} reason=current_session_id`);
    return false;
  }

  if (normalizedCandidateKey === currentSessionKey.trim() && currentIdentity.kind !== "main") {
    debugLog(logger, "predecessor", `excluded candidate=${entry.sessionKey} reason=current_session_key`);
    return false;
  }

  if (normalizedCandidateKey === currentSessionKey.trim() && !candidateSessionId) {
    debugLog(logger, "predecessor", `excluded candidate=${entry.sessionKey} reason=current_session_key_without_session_id`);
    return false;
  }

  const candidateIdentity = parseOpenClawSessionContinuityKey(entry.sessionKey, { mainKey });

  if (currentIdentity.kind === "main") {
    if (candidateIdentity.kind !== "main" || candidateIdentity.stableLane !== currentIdentity.stableLane) {
      debugLog(
        logger,
        "predecessor",
        `excluded candidate=${entry.sessionKey} reason=main_lane_mismatch currentStableLane=${currentIdentity.stableLane ?? "unknown"} candidateKind=${candidateIdentity.kind} candidateStableLane=${candidateIdentity.stableLane ?? "unknown"}`,
      );
      return false;
    }

    return true;
  }

  if (currentIdentity.kind !== "tui") {
    return false;
  }

  if (currentIdentity.stableLane === "tui" && candidateIdentity.kind === "main") {
    return true;
  }

  if (candidateIdentity.kind !== "tui") {
    debugLog(logger, "predecessor", `excluded candidate=${entry.sessionKey} reason=not_tui_candidate kind=${candidateIdentity.kind}`);
    return false;
  }

  if (!isSameTuiLane(currentIdentity.stableLane, candidateIdentity.stableLane)) {
    debugLog(
      logger,
      "predecessor",
      `excluded candidate=${entry.sessionKey} reason=lane_mismatch currentStableLane=${currentIdentity.stableLane ?? "unknown"} candidateStableLane=${candidateIdentity.stableLane ?? "unknown"}`,
    );
    return false;
  }

  return true;
}

/**
 * Resolves the required predecessor session id from explicit or filename-derived state.
 *
 * @param sessionId - Candidate predecessor session id.
 * @param sessionFile - Candidate predecessor transcript path.
 * @param logger - Optional plugin logger.
 * @returns Stable predecessor session id, or `undefined` when unavailable.
 */
function resolvePredecessorSessionId(sessionId: string | undefined, sessionFile: string | undefined, logger?: PluginLogger): string | undefined {
  const normalizedSessionId = sessionId?.trim();
  if (normalizedSessionId) {
    return normalizedSessionId;
  }

  if (!sessionFile?.trim()) {
    return undefined;
  }

  return deriveOpenClawSessionIdFromFilePath(sessionFile, logger);
}

/**
 * Resolves one sessions-store entry session id from explicit or filename-derived state.
 *
 * @param entry - Sessions-store entry to inspect.
 * @param logger - Optional plugin logger.
 * @returns Stable session id, or `undefined` when unavailable.
 */
function resolveEntrySessionId(entry: Pick<OpenClawSessionsStoreEntry, "sessionFile" | "sessionId">, logger?: PluginLogger): string | undefined {
  return resolvePredecessorSessionId(entry.sessionId, entry.sessionFile, logger);
}

/**
 * Normalizes a candidate sessions-store entry into a predecessor with required identity.
 *
 * @param candidate - Candidate sessions-store entry.
 * @param logger - Optional plugin logger.
 * @returns Resolved predecessor facts, or `undefined` when identity is incomplete.
 */
function toResolvedCandidatePredecessor(
  candidate: Pick<OpenClawSessionsStoreEntry, "sessionId" | "sessionFile" | "sessionKey">,
  logger?: PluginLogger,
): ResolvedCandidatePredecessor | undefined {
  const sessionFile = candidate.sessionFile?.trim();
  if (!sessionFile) {
    return undefined;
  }

  const sessionId = resolvePredecessorSessionId(candidate.sessionId, sessionFile, logger);
  if (!sessionId) {
    return undefined;
  }

  return {
    sessionFile,
    sessionId,
    sessionKey: candidate.sessionKey,
  };
}

/**
 * Resolves the agent-scoped OpenClaw sessions directory for predecessor lookup.
 *
 * @param ctx - Active OpenClaw hook context.
 * @param parsedAgentId - Parsed agent id from the session key.
 * @param resolveStateDir - OpenClaw runtime state-dir resolver.
 * @returns Absolute sessions directory, or `undefined` when agent id is missing.
 */
function resolveOpenClawSessionsDirectory(
  ctx: AgenrOpenClawHookContext,
  parsedAgentId: string,
  resolveStateDir: AgenrOpenClawRuntime["state"]["resolveStateDir"],
): string | undefined {
  const agentId = ctx.agentId?.trim() || parsedAgentId.trim();
  if (!agentId) {
    return undefined;
  }

  return path.join(resolveStateDir(process.env), "agents", agentId, "sessions");
}

/**
 * Matches TUI predecessor lanes, treating `tui` as the broad continuity bucket after `/new`.
 *
 * @param currentStableLane - Current TUI stable lane.
 * @param candidateStableLane - Candidate TUI stable lane.
 * @returns `true` when the candidate belongs to the same TUI continuity bucket.
 */
function isSameTuiLane(currentStableLane: string | null, candidateStableLane: string | null): boolean {
  if (!currentStableLane || !candidateStableLane) {
    return false;
  }

  if (currentStableLane === "tui") {
    return candidateStableLane.toLowerCase().startsWith("tui");
  }

  return currentStableLane === candidateStableLane;
}

/**
 * Sorts archived transcript candidates newest-first using the archive suffix.
 *
 * @param left - Left absolute archive path.
 * @param right - Right absolute archive path.
 * @returns Sort order for newest-first selection.
 */
function compareArchivePathsDescending(left: string, right: string): number {
  return path.basename(right).localeCompare(path.basename(left));
}

/**
 * Emits debug logs when the plugin logger supports them.
 *
 * @param logger - Optional plugin logger.
 * @param subsystem - Stable OpenClaw adapter subsystem label.
 * @param message - Human-readable debug message.
 */
function debugLog(logger: PluginLogger | undefined, subsystem: string, message: string): void {
  logger?.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/**
 * Detects stable file-not-found failures from Node.js fs calls.
 *
 * @param error - Unknown filesystem error.
 * @returns `true` when the error is a file-not-found failure.
 */
function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Formats stable session identifiers for OpenClaw adapter log messages.
 *
 * @param sessionId - Active OpenClaw session id.
 * @param sessionKey - Active OpenClaw session key.
 * @returns Stable human-readable session context.
 */
function formatSessionContext(sessionId?: string, sessionKey?: string): string {
  const normalizedSessionId = sessionId?.trim();
  const normalizedSessionKey = sessionKey?.trim();

  if (normalizedSessionId && normalizedSessionKey) {
    return `session=${normalizedSessionId} key=${normalizedSessionKey}`;
  }

  if (normalizedSessionId) {
    return `session=${normalizedSessionId}`;
  }

  if (normalizedSessionKey) {
    return `key=${normalizedSessionKey}`;
  }

  return "session=unknown";
}
