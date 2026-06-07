/**
 * App-layer helper that applies memory-directive abstention to a bounded set of
 * injection candidates.
 *
 * Two things happen here:
 *
 * 1. Directive rows are never injected as generic memory. A stored directive is
 *    an instruction about memory, not a fact to surface, so any candidate whose
 *    durable is itself a memory directive is dropped.
 * 2. Candidates that mention a blocked topic are suppressed. The active
 *    directives are fetched lazily through the supplied lookup so callers that
 *    do not wire one (for example narrow eval seams) simply skip topic
 *    suppression.
 *
 * The lookup is treated as best-effort: if it throws, the helper fails open and
 * keeps the non-directive candidates rather than blanking memory on a transient
 * directive-store error.
 */

import { collectAbstainDirectives, findAbstainViolation } from "../../core/directives/abstain.js";
import { isDirectiveDurable, isProactiveDirectiveDurable } from "../../core/directives/model.js";
import type { Durable } from "../../core/types.js";

/** Source kinds that can pass through automatic injection abstention. */
type InjectionSourceKind = "profile" | "directive" | "core" | "artifact_recall" | "turn_recall";

/** Minimal injection item shape accepted by the abstain filter. */
interface AbstainFilterItem {
  durable: Durable;
  sourceKind?: InjectionSourceKind;
}

/**
 * Reason a candidate was suppressed by the abstain filter.
 *
 * - `directive_self`: the candidate durable is itself a memory directive.
 * - `directive_topic`: the candidate mentioned a directive's blocked topic.
 */
export type AbstainSuppressionReason = "directive_self" | "directive_topic";

/**
 * One suppressed candidate recorded for diagnostics.
 */
export interface AbstainSuppression {
  /** Durable id of the suppressed candidate. */
  durableId: string;
  /** Why the candidate was suppressed. */
  reason: AbstainSuppressionReason;
  /** Directive id responsible for a topic suppression, when applicable. */
  directiveId?: string;
  /** Blocked topic phrase that matched, when applicable. */
  blockedTerm?: string;
}

/**
 * Stable notice recorded when the directive lookup fails and the filter falls
 * open. Directive rows are still withheld, but blocked-topic suppression could
 * not run, so operators can see that abstention ran in a degraded mode.
 */
const ABSTAIN_DIRECTIVE_LOOKUP_FAILED_NOTICE =
  "Memory-directive lookup failed; blocked-topic suppression was skipped this pass and only directive rows were withheld.";

export { ABSTAIN_DIRECTIVE_LOOKUP_FAILED_NOTICE };

/**
 * Result of applying the abstain filter to a candidate list.
 */
export interface AbstainFilterResult<T> {
  /** Candidates that survived the filter, in input order. */
  kept: T[];
  /** Suppressed candidates with their reasons. */
  suppressed: AbstainSuppression[];
  /** True when the directive lookup threw and topic suppression was skipped. */
  lookupFailed: boolean;
}

/**
 * Applies memory-directive abstention to injection candidates.
 *
 * @param items - Candidate injection items, each wrapping a durable.
 * @param listActiveAbstainDirectives - Optional lookup for active directive durables.
 * @returns Kept candidates plus a record of every suppression.
 */
export async function applyAbstainDirectives<T extends AbstainFilterItem>(
  items: readonly T[],
  listActiveAbstainDirectives: (() => Promise<Durable[]>) | undefined,
): Promise<AbstainFilterResult<T>> {
  if (items.length === 0) {
    return { kept: [...items], suppressed: [], lookupFailed: false };
  }

  const suppressed: AbstainSuppression[] = [];
  const nonDirectiveItems: T[] = [];
  for (const item of items) {
    if (isDirectiveDurable(item.durable) && !isAllowedDirectiveInjectionItem(item)) {
      suppressed.push({ durableId: item.durable.id, reason: "directive_self" });
      continue;
    }

    nonDirectiveItems.push(item);
  }

  if (!listActiveAbstainDirectives || nonDirectiveItems.length === 0) {
    return { kept: nonDirectiveItems, suppressed, lookupFailed: false };
  }

  let directiveRows: Durable[];
  try {
    directiveRows = await listActiveAbstainDirectives();
  } catch {
    // Fail open: a directive-lookup failure must not blank out memory. The
    // directive rows we already removed stay removed, and the caller surfaces
    // a degraded notice because blocked-topic suppression could not run.
    return { kept: nonDirectiveItems, suppressed, lookupFailed: true };
  }

  const directives = collectAbstainDirectives(directiveRows);
  if (directives.length === 0) {
    return { kept: nonDirectiveItems, suppressed, lookupFailed: false };
  }

  const kept: T[] = [];
  for (const item of nonDirectiveItems) {
    const violation = findAbstainViolation(item.durable, directives);
    if (violation) {
      suppressed.push({
        durableId: item.durable.id,
        reason: "directive_topic",
        directiveId: violation.directiveId,
        blockedTerm: violation.blockedTerm,
      });
      continue;
    }

    kept.push(item);
  }

  return { kept, suppressed, lookupFailed: false };
}

/**
 * Diagnostics sink updated when directive abstention suppresses injection candidates.
 */
export interface AbstainInjectionDiagnostics {
  /** Durables suppressed from injection by active memory directives. */
  directiveAbstentions?: AbstainSuppression[];
  /** Stable notices describing directive suppressions. */
  notices: string[];
}

/**
 * Builds a stable human-readable notice for one directive suppression.
 *
 * @param suppression - Recorded directive suppression.
 * @returns Notice string for injection diagnostics.
 */
export function buildAbstentionNotice(suppression: AbstainSuppression): string {
  if (suppression.reason === "directive_self") {
    return `Skipped injecting memory directive ${suppression.durableId}; directives are not surfaced as memory.`;
  }

  const directive = suppression.directiveId ?? "unknown";
  const term = suppression.blockedTerm ?? "a blocked topic";
  return `Suppressed durable ${suppression.durableId} because memory directive ${directive} blocks "${term}".`;
}

/**
 * Applies memory-directive abstention to injection candidates and records diagnostics.
 *
 * @param items - Candidate injection items, each wrapping a durable.
 * @param listActiveAbstainDirectives - Optional lookup for active directive durables.
 * @param diagnostics - Mutable diagnostics sink updated when suppressions occur.
 * @returns Candidates that survived the abstain filter.
 */
export async function applyAbstainDirectivesForInjection<T extends AbstainFilterItem>(
  items: readonly T[],
  listActiveAbstainDirectives: (() => Promise<Durable[]>) | undefined,
  diagnostics: AbstainInjectionDiagnostics,
): Promise<T[]> {
  const result = await applyAbstainDirectives(items, listActiveAbstainDirectives);
  if (result.lookupFailed) {
    diagnostics.notices.push(ABSTAIN_DIRECTIVE_LOOKUP_FAILED_NOTICE);
  }

  if (result.suppressed.length > 0) {
    diagnostics.directiveAbstentions = result.suppressed;
    for (const suppression of result.suppressed) {
      diagnostics.notices.push(buildAbstentionNotice(suppression));
    }
  }

  return result.kept;
}

/** Returns whether a directive can be injected into the prompt surface. */
function isAllowedDirectiveInjectionItem(item: AbstainFilterItem): boolean {
  return item.sourceKind === "directive" && isProactiveDirectiveDurable(item.durable);
}
