import { resolveSessionIdentityKey } from "../../app/plugin-runtime/session-tracking.js";

/**
 * Tracks which compaction artifacts were already injected into prompts.
 */
export interface CompactionPromptTracker {
  /** Returns whether one artifact should be injected for the active session. */
  shouldInject(sessionId: string | undefined, sessionKey: string | undefined, artifactSourceId: string): boolean;
  /** Records one injected compaction artifact for the active session. */
  markInjected(sessionId: string | undefined, sessionKey: string | undefined, artifactSourceId: string): void;
  /** Clears tracked compaction prompt state for one session identity. */
  clear(sessionId: string | undefined, sessionKey: string | undefined): void;
}

/**
 * Creates the per-process tracker used to dedupe compaction prompt injection.
 *
 * @returns Compaction prompt tracker instance.
 */
export function createCompactionPromptTracker(): CompactionPromptTracker {
  const injectedBySession = new Map<string, string>();

  return {
    shouldInject(sessionId, sessionKey, artifactSourceId) {
      const key = resolveTrackingKey(sessionId, sessionKey);
      if (!key) {
        return false;
      }

      return injectedBySession.get(key) !== artifactSourceId;
    },
    markInjected(sessionId, sessionKey, artifactSourceId) {
      const key = resolveTrackingKey(sessionId, sessionKey);
      if (!key) {
        return;
      }

      injectedBySession.set(key, artifactSourceId);
    },
    clear(sessionId, sessionKey) {
      const key = resolveTrackingKey(sessionId, sessionKey);
      if (!key) {
        return;
      }

      injectedBySession.delete(key);
    },
  };
}

/** Resolves the stable session tracking key used by prompt injection dedupe. */
function resolveTrackingKey(sessionId: string | undefined, sessionKey: string | undefined): string | undefined {
  return resolveSessionIdentityKey(sessionId, sessionKey);
}
