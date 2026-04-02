/**
 * Resolves one stable tracker key from OpenClaw's session identifiers.
 *
 * Session IDs are preferred because OpenClaw regenerates them on `/new` and
 * `/reset`, which naturally scopes state to one session lifetime. Session keys
 * remain the fallback when the ephemeral session ID is unavailable.
 *
 * @param sessionId - Ephemeral OpenClaw session UUID when available.
 * @param sessionKey - Stable OpenClaw routing key fallback.
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
