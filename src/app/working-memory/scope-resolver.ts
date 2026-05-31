import type { ResolvedWorkingScope, WorkingScope } from "./scope.js";

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
 * Resolves raw host facts into the canonical Phase 1 working-memory scope.
 *
 * @param input - Raw scope facts supplied by a host adapter or tool call.
 * @returns Resolved scope or a stable missing-scope failure.
 */
export function resolveWorkingScope(input: Partial<WorkingScope> | undefined): WorkingScopeResolutionResult {
  const scope = normalizeWorkingScope(input);
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

  const conversationKey = scope.conversationKey ?? scope.runtimeThreadKey;
  if (conversationKey) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "conversation",
        scopeKey: `conversation:${conversationKey}`,
      },
    };
  }

  if (scope.scopeKey) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "session",
        scopeKey: scope.scopeKey,
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

  if (scope.sessionKey) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "session",
        scopeKey: `session:${scope.sessionKey}`,
      },
    };
  }

  if (scope.sessionId) {
    return {
      ok: true,
      scope: {
        ...scope,
        scopeKind: "session_id",
        scopeKey: `session_id:${scope.sessionId}`,
      },
    };
  }

  return {
    ok: false,
    code: "missing_scope",
    message: "Working memory needs a task, conversation, git, session key, or session id scope.",
  };
}

/**
 * Normalizes raw host scope fields into trimmed optional strings.
 *
 * @param input - Raw scope facts.
 * @returns Scope with blank fields removed.
 */
export function normalizeWorkingScope(input: Partial<WorkingScope> | undefined): Partial<WorkingScope> {
  const scope = input ?? {};
  return {
    ...normalizeField("sessionId", scope.sessionId),
    ...normalizeField("scopeKey", scope.scopeKey),
    ...normalizeField("sessionKey", scope.sessionKey),
    ...normalizeField("gitRoot", scope.gitRoot),
    ...normalizeField("gitBranch", scope.gitBranch),
    ...normalizeField("cwd", scope.cwd),
    ...normalizeField("project", scope.project),
    ...normalizeField("taskId", scope.taskId),
    ...normalizeField("conversationKey", scope.conversationKey),
    ...normalizeField("runtimeThreadKey", scope.runtimeThreadKey),
    ...normalizeField("hostThreadId", scope.hostThreadId),
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
