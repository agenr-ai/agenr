import type { AgenrSkelnSessionScope } from "../types.js";
import { resolveSessionIdentityKey } from "../../../app/plugin-runtime/session-tracking.js";

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
