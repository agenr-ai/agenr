/**
 * Tracks which OpenClaw sessions have already consumed session-start recall.
 */
export interface SessionStartTracker {
  /**
   * Marks a session as started and reports whether this is the first start signal.
   *
   * @param sessionId - Ephemeral OpenClaw session UUID when available.
   * @param sessionKey - Stable OpenClaw session key fallback.
   * @returns True when session-start recall should run, false when it already ran.
   */
  consume(sessionId?: string, sessionKey?: string): boolean;
}

/**
 * Creates the per-process tracker used to avoid re-running session-start recall every turn.
 *
 * @returns Mutable session tracker for the OpenClaw plugin runtime.
 */
export function createSessionStartTracker(): SessionStartTracker {
  const seenSessionIds = new Set<string>();
  const seenSessionKeys = new Set<string>();

  return {
    consume(sessionId, sessionKey) {
      const normalizedSessionId = sessionId?.trim();
      if (normalizedSessionId) {
        if (seenSessionIds.has(normalizedSessionId)) {
          return false;
        }
        seenSessionIds.add(normalizedSessionId);
        return true;
      }

      const normalizedSessionKey = sessionKey?.trim();
      if (normalizedSessionKey) {
        if (seenSessionKeys.has(normalizedSessionKey)) {
          return false;
        }
        seenSessionKeys.add(normalizedSessionKey);
        return true;
      }

      return true;
    },
  };
}
