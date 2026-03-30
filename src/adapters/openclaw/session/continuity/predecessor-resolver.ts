import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { AgenrOpenClawHookContext, AgenrOpenClawRuntime } from "../../types.js";
import { readOpenClawSessionsStore } from "../sessions-store-reader.js";
import type { SessionStartTracker } from "../state.js";
import { parseTuiSessionKey } from "../tui-lane.js";
import type { OpenClawSessionPredecessor } from "./types.js";

/** Parsed agent-and-lane facts for single-lane OpenClaw session keys. */
interface ParsedSingleLaneSessionKey {
  agentId: string;
  lane: string;
}

/** Fully resolved predecessor facts returned by the TUI sessions-store scan. */
interface ResolvedTuiPredecessor {
  sessionFile: string;
  sessionId?: string;
  sessionKey: string;
}

/** Best-effort outcome from TUI-specific predecessor resolution. */
type TuiPredecessorResolution =
  | {
      predecessor: ResolvedTuiPredecessor;
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
 * Predecessor resolution scans the OpenClaw sessions store for the most recent
 * same-agent, same-lane session for the active TUI session. When
 * `session_start` provides a `resumedFrom` session UUID, it is matched against
 * the sessions store before lane-based matching. This resolver is TUI-specific
 * for now, and non-TUI surfaces are not yet supported.
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

  const tuiIdentity = parseTuiSessionKey(ctx.sessionKey ?? "");
  if (!tuiIdentity) {
    debugLog(params.logger, "predecessor", `skipping TUI predecessor resolution for ${sessionContext}: current session key is not TUI`);
    return undefined;
  }

  const resumedFrom = tracker.getResumedFrom(ctx.sessionId);
  if (resumedFrom) {
    debugLog(params.logger, "predecessor", `session_start resumedFrom for ${sessionContext}: ${resumedFrom}`);
  } else {
    debugLog(params.logger, "predecessor", `session_start resumedFrom unavailable for ${sessionContext}`);
  }

  const sessionsDir = resolveOpenClawSessionsDirectory(ctx, tuiIdentity.agentId, params.resolveStateDir);
  if (!sessionsDir) {
    params.logger?.info?.(`[agenr] predecessor: TUI no predecessor found for ${sessionContext} reason=no_sessions_dir`);
    return undefined;
  }

  params.logger?.info?.(
    `[agenr] predecessor: TUI predecessor resolution for ${sessionContext} sessionKey=${ctx.sessionKey?.trim() ?? "unknown"} stableLane=${tuiIdentity.stableLane}`,
  );
  debugLog(
    params.logger,
    "predecessor",
    `TUI stable lane for ${sessionContext}: agentId=${tuiIdentity.agentId} instanceLane=${tuiIdentity.instanceLane} stableLane=${tuiIdentity.stableLane} sessionsDir=${sessionsDir}`,
  );

  const predecessorResolution = await findTuiPredecessor(ctx.sessionKey ?? "", sessionsDir, resumedFrom, params.logger);
  if (!predecessorResolution.predecessor) {
    params.logger?.info?.(`[agenr] predecessor: TUI no predecessor found for ${sessionContext} reason=${predecessorResolution.reason}`);
    return undefined;
  }

  params.logger?.info?.(
    `[agenr] predecessor: TUI predecessor found for ${sessionContext} predecessorKey=${predecessorResolution.predecessor.sessionKey} predecessor=${predecessorResolution.predecessor.sessionFile}`,
  );

  return {
    sessionFile: predecessorResolution.predecessor.sessionFile,
    ...(predecessorResolution.predecessor.sessionId ? { sessionId: predecessorResolution.predecessor.sessionId } : {}),
  };
}

/**
 * Finds the best TUI predecessor by scanning OpenClaw's sessions store.
 *
 * The scan first tries to match `session_start` `resumedFrom` directly against
 * the same-agent sessions store entries. When that fails, it falls back to the
 * most recent same-agent, same-lane TUI session. This helper is TUI-specific
 * for now, and non-TUI surfaces are not yet supported.
 *
 * @param currentSessionKey - Active OpenClaw session key.
 * @param sessionsDir - Agent-scoped OpenClaw sessions directory.
 * @param resumedFrom - Optional `session_start` predecessor session UUID.
 * @param logger - Optional plugin logger.
 * @returns Best-effort TUI predecessor resolution outcome.
 */
async function findTuiPredecessor(
  currentSessionKey: string,
  sessionsDir: string,
  resumedFrom: string | undefined,
  logger?: PluginLogger,
): Promise<TuiPredecessorResolution> {
  const currentIdentity = parseTuiSessionKey(currentSessionKey);
  if (!currentIdentity) {
    return { reason: "not_tui_session_key" };
  }

  const entries = await readOpenClawSessionsStore(sessionsDir, logger);
  debugLog(logger, "predecessor", `TUI sessions.json read result for sessionKey=${currentSessionKey}: entries=${entries.length}`);

  const sameAgentEntries = entries.filter((entry) => {
    const parsedCandidate = parseSingleLaneSessionKey(entry.sessionKey);
    if (!parsedCandidate) {
      debugLog(logger, "predecessor", `TUI excluded candidate=${entry.sessionKey} reason=unsupported_session_key_shape`);
      return false;
    }

    if (parsedCandidate.agentId !== currentIdentity.agentId) {
      debugLog(
        logger,
        "predecessor",
        `TUI excluded candidate=${entry.sessionKey} reason=agent_mismatch expected=${currentIdentity.agentId} actual=${parsedCandidate.agentId}`,
      );
      return false;
    }

    return true;
  });
  debugLog(logger, "predecessor", `TUI candidate filtering for sessionKey=${currentSessionKey}: sameAgentCount=${sameAgentEntries.length}`);

  if (resumedFrom) {
    const resumedFromMatch = sameAgentEntries.find((entry) => entry.sessionId === resumedFrom);
    if (resumedFromMatch?.sessionFile?.trim()) {
      debugLog(
        logger,
        "predecessor",
        `TUI matched session_start resumedFrom for sessionKey=${currentSessionKey}: resumedFrom=${resumedFrom} predecessorKey=${resumedFromMatch.sessionKey}`,
      );
      return {
        reason: "resolved",
        predecessor: {
          sessionFile: resumedFromMatch.sessionFile,
          ...(resumedFromMatch.sessionId ? { sessionId: resumedFromMatch.sessionId } : {}),
          sessionKey: resumedFromMatch.sessionKey,
        },
      };
    }

    if (resumedFromMatch) {
      debugLog(
        logger,
        "predecessor",
        `TUI ignored session_start resumedFrom match for sessionKey=${currentSessionKey}: resumedFrom=${resumedFrom} reason=missing_session_file`,
      );
    } else {
      debugLog(logger, "predecessor", `TUI found no session_start resumedFrom match for sessionKey=${currentSessionKey}: resumedFrom=${resumedFrom}`);
    }
  }

  const laneMatches = sameAgentEntries.filter((entry) => {
    const normalizedCandidateKey = entry.sessionKey.trim();
    if (normalizedCandidateKey === currentSessionKey.trim()) {
      debugLog(logger, "predecessor", `TUI excluded candidate=${entry.sessionKey} reason=current_session`);
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
      debugLog(logger, "predecessor", `TUI excluded candidate=${entry.sessionKey} reason=not_tui_candidate`);
      return false;
    }

    if (!isSameTuiLane(currentIdentity.stableLane, candidateIdentity.stableLane)) {
      debugLog(
        logger,
        "predecessor",
        `TUI excluded candidate=${entry.sessionKey} reason=lane_mismatch currentStableLane=${currentIdentity.stableLane} candidateStableLane=${candidateIdentity.stableLane}`,
      );
      return false;
    }

    return true;
  });
  debugLog(logger, "predecessor", `TUI candidate filtering for sessionKey=${currentSessionKey}: laneMatchCount=${laneMatches.length}`);

  const sortedCandidates = laneMatches
    .filter((entry) => {
      if (entry.updatedAt !== undefined) {
        return true;
      }

      debugLog(logger, "predecessor", `TUI excluded candidate=${entry.sessionKey} reason=missing_updated_at`);
      return false;
    })
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

  if (sortedCandidates.length === 0) {
    return { reason: "no_matching_sessions" };
  }

  const predecessor = sortedCandidates[0]!;
  if (!predecessor.sessionFile?.trim()) {
    debugLog(logger, "predecessor", `TUI top candidate missing session file for sessionKey=${currentSessionKey}: predecessorKey=${predecessor.sessionKey}`);
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

/** Resolves the agent-scoped OpenClaw sessions directory for TUI predecessor resolution. */
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

/** Matches TUI predecessor lanes, treating `tui` as the broad continuity bucket after `/new`. */
function isSameTuiLane(currentStableLane: string, candidateStableLane: string): boolean {
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
