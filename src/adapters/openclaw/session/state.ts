/**
 * Tracks which OpenClaw sessions have already consumed session-start recall.
 */
export interface SessionStartTracker {
  /**
   * Marks a session as started and reports whether this is the first start signal.
   *
   * @param sessionId - Ephemeral OpenClaw session UUID when available.
   * @param sessionKey - Stable OpenClaw session key fallback.
   * @returns Tracking facts for the attempted session-start event.
   */
  consume(sessionId?: string, sessionKey?: string): SessionStartConsumeResult;
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
 * Creates the per-process tracker used to avoid re-running session-start recall every turn.
 *
 * @returns Mutable session tracker for the OpenClaw plugin runtime.
 */
export function createSessionStartTracker(): SessionStartTracker {
  const seenSessionIds = new Set<string>();
  const seenSessionKeys = new Set<string>();

  const countActiveSessions = () => seenSessionIds.size + seenSessionKeys.size;

  return {
    consume(sessionId, sessionKey) {
      const normalizedSessionId = sessionId?.trim();
      if (normalizedSessionId) {
        if (seenSessionIds.has(normalizedSessionId)) {
          return {
            isFirst: false,
            activeCount: countActiveSessions(),
          };
        }
        seenSessionIds.add(normalizedSessionId);
        return {
          isFirst: true,
          activeCount: countActiveSessions(),
        };
      }

      const normalizedSessionKey = sessionKey?.trim();
      if (normalizedSessionKey) {
        if (seenSessionKeys.has(normalizedSessionKey)) {
          return {
            isFirst: false,
            activeCount: countActiveSessions(),
          };
        }
        seenSessionKeys.add(normalizedSessionKey);
        return {
          isFirst: true,
          activeCount: countActiveSessions(),
        };
      }

      return {
        isFirst: true,
        activeCount: countActiveSessions(),
      };
    },
  };
}
