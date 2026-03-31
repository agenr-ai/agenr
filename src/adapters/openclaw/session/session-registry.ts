import { deriveOpenClawSessionIdFromFilePath } from "./session-id.js";
import { readOpenClawSessionsStore } from "./sessions-store-reader.js";
import { parseTuiSessionKey } from "./tui-lane.js";

const GENERIC_AGENT_SESSION_KEY_PATTERN = /^agent:([^:]+):/i;

/**
 * Session metadata exposed to the episode-ingest preflight service.
 */
export interface OpenClawSessionMeta {
  /**
   * Stable OpenClaw session identifier.
   */
  sessionId: string;
  /**
   * Stable source reference for later episode writes.
   */
  sourceRef: string;
  /**
   * OpenClaw session key when present in `sessions.json`.
   */
  sessionKey?: string;
  /**
   * Owning OpenClaw agent identifier when derivable.
   */
  agentId: string | null;
  /**
   * Surface attached to the session when known.
   */
  surface: string | null;
  /**
   * OpenClaw provider when known.
   */
  provider: string | null;
  /**
   * OpenClaw chat type when known.
   */
  chatType: string | null;
  /**
   * Provenance for this metadata.
   */
  metadataSource: "registry";
}

/**
 * Loads OpenClaw session metadata from `sessions.json`.
 *
 * @param sessionsDir - OpenClaw sessions directory that contains `sessions.json`.
 * @returns Registry lookup helpers for episode-ingest preflight.
 */
export async function loadOpenClawSessionRegistry(sessionsDir: string): Promise<{
  getSessionMeta(sessionId: string): Promise<OpenClawSessionMeta | undefined>;
  listSessions(): Promise<OpenClawSessionMeta[]>;
}> {
  const entries = await readOpenClawSessionsStore(sessionsDir);
  const metas: OpenClawSessionMeta[] = [];
  for (const entry of entries) {
    const sessionId = entry.sessionId ?? (entry.sessionFile ? deriveOpenClawSessionIdFromFilePath(entry.sessionFile) : undefined);
    if (!sessionId) {
      continue;
    }

    metas.push({
      sessionId,
      sourceRef: entry.sessionFile ?? `openclaw://sessions/${sessionId}`,
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      agentId: resolveAgentId(entry.sessionKey),
      surface: resolveSurface(entry.surface, entry.sessionKey),
      provider: normalizeNullableString(entry.provider),
      chatType: normalizeNullableString(entry.chatType),
      metadataSource: "registry",
    });
  }

  const metasBySessionId = new Map(metas.map((meta) => [meta.sessionId, meta]));

  return {
    async getSessionMeta(sessionId: string): Promise<OpenClawSessionMeta | undefined> {
      return metasBySessionId.get(sessionId.trim());
    },
    async listSessions(): Promise<OpenClawSessionMeta[]> {
      return [...metas];
    },
  };
}

/**
 * Resolves the owning OpenClaw agent identifier from a session key.
 *
 * @param sessionKey - Stable OpenClaw session key.
 * @returns Agent identifier, or `null` when unavailable.
 */
function resolveAgentId(sessionKey: string | undefined): string | null {
  const trimmedSessionKey = sessionKey?.trim();
  if (!trimmedSessionKey) {
    return null;
  }

  const tuiIdentity = parseTuiSessionKey(trimmedSessionKey);
  if (tuiIdentity) {
    return tuiIdentity.agentId;
  }

  const match = GENERIC_AGENT_SESSION_KEY_PATTERN.exec(trimmedSessionKey);
  return match?.[1]?.trim() || null;
}

/**
 * Normalizes registry-provided surface values with a TUI fallback from the key.
 *
 * @param surface - Registry-provided surface.
 * @param sessionKey - Stable OpenClaw session key.
 * @returns Normalized surface, or `null` when unknown.
 */
function resolveSurface(surface: string | undefined, sessionKey: string | undefined): string | null {
  const normalizedSurface = normalizeNullableString(surface);
  if (normalizedSurface) {
    return normalizedSurface;
  }

  const trimmedKey = sessionKey?.trim().toLowerCase() ?? "";

  if (trimmedKey.includes(":subagent:")) {
    return "subagent";
  }

  if (trimmedKey.includes(":cron:")) {
    return "cron";
  }

  if (parseTuiSessionKey(sessionKey ?? "")) {
    return "tui";
  }

  return null;
}

/**
 * Trims optional strings into nullable normalized values.
 *
 * @param value - Candidate text value.
 * @returns Trimmed lowercase string when present, otherwise `null`.
 */
function normalizeNullableString(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}
