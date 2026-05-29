/**
 * Derives one stable recall/session key from Skeln session identity and cwd.
 *
 * The key scopes durable recall and store provenance to one Skeln session
 * lifetime within one working directory.
 *
 * @param sessionId - Ephemeral Skeln session identifier.
 * @param cwd - Active session working directory.
 * @returns Stable session key used by agenr recall and store surfaces.
 */
export function resolveSkelnSessionKey(sessionId: string, cwd: string): string {
  const normalizedSessionId = sessionId.trim();
  const normalizedCwd = cwd.trim();
  if (!normalizedSessionId) {
    throw new Error("Skeln session id is required to derive a session key.");
  }

  if (!normalizedCwd) {
    return `skeln:session:${normalizedSessionId}`;
  }

  return `skeln:session:${normalizedSessionId}:cwd:${normalizedCwd}`;
}

/**
 * Resolves one stable tracker key from Skeln session identifiers.
 *
 * Session ids are preferred because Skeln regenerates them on `/new` and
 * resume flows that start a fresh session file. Session keys remain the
 * fallback when the ephemeral session id is unavailable.
 *
 * @param sessionId - Ephemeral Skeln session identifier when available.
 * @param sessionKey - Stable agenr session key fallback.
 * @returns Tracker key, or `undefined` when no identity is available.
 */
export function resolveSessionIdentityKey(sessionId?: string, sessionKey?: string): string | undefined {
  const normalizedSessionId = sessionId?.trim();
  if (normalizedSessionId) {
    return `session:${normalizedSessionId}`;
  }

  const normalizedSessionKey = sessionKey?.trim();
  if (normalizedSessionKey) {
    return `key:${normalizedSessionKey}`;
  }

  return undefined;
}
