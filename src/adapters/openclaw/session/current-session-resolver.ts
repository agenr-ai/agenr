import * as fs from "node:fs/promises";
import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { OpenClawEpisodeTarget } from "../episode/episode-writer.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawRuntime } from "../types.js";
import { parseTuiSessionKey } from "./tui-lane.js";

const GENERIC_AGENT_SESSION_KEY_PATTERN = /^agent:([^:]+):/i;

/**
 * Resolves the transcript file for the active OpenClaw session.
 *
 * The current session's transcript lives at
 * `<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl`. The agent id is
 * taken from the hook context when present and otherwise parsed from the
 * session key. The resolver fails closed when identity is missing or the
 * transcript file does not exist yet.
 *
 * @param ctx - Active OpenClaw hook context for the ended session.
 * @param params - State-dir resolver, optional main key, and logger.
 * @returns Current-session episode target, or `undefined` when unresolvable.
 */
export async function resolveOpenClawCurrentSessionTarget(
  ctx: AgenrOpenClawHookContext,
  params: {
    resolveStateDir: AgenrOpenClawRuntime["state"]["resolveStateDir"];
    logger?: PluginLogger;
  },
): Promise<OpenClawEpisodeTarget | undefined> {
  const sessionId = ctx.sessionId?.trim();
  if (!sessionId) {
    params.logger?.debug?.("[agenr] session-end: current-session resolution skipped reason=no_session_id");
    return undefined;
  }

  const agentId = ctx.agentId?.trim() || resolveAgentIdFromSessionKey(ctx.sessionKey);
  if (!agentId) {
    params.logger?.debug?.(`[agenr] session-end: current-session resolution skipped for session=${sessionId} reason=no_agent_id`);
    return undefined;
  }

  const sessionsDir = path.join(params.resolveStateDir(process.env), "agents", agentId, "sessions");
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

  try {
    const stats = await fs.stat(sessionFile);
    if (!stats.isFile()) {
      return undefined;
    }
  } catch {
    params.logger?.debug?.(`[agenr] session-end: current-session transcript not found for session=${sessionId} file=${sessionFile}`);
    return undefined;
  }

  return { sessionId, sessionFile };
}

/**
 * Derives the owning OpenClaw agent identifier from a session key.
 *
 * @param sessionKey - Stable OpenClaw session key.
 * @returns Agent identifier, or `undefined` when unavailable.
 */
function resolveAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const trimmedSessionKey = sessionKey?.trim();
  if (!trimmedSessionKey) {
    return undefined;
  }

  const tuiIdentity = parseTuiSessionKey(trimmedSessionKey);
  if (tuiIdentity) {
    return tuiIdentity.agentId;
  }

  const match = GENERIC_AGENT_SESSION_KEY_PATTERN.exec(trimmedSessionKey);
  return match?.[1]?.trim() || undefined;
}
