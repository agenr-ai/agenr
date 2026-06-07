import { resolveSessionIdentityKey } from "./session-tracking.js";

/**
 * Tracks lifecycle intake writes that prompt injection depends on.
 */
export interface SessionLifecycleIntakeTracker {
  /** Records one pending lifecycle intake promise for the session identity. */
  track(sessionId: string | undefined, sessionKey: string | undefined, work: Promise<void>): Promise<void>;
  /** Waits for any pending lifecycle intake for the session identity. */
  wait(sessionId: string | undefined, sessionKey: string | undefined): Promise<void>;
  /** Waits for pending intake, then clears tracked state for the session identity. */
  clear(sessionId: string | undefined, sessionKey: string | undefined): Promise<void>;
}

/**
 * Creates a per-process tracker for lifecycle intake that prompt injection reads.
 *
 * @returns Mutable lifecycle intake tracker.
 */
export function createSessionLifecycleIntakeTracker(): SessionLifecycleIntakeTracker {
  const pendingBySession = new Map<string, Promise<void>>();

  return {
    track(sessionId, sessionKey, work) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      if (!identityKey) {
        return work;
      }

      const tracked = work.finally(() => {
        if (pendingBySession.get(identityKey) === tracked) {
          pendingBySession.delete(identityKey);
        }
      });
      pendingBySession.set(identityKey, tracked);
      return tracked;
    },
    async wait(sessionId, sessionKey) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      if (!identityKey) {
        return;
      }

      const pending = pendingBySession.get(identityKey);
      if (pending) {
        await pending;
      }
    },
    async clear(sessionId, sessionKey) {
      await this.wait(sessionId, sessionKey);
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      if (identityKey) {
        pendingBySession.delete(identityKey);
      }
    },
  };
}
