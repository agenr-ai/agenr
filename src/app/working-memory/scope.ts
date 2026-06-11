import type { WorkingScopeKind } from "./constants.js";
import type { ExplicitWorkingSetTarget } from "./mutations.js";

/**
 * Raw scope facts supplied by a host runtime.
 */
export interface WorkingScope {
  /** Host session id used for provenance columns. */
  sessionId?: string;
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

/** Failure returned when raw host facts cannot produce a canonical scope. */
export interface WorkingScopeResolutionFailure {
  /** Failure discriminator. */
  ok: false;
  /** Stable failure code. */
  code: "missing_scope";
  /** Human-readable failure message. */
  message: string;
}

/** Successful working-scope resolution. */
export interface WorkingScopeResolutionSuccess {
  /** Success discriminator. */
  ok: true;
  /** Canonical resolved scope. */
  scope: ResolvedWorkingScope;
}

/** Result returned by the working-memory scope resolver. */
export type WorkingScopeResolutionResult = WorkingScopeResolutionSuccess | WorkingScopeResolutionFailure;

/**
 * Resolves raw host facts into the canonical scope for one working-set layer.
 *
 * @param scope - Raw scope facts supplied by the host.
 * @param target - Explicit session or goal target to resolve.
 * @returns Resolved scope or a stable missing-scope failure.
 */
export function resolveScopeForLayer(scope: Partial<WorkingScope> | undefined, target: ExplicitWorkingSetTarget): WorkingScopeResolutionResult {
  return target === "session" ? resolveSessionWorkingScope(scope) : resolveGoalWorkingScope(scope);
}

/**
 * Resolves raw host facts into the canonical goal working-memory scope.
 *
 * @param input - Raw scope facts supplied by a host adapter or tool call.
 * @returns Resolved goal scope or a stable missing-scope failure.
 */
export function resolveGoalWorkingScope(input: Partial<WorkingScope> | undefined): WorkingScopeResolutionResult {
  const scope = normalizeWorkingScope(input);
  return buildGoalScope(scope);
}

/** Internal builder that produces a resolved goal scope or failure. */
function buildGoalScope(scope: Partial<WorkingScope>): WorkingScopeResolutionResult {
  if (scope.taskId) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "task",
        scopeKey: `task:${scope.taskId}`,
      },
    };
  }

  if (scope.conversationKey) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "conversation",
        scopeKey: `conversation:${scope.conversationKey}`,
      },
    };
  }

  if (scope.gitRoot && scope.gitBranch) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "git_branch",
        scopeKey: buildScopeKey("git_branch", [scope.project, scope.gitRoot, scope.gitBranch]),
      },
    };
  }

  if (scope.gitRoot && scope.cwd) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "git_cwd",
        scopeKey: buildScopeKey("git_cwd", [scope.project, scope.gitRoot, scope.cwd]),
      },
    };
  }

  return {
    ok: false,
    code: "missing_scope",
    message: "Working memory needs a task, conversation, or git scope.",
  };
}

/**
 * Resolves raw host facts into the canonical session working-memory scope.
 *
 * @param input - Raw scope facts supplied by a host adapter or tool call.
 * @returns Resolved session scope or a stable missing-scope failure.
 */
export function resolveSessionWorkingScope(input: Partial<WorkingScope> | undefined): WorkingScopeResolutionResult {
  const scope = normalizeWorkingScope(input);
  return buildSessionScope(scope);
}

/** Internal builder that produces a resolved session scope or failure. */
function buildSessionScope(scope: Partial<WorkingScope>): WorkingScopeResolutionResult {
  if (!scope.sessionId) {
    return {
      ok: false,
      code: "missing_scope",
      message: "Session working memory needs a session id.",
    };
  }

  return {
    ok: true,
    scope: {
      ...scope,
      scopeKind: "session",
      scopeKey: buildScopeKey("session", [scope.sessionId, scope.cwd ? "cwd" : undefined, scope.cwd]),
    },
  };
}

/**
 * Normalizes raw host scope fields into trimmed optional strings.
 *
 * @param input - Raw scope facts.
 * @returns Scope with blank fields removed.
 */
function normalizeWorkingScope(input: Partial<WorkingScope> | undefined): Partial<WorkingScope> {
  const scope = input ?? {};
  return {
    ...normalizeField("sessionId", scope.sessionId),
    ...normalizeField("gitRoot", scope.gitRoot),
    ...normalizeField("gitBranch", scope.gitBranch),
    ...normalizeField("cwd", scope.cwd),
    ...normalizeField("project", scope.project),
    ...normalizeField("taskId", scope.taskId),
    ...normalizeField("conversationKey", scope.conversationKey),
  };
}

/** Builds one delimited scope key while omitting absent parts. */
function buildScopeKey(prefix: string, parts: Array<string | undefined>): string {
  return [prefix, ...parts.filter((part): part is string => part !== undefined)].join(":");
}

/** Normalizes one scope field into an object spread fragment. */
function normalizeField<K extends keyof WorkingScope>(key: K, value: WorkingScope[K] | undefined): Partial<Pick<WorkingScope, K>> {
  if (typeof value !== "string") {
    return {};
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? ({ [key]: trimmed } as Partial<Pick<WorkingScope, K>>) : {};
}
