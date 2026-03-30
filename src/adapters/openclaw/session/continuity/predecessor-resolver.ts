import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { AgenrOpenClawHookContext, AgenrOpenClawRuntime } from "../../types.js";
import { readOpenClawSessionsStore } from "../sessions-store-reader.js";
import type { SessionResetRecord, SessionStartTracker } from "../state.js";
import { parseTuiSessionKey } from "../tui-lane.js";
import type { OpenClawSessionPredecessor } from "./types.js";

/** Parsed agent-and-lane facts for single-lane OpenClaw session keys. */
interface ParsedSingleLaneSessionKey {
  agentId: string;
  lane: string;
}

/** Fully resolved predecessor facts returned by the TUI sessions-store scan. */
interface FoundTuiFallbackPredecessor {
  sessionFile: string;
  sessionId?: string;
  sessionKey: string;
}

/** Best-effort outcome from the TUI-specific predecessor fallback. */
type TuiFallbackResolution =
  | {
      predecessor: FoundTuiFallbackPredecessor;
      reason: "resolved";
    }
  | {
      predecessor?: undefined;
      reason: string;
    };

export type { OpenClawSessionPredecessor } from "./types.js";

/**
 * Resolves the predecessor session file for the active OpenClaw session.
 *
 * The v1 plugin keeps continuity simple:
 * 1. remember the outgoing session file during `before_reset`
 * 2. remember `resumedFrom` during `session_start`
 * 3. on `before_prompt_build`, match the current session key to the latest
 *    reset record and, when available, verify that `resumedFrom` agrees
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
  },
): Promise<OpenClawSessionPredecessor | undefined> {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  debugLog(params.logger, "predecessor", `resolving predecessor for ${sessionContext}`);

  const trackedPredecessor = resolveTrackedPredecessor(ctx, tracker, params.logger);
  if (trackedPredecessor) {
    return trackedPredecessor;
  }

  const tuiIdentity = parseTuiSessionKey(ctx.sessionKey ?? "");
  if (!tuiIdentity) {
    debugLog(params.logger, "predecessor", `skipping TUI fallback for ${sessionContext}: current session key is not TUI`);
    return undefined;
  }

  const sessionsDir = resolveOpenClawSessionsDirectory(ctx, tuiIdentity.agentId, params.resolveStateDir);
  if (!sessionsDir) {
    params.logger?.info?.(`[agenr] predecessor: TUI fallback no predecessor found for ${sessionContext} reason=no_sessions_dir`);
    return undefined;
  }

  params.logger?.info?.(
    `[agenr] predecessor: TUI fallback activated for ${sessionContext} sessionKey=${ctx.sessionKey?.trim() ?? "unknown"} stableLane=${tuiIdentity.stableLane}`,
  );
  debugLog(
    params.logger,
    "predecessor",
    `TUI fallback stable lane for ${sessionContext}: agentId=${tuiIdentity.agentId} instanceLane=${tuiIdentity.instanceLane} stableLane=${tuiIdentity.stableLane} sessionsDir=${sessionsDir}`,
  );

  const fallbackResolution = await findTuiFallbackPredecessor(ctx.sessionKey ?? "", sessionsDir, params.logger);
  if (!fallbackResolution.predecessor) {
    params.logger?.info?.(`[agenr] predecessor: TUI fallback no predecessor found for ${sessionContext} reason=${fallbackResolution.reason}`);
    return undefined;
  }

  params.logger?.info?.(
    `[agenr] predecessor: TUI fallback predecessor found for ${sessionContext} predecessorKey=${fallbackResolution.predecessor.sessionKey} predecessor=${fallbackResolution.predecessor.sessionFile}`,
  );

  return {
    sessionFile: fallbackResolution.predecessor.sessionFile,
    ...(fallbackResolution.predecessor.sessionId ? { sessionId: fallbackResolution.predecessor.sessionId } : {}),
  };
}

/** Resolves predecessor facts from the in-process reset/session_start tracker. */
function resolveTrackedPredecessor(ctx: AgenrOpenClawHookContext, tracker: SessionStartTracker, logger?: PluginLogger): OpenClawSessionPredecessor | undefined {
  const sessionContext = formatSessionContext(ctx.sessionId, ctx.sessionKey);
  const resetRecord = tracker.getLatestReset(ctx.sessionKey);
  if (!resetRecord) {
    debugLog(logger, "predecessor", `no reset record found for ${sessionContext}`);
    return undefined;
  }

  debugLog(logger, "predecessor", `latest reset record for ${sessionContext}: ${formatResetRecord(resetRecord)}`);

  const resumedFrom = tracker.getResumedFrom(ctx.sessionId);
  if (resumedFrom) {
    debugLog(logger, "predecessor", `session_start resumedFrom for ${sessionContext}: ${resumedFrom}`);
  } else {
    debugLog(logger, "predecessor", `session_start resumedFrom unavailable for ${sessionContext}`);
  }

  if (resumedFrom && resetRecord.sessionId && resetRecord.sessionId !== resumedFrom) {
    debugLog(
      logger,
      "predecessor",
      `discarding stale reset record for ${sessionContext}: resumedFrom=${resumedFrom} resetRecordSession=${resetRecord.sessionId}`,
    );
    return undefined;
  }

  return {
    sessionFile: resetRecord.sessionFile,
    ...(resetRecord.sessionId ? { sessionId: resetRecord.sessionId } : {}),
  };
}

/** Finds the best TUI continuity predecessor by scanning OpenClaw's session store. */
async function findTuiFallbackPredecessor(currentSessionKey: string, sessionsDir: string, logger?: PluginLogger): Promise<TuiFallbackResolution> {
  const currentIdentity = parseTuiSessionKey(currentSessionKey);
  if (!currentIdentity) {
    return { reason: "not_tui_session_key" };
  }

  const entries = await readOpenClawSessionsStore(sessionsDir, logger);
  debugLog(logger, "predecessor", `TUI fallback sessions.json read result for sessionKey=${currentSessionKey}: entries=${entries.length}`);

  const sameAgentEntries = entries.filter((entry) => {
    const parsedCandidate = parseSingleLaneSessionKey(entry.sessionKey);
    if (!parsedCandidate) {
      debugLog(logger, "predecessor", `TUI fallback excluded candidate=${entry.sessionKey} reason=unsupported_session_key_shape`);
      return false;
    }

    if (parsedCandidate.agentId !== currentIdentity.agentId) {
      debugLog(
        logger,
        "predecessor",
        `TUI fallback excluded candidate=${entry.sessionKey} reason=agent_mismatch expected=${currentIdentity.agentId} actual=${parsedCandidate.agentId}`,
      );
      return false;
    }

    return true;
  });
  debugLog(logger, "predecessor", `TUI fallback candidate filtering for sessionKey=${currentSessionKey}: sameAgentCount=${sameAgentEntries.length}`);

  const laneMatches = sameAgentEntries.filter((entry) => {
    const normalizedCandidateKey = entry.sessionKey.trim();
    if (normalizedCandidateKey === currentSessionKey.trim()) {
      debugLog(logger, "predecessor", `TUI fallback excluded candidate=${entry.sessionKey} reason=current_session`);
      return false;
    }

    const candidateKey = parseSingleLaneSessionKey(entry.sessionKey);
    if (!candidateKey) {
      return false;
    }

    if (currentIdentity.stableLane === "tui" && candidateKey.lane === "main") {
      return true;
    }

    const candidateIdentity = parseTuiSessionKey(entry.sessionKey);
    if (!candidateIdentity) {
      debugLog(logger, "predecessor", `TUI fallback excluded candidate=${entry.sessionKey} reason=not_tui_candidate`);
      return false;
    }

    if (!isSameTuiFallbackLane(currentIdentity.stableLane, candidateIdentity.stableLane)) {
      debugLog(
        logger,
        "predecessor",
        `TUI fallback excluded candidate=${entry.sessionKey} reason=lane_mismatch currentStableLane=${currentIdentity.stableLane} candidateStableLane=${candidateIdentity.stableLane}`,
      );
      return false;
    }

    return true;
  });
  debugLog(logger, "predecessor", `TUI fallback candidate filtering for sessionKey=${currentSessionKey}: laneMatchCount=${laneMatches.length}`);

  const sortedCandidates = laneMatches
    .filter((entry) => {
      if (entry.updatedAt !== undefined) {
        return true;
      }

      debugLog(logger, "predecessor", `TUI fallback excluded candidate=${entry.sessionKey} reason=missing_updated_at`);
      return false;
    })
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

  if (sortedCandidates.length === 0) {
    return { reason: "no_matching_sessions" };
  }

  const predecessor = sortedCandidates[0]!;
  if (!predecessor.sessionFile?.trim()) {
    debugLog(
      logger,
      "predecessor",
      `TUI fallback top candidate missing session file for sessionKey=${currentSessionKey}: predecessorKey=${predecessor.sessionKey}`,
    );
    return { reason: "missing_session_file" };
  }

  return {
    reason: "resolved",
    predecessor: {
      sessionFile: predecessor.sessionFile,
      ...(predecessor.sessionId ? { sessionId: predecessor.sessionId } : {}),
      sessionKey: predecessor.sessionKey,
    },
  };
}

/** Resolves the agent-scoped OpenClaw sessions directory for TUI predecessor fallback. */
function resolveOpenClawSessionsDirectory(
  ctx: AgenrOpenClawHookContext,
  fallbackAgentId: string,
  resolveStateDir: AgenrOpenClawRuntime["state"]["resolveStateDir"],
): string | undefined {
  const agentId = ctx.agentId?.trim() || fallbackAgentId.trim();
  if (!agentId) {
    return undefined;
  }

  return path.join(resolveStateDir(process.env), "agents", agentId, "sessions");
}

/** Parses one-lane OpenClaw session keys of the form `agent:<agentId>:<lane>`. */
function parseSingleLaneSessionKey(sessionKey: string): ParsedSingleLaneSessionKey | null {
  const match = /^agent:([^:]+):([^:]+)$/i.exec(sessionKey.trim());
  if (!match) {
    return null;
  }

  const [, agentId, lane] = match;
  const normalizedAgentId = agentId?.trim();
  const normalizedLane = lane?.trim();
  if (!normalizedAgentId || !normalizedLane) {
    return null;
  }

  return {
    agentId: normalizedAgentId,
    lane: normalizedLane,
  };
}

/** Matches TUI fallback lanes, treating `tui` as the broad continuity bucket after `/new`. */
function isSameTuiFallbackLane(currentStableLane: string, candidateStableLane: string): boolean {
  if (currentStableLane === "tui") {
    return candidateStableLane.toLowerCase().startsWith("tui");
  }

  return currentStableLane === candidateStableLane;
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: PluginLogger | undefined, subsystem: string, message: string): void {
  logger?.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/** Formats stable session identifiers for OpenClaw adapter log messages. */
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

/** Formats a concise reset-record string for debug logs. */
function formatResetRecord(record: SessionResetRecord): string {
  return `sessionFile=${record.sessionFile}${record.sessionId ? ` sessionId=${record.sessionId}` : ""} recordedAt=${record.recordedAt}`;
}
