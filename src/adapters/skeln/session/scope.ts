import type { AgenrSkelnSessionScope, SkelnHostContext } from "../types.js";

/**
 * Skeln uses two session key shapes on purpose:
 *
 * - `resolveSkelnSessionKey` (this module) builds `skeln:session:…` recall/store
 *   routing keys scoped to one Skeln session lifetime and cwd.
 * - `resolveSessionIdentityKey` in `app/plugin-runtime/session-tracking` builds
 *   `session:…` / `key:…` keys for in-process trackers such as
 *   {@link createSkelnSessionScopeTracker}.
 *
 * Do not collapse these into one helper without revisiting recall provenance.
 */

/**
 * Derives one stable recall/session key from Skeln session identity and cwd.
 *
 * The key scopes durable recall and store provenance to one Skeln session
 * lifetime within one working directory.
 *
 * @param sessionId - Ephemeral Skeln session identifier.
 * @param cwd - Active session working directory.
 * @returns Stable session key used by agenr recall and store surfaces.
 */
export function resolveSkelnSessionKey(sessionId: string, cwd: string): string {
  const normalizedSessionId = sessionId.trim();
  const normalizedCwd = cwd.trim();
  if (!normalizedSessionId) {
    throw new Error("Skeln session id is required to derive a session key.");
  }

  if (!normalizedCwd) {
    return `skeln:session:${normalizedSessionId}`;
  }

  return `skeln:session:${normalizedSessionId}:cwd:${normalizedCwd}`;
}

/**
 * Input facts used to build one {@link SkelnHostContext} without a Skeln host
 * callback.
 */
export interface BuildSkelnHostContextInput {
  /** Ephemeral Skeln session identifier. */
  sessionId: string;
  /** Active session working directory. */
  cwd: string;
  /** Optional repository root supplied by the host extension. */
  gitRoot?: string;
  /** Optional git branch supplied by the host extension. */
  gitBranch?: string;
  /** Optional project label supplied by the host extension. */
  project?: string;
}

/**
 * Normalizes optional scope strings into trimmed non-empty values.
 *
 * @param value - Candidate scope field.
 * @returns Trimmed value, or `undefined` when blank.
 */
export function normalizeSkelnScopeField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Builds one Skeln host context from session identity and optional git scope.
 *
 * @param input - Session identity and optional scope fields.
 * @returns Host context used by the agenr Skeln adapter.
 */
export function buildSkelnHostContext(input: BuildSkelnHostContextInput): SkelnHostContext {
  const cwd = input.cwd.trim();
  if (!cwd) {
    throw new Error("Skeln cwd is required to build host context.");
  }

  const gitRoot = normalizeSkelnScopeField(input.gitRoot);
  const gitBranch = normalizeSkelnScopeField(input.gitBranch);
  const project = normalizeSkelnScopeField(input.project);

  return {
    cwd,
    sessionKey: resolveSkelnSessionKey(input.sessionId, cwd),
    ...(gitRoot ? { gitRoot } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(project ? { project } : {}),
  };
}

/**
 * Merges optional host-supplied scope fields over adapter-derived defaults.
 *
 * @param defaults - Adapter-derived host context from the active session.
 * @param override - Optional host callback output to merge on top.
 * @returns Effective host context for one turn or lifecycle hook.
 */
export function mergeSkelnHostContext(defaults: SkelnHostContext, override?: Partial<SkelnHostContext>): SkelnHostContext {
  if (!override) {
    return defaults;
  }

  const merged: SkelnHostContext = {
    cwd: normalizeSkelnScopeField(override.cwd) ?? defaults.cwd,
    sessionKey: normalizeSkelnScopeField(override.sessionKey) ?? defaults.sessionKey,
  };

  const gitRoot = normalizeSkelnScopeField(override.gitRoot) ?? defaults.gitRoot;
  if (gitRoot) {
    merged.gitRoot = gitRoot;
  }

  const gitBranch = normalizeSkelnScopeField(override.gitBranch) ?? defaults.gitBranch;
  if (gitBranch) {
    merged.gitBranch = gitBranch;
  }

  const project = normalizeSkelnScopeField(override.project) ?? defaults.project;
  if (project) {
    merged.project = project;
  }

  return merged;
}

/**
 * Converts one host context into the adapter session scope record used by
 * lifecycle hooks and recall routing.
 *
 * @param hostContext - Effective host context for the active session.
 * @param sessionId - Ephemeral Skeln session identifier.
 * @returns Resolved session scope for adapter hooks.
 */
export function toSkelnSessionScope(hostContext: SkelnHostContext, sessionId: string): AgenrSkelnSessionScope {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error("Skeln session id is required to build session scope.");
  }

  return {
    sessionId: normalizedSessionId,
    sessionKey: hostContext.sessionKey,
    cwd: hostContext.cwd,
    ...(hostContext.gitRoot ? { gitRoot: hostContext.gitRoot } : {}),
    ...(hostContext.gitBranch ? { gitBranch: hostContext.gitBranch } : {}),
    ...(hostContext.project ? { project: hostContext.project } : {}),
  };
}
