import type { WorkingScopeKind } from "./constants.js";

/**
 * Raw scope facts supplied by a host runtime.
 */
export interface WorkingScope {
  /** Host session id when distinct from the stable session key. */
  sessionId?: string;
  /** Explicit canonical scope key when the host already resolved it. */
  scopeKey?: string;
  /** Host session key for the active transcript or session tree. */
  sessionKey?: string;
  /** Git repository root when known. */
  gitRoot?: string;
  /** Active Git branch when known. */
  gitBranch?: string;
  /** Current working directory when known. */
  cwd?: string;
  /** Project label supplied by the host or config. */
  project?: string;
  /** Explicit task identifier for multiple concurrent work items. */
  taskId?: string;
  /** Host-neutral conversation identifier. */
  conversationKey?: string;
  /** Host-neutral runtime thread identifier. */
  runtimeThreadKey?: string;
  /** Compatibility thread identifier when a host actually uses that term. */
  hostThreadId?: string;
}

/**
 * Canonical working scope selected by agenr.
 */
export interface ResolvedWorkingScope extends WorkingScope {
  /** Canonical scope key used by persistence and cardinality checks. */
  scopeKey: string;
  /** Resolution strategy that produced the canonical scope key. */
  scopeKind: WorkingScopeKind;
}
