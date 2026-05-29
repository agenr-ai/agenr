import type { MidSessionState } from "../types.js";
import { resolveSessionIdentityKey } from "../../../app/plugin-runtime/session-tracking.js";

/**
 * Tracks per-session state for mid-session store nudging.
 */
export interface MidSessionTracker {
  /**
   * Returns the tracked state for one session, creating it when needed.
   *
   * @param sessionId - Ephemeral OpenClaw session UUID when available.
   * @param sessionKey - Stable OpenClaw session key fallback.
   * @returns Mutable session state, or `undefined` when no identity is available.
   */
  getOrCreate(sessionId?: string, sessionKey?: string): MidSessionState | undefined;
  /**
   * Returns the current tracked state for one session without creating it.
   *
   * @param sessionId - Ephemeral OpenClaw session UUID when available.
   * @param sessionKey - Stable OpenClaw session key fallback.
   * @returns Existing session state, or `undefined` when none is tracked.
   */
  peek(sessionId?: string, sessionKey?: string): MidSessionState | undefined;
  /**
   * Records one non-first conversational turn for the tracked session.
   *
   * @param sessionId - Ephemeral OpenClaw session UUID when available.
   * @param sessionKey - Stable OpenClaw session key fallback.
   * @returns Updated session state, or `undefined` when no identity is available.
   */
  recordTurn(sessionId?: string, sessionKey?: string): MidSessionState | undefined;
  /**
   * Removes tracked state for one ended session.
   *
   * @param sessionId - Ephemeral OpenClaw session UUID when available.
   * @param sessionKey - Stable OpenClaw session key fallback.
   * @returns True when a tracked session was removed.
   */
  clear(sessionId?: string, sessionKey?: string): boolean;
  /**
   * Reports how many session states are currently tracked.
   *
   * @returns Active mid-session state count.
   */
  activeCount(): number;
}

/**
 * Creates the per-process tracker used by mid-session store nudging.
 *
 * @returns Mutable tracker for per-session nudge state.
 */
export function createMidSessionTracker(): MidSessionTracker {
  const states = new Map<string, MidSessionState>();

  return {
    getOrCreate(sessionId, sessionKey) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      if (!identityKey) {
        return undefined;
      }

      const existingState = states.get(identityKey);
      if (existingState) {
        return existingState;
      }

      const nextState = createMidSessionState();
      states.set(identityKey, nextState);
      return nextState;
    },
    peek(sessionId, sessionKey) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      return identityKey ? states.get(identityKey) : undefined;
    },
    recordTurn(sessionId, sessionKey) {
      const state = this.getOrCreate(sessionId, sessionKey);
      if (!state) {
        return undefined;
      }

      state.turnCount += 1;
      return state;
    },
    clear(sessionId, sessionKey) {
      const identityKey = resolveSessionIdentityKey(sessionId, sessionKey);
      return identityKey ? states.delete(identityKey) : false;
    },
    activeCount() {
      return states.size;
    },
  };
}

/**
 * Adds one stored subject to the bounded subject history used by nudge copy.
 *
 * @param state - Mutable mid-session state to update.
 * @param subject - Candidate subject extracted from agenr_store params.
 * @returns Nothing.
 */
export function pushMidSessionStoredSubject(state: MidSessionState, subject: string | undefined): void {
  const normalizedSubject = subject?.trim();
  if (!normalizedSubject) {
    return;
  }

  const existingIndex = state.storedSubjects.findIndex((value) => value === normalizedSubject);
  if (existingIndex >= 0) {
    state.storedSubjects.splice(existingIndex, 1);
  }

  state.storedSubjects.push(normalizedSubject);
  while (state.storedSubjects.length > MAX_STORED_SUBJECTS) {
    state.storedSubjects.shift();
  }
}

/**
 * Creates the initial state for one tracked mid-session nudge lifecycle.
 *
 * @returns Fresh mutable session state.
 */
function createMidSessionState(): MidSessionState {
  return {
    turnCount: 0,
    lastSuccessfulStoreTurn: 0,
    lastMemoryActionTurn: 0,
    lastExplicitMemoryActionTurn: 0,
    nudgeCount: 0,
    entriesStored: 0,
    storedSubjects: [],
  };
}

const MAX_STORED_SUBJECTS = 5;
