import type { AgenrSkelnSessionScope } from "../types.js";
import { resolveSessionIdentityKey } from "./identity.js";

/**
 * Tracks which Skeln sessions have already consumed session-start recall.
 */
export interface SessionStartTracker {
  /**
   * Marks a session as started and reports whether this is the first start signal.
   *
   * @param sessionId - Ephemeral Skeln session identifier when available.
   * @param sessionKey - Stable agenr session key fallback.
   * @returns Tracking facts for the attempted session-start event.
   */
  consume(sessionId?: string, sessionKey?: string): SessionStartConsumeResult;
}

/**
 * Tracks session-start scope facts recorded by Skeln lifecycle hooks.
 */
export interface SkelnSessionScopeTracker {
  /**
   * Records one session_start transition for later hook lookups.
   *
   * @param scope - Resolved session scope for the active Skeln session.
   */
  rememberSessionStart(scope: AgenrSkelnSessionScope): void;
  /**
   * Returns the most recently recorded scope for one session id.
   *
   * @param sessionId - Ephemeral Skeln session identifier lookup.
   * @returns Recorded session scope, or `undefined` when unavailable.
   */
  getSessionScope(sessionId: string): AgenrSkelnSessionScope | undefined;
  /**
   * Removes tracked scope for one ended session.
   *
   * @param sessionId - Ephemeral Skeln session identifier when available.
   * @param sessionKey - Stable agenr session key fallback.
   * @returns True when tracked scope was removed.
   */
  clear(sessionId?: string, sessionKey?: string): boolean;
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
 * @returns Mutable session tracker for the Skeln adapter runtime.
 */
export function createSessionStartTracker(): SessionStartTracker {
  const seenSessionIdentities = new Set<string>();

  return {
    consume(sessionId, sessionKey) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      if (!identityKey) {
        return {
          isFirst: true,
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

/**
 * Creates the per-process tracker used to remember session_start scope facts.
 *
 * @returns Mutable scope tracker for the Skeln adapter runtime.
 */
export function createSkelnSessionScopeTracker(): SkelnSessionScopeTracker {
  const scopesByIdentity = new Map<string, AgenrSkelnSessionScope>();

  return {
    rememberSessionStart(scope) {
      const identityKey = resolveSessionIdentityKey(scope.sessionId, scope.sessionKey);
      if (!identityKey) {
        return;
      }

      scopesByIdentity.set(identityKey, scope);
    },
    getSessionScope(sessionId) {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        return undefined;
      }

      return scopesByIdentity.get(`session:${normalizedSessionId}`);
    },
    clear(sessionId, sessionKey) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      return identityKey ? scopesByIdentity.delete(identityKey) : false;
    },
  };
}
