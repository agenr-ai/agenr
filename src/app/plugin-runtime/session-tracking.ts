/**
 * Resolves one stable tracker key from host session identifiers.
 *
 * Session ids are preferred because hosts regenerate them on `/new` and resume
 * flows that start a fresh session file. Session keys remain the fallback when
 * the ephemeral session id is unavailable.
 *
 * @param sessionId - Ephemeral host session identifier when available.
 * @param sessionKey - Stable host routing key fallback.
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

/**
 * Structured tracking facts returned by the session-start tracker.
 */
export interface SessionStartConsumeResult {
  /**
   * Reports whether the caller should run session-start recall.
   */
  isFirst: boolean;
  /**
   * Reports how many distinct session identities are currently tracked.
   */
  activeCount: number;
}

/**
 * Tracks which host sessions have already consumed session-start recall.
 */
export interface SessionStartTracker {
  /**
   * Marks a session as started and reports whether this is the first start signal.
   *
   * @param sessionId - Ephemeral host session identifier when available.
   * @param sessionKey - Stable host session key fallback.
   * @returns Tracking facts for the attempted session-start event.
   */
  consume(sessionId?: string, sessionKey?: string): SessionStartConsumeResult;
}

/**
 * Creates the per-process tracker used to avoid re-running session-start recall every turn.
 *
 * @returns Mutable session tracker for host plugin runtimes.
 */
export function createSessionStartTracker(): SessionStartTracker {
  const seenSessionIdentities = new Set<string>();

  return {
    consume(sessionId, sessionKey) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      if (!identityKey) {
        return {
          isFirst: false,
          activeCount: seenSessionIdentities.size,
        };
      }

      if (seenSessionIdentities.has(identityKey)) {
        return {
          isFirst: false,
          activeCount: seenSessionIdentities.size,
        };
      }

      seenSessionIdentities.add(identityKey);
      return {
        isFirst: true,
        activeCount: seenSessionIdentities.size,
      };
    },
  };
}
