import type { AgenrSkelnSessionScope, SkelnHostContext } from "../types.js";
import { resolveSkelnSessionKey } from "./identity.js";

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

  return {
    cwd,
    sessionKey: resolveSkelnSessionKey(input.sessionId, cwd),
    ...(normalizeSkelnScopeField(input.gitRoot) ? { gitRoot: normalizeSkelnScopeField(input.gitRoot) } : {}),
    ...(normalizeSkelnScopeField(input.gitBranch) ? { gitBranch: normalizeSkelnScopeField(input.gitBranch) } : {}),
    ...(normalizeSkelnScopeField(input.project) ? { project: normalizeSkelnScopeField(input.project) } : {}),
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
 * @param previousSessionFile - Optional predecessor session file from session_start.
 * @returns Resolved session scope for adapter hooks.
 */
export function toSkelnSessionScope(hostContext: SkelnHostContext, sessionId: string, previousSessionFile?: string): AgenrSkelnSessionScope {
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
    ...(normalizeSkelnScopeField(previousSessionFile) ? { previousSessionFile: normalizeSkelnScopeField(previousSessionFile) } : {}),
  };
}
