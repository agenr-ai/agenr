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
  /**
   * Remembers a session-start transition emitted by OpenClaw.
   *
   * @param sessionId - New ephemeral OpenClaw session UUID.
   * @param sessionKey - Stable OpenClaw session key for the active lane.
   * @param resumedFrom - Previous session UUID when OpenClaw provides it.
   */
  rememberSessionStart(sessionId?: string, sessionKey?: string, resumedFrom?: string): void;
  /**
   * Returns the predecessor session UUID remembered for a new session.
   *
   * @param sessionId - New ephemeral OpenClaw session UUID lookup.
   * @returns Previous session UUID, or `undefined` when unavailable.
   */
  getResumedFrom(sessionId?: string): string | undefined;
  /**
   * Returns the captured `session_start` event facts for one session.
   *
   * This lets continuity resolution distinguish "no `session_start` observed"
   * from "event observed but no `resumedFrom` was present".
   *
   * @param sessionId - New ephemeral OpenClaw session UUID lookup.
   * @returns Captured session-start facts, or `undefined` when unseen.
   */
  getSessionStart(sessionId?: string): RememberedSessionStart | undefined;
}

/**
 * Captured `session_start` facts remembered for one OpenClaw session id.
 */
export interface RememberedSessionStart {
  /**
   * New ephemeral OpenClaw session UUID.
   */
  sessionId: string;
  /**
   * Stable OpenClaw session key reported by the host event when present.
   */
  sessionKey?: string;
  /**
   * Previous session UUID reported by `session_start.resumedFrom` when present.
   */
  resumedFrom?: string;
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
  const sessionStartsBySessionId = new Map<string, RememberedSessionStart>();

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
    rememberSessionStart(sessionId, sessionKey, resumedFrom) {
      const normalizedSessionId = sessionId?.trim();
      if (!normalizedSessionId) {
        return;
      }

      const previous = sessionStartsBySessionId.get(normalizedSessionId);
      const normalizedSessionKey = sessionKey?.trim();
      const normalizedResumedFrom = resumedFrom?.trim();

      sessionStartsBySessionId.set(normalizedSessionId, {
        sessionId: normalizedSessionId,
        ...(previous?.sessionKey ? { sessionKey: previous.sessionKey } : {}),
        ...(previous?.resumedFrom ? { resumedFrom: previous.resumedFrom } : {}),
        ...(normalizedSessionKey ? { sessionKey: normalizedSessionKey } : {}),
        ...(normalizedResumedFrom ? { resumedFrom: normalizedResumedFrom } : {}),
      });
    },
    getResumedFrom(sessionId) {
      const normalizedSessionId = sessionId?.trim();
      return normalizedSessionId ? sessionStartsBySessionId.get(normalizedSessionId)?.resumedFrom : undefined;
    },
    getSessionStart(sessionId) {
      const normalizedSessionId = sessionId?.trim();
      return normalizedSessionId ? sessionStartsBySessionId.get(normalizedSessionId) : undefined;
    },
  };
}
