import type { HostWorkingSetPolicy } from "./host-working-set-policy.js";
import { layersForList } from "./host-working-set-policy.js";
import type { AgenrWorkTarget } from "./mutations.js";
import type { ResolvedWorkingScope, WorkingScope } from "./scope.js";
import { resolveScopeForLayer, type WorkingScopeResolutionResult } from "./scope-resolver.js";

/** Successful list scope resolution. */
export interface ResolvedListScopes {
  /** Success discriminator. */
  ok: true;
  /** Canonical scopes used to filter listed working sets. */
  scopes: ResolvedWorkingScope[];
}

/** Result used to filter list output by scope. */
export type ResolveListScopesResult = ResolvedListScopes | Extract<WorkingScopeResolutionResult, { ok: false }>;

/**
 * Resolves the scope filters used by list for target-aware requests.
 *
 * Explicit targets require a resolvable scope for that layer. Auto includes every
 * layer that can be resolved from the supplied host facts.
 *
 * @param scope - Raw scope facts supplied by the host.
 * @param target - Requested working-set target.
 * @param policy - Host policy governing goal layer inclusion.
 * @returns Resolved scopes or a stable missing-scope failure.
 */
export function resolveListScopes(scope: Partial<WorkingScope>, target: AgenrWorkTarget | undefined, policy: HostWorkingSetPolicy): ResolveListScopesResult {
  const layers = layersForList(policy, target);
  if (layers.length === 0) {
    return {
      ok: false,
      code: "missing_scope",
      message: "Goal working memory needs a task, conversation, or git scope.",
    };
  }

  if (target === "session" || target === "goal") {
    const resolution = resolveScopeForLayer(scope, layers[0]);
    if (!resolution.ok) {
      return resolution;
    }

    return { ok: true, scopes: [resolution.scope] };
  }

  const scopes: ResolvedWorkingScope[] = [];
  for (const layer of layers) {
    const resolution = resolveScopeForLayer(scope, layer);
    if (resolution.ok) {
      scopes.push(resolution.scope);
    }
  }

  if (scopes.length === 0) {
    return {
      ok: false,
      code: "missing_scope",
      message: "Working memory needs a session id or a task, conversation, or git scope.",
    };
  }

  return { ok: true, scopes };
}
