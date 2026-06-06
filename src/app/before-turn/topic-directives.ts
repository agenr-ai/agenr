import { normalizeTextForPhraseMatch, textMatchesTopicTrigger } from "../../core/directives/abstain.js";
import { parseDirectiveMetadata } from "../../core/directives/model.js";
import { isWithinValidityWindow } from "../../core/temporal-validity.js";
import type { RecallOutput } from "../../core/recall/index.js";
import type { Durable } from "../../core/types.js";

import { projectClaimCentricRecallEntry } from "../recall/claim-centric.js";

import { formatProjectedProvenance } from "./format-provenance.js";
import type { BeforeTurnDeps } from "./ports.js";
import { selectDurablePatchItems } from "./select-patch-items.js";
import type { BeforeTurnPatchDiagnostics, BeforeTurnPatchItem, BeforeTurnPolicy } from "./types.js";

const TOPIC_PROACTIVE_DIRECTIVE_LOOKUP_FAILED_NOTICE = "Topic proactive directive lookup failed; topic directive surfacing was skipped this pass.";

/**
 * Injects proactive topic directives that match the current turn text.
 *
 * @param currentTurnText - Normalized current user turn.
 * @param recalledItems - Ranked durable recall items selected before injection.
 * @param policy - Effective before-turn policy.
 * @param deps - Before-turn dependencies with optional topic-directive lookup.
 * @param diagnostics - Mutable diagnostics sink updated in place.
 * @returns Recall items merged with any matched topic directives.
 */
export async function injectTopicProactiveDirectives(
  currentTurnText: string,
  recalledItems: BeforeTurnPatchItem[],
  policy: Required<BeforeTurnPolicy>,
  deps: BeforeTurnDeps,
  diagnostics: BeforeTurnPatchDiagnostics,
): Promise<BeforeTurnPatchItem[]> {
  if (!deps.listActiveTopicProactiveDirectives) {
    return recalledItems;
  }

  let directiveRows: Durable[];
  try {
    directiveRows = await deps.listActiveTopicProactiveDirectives();
  } catch {
    diagnostics.notices.push(TOPIC_PROACTIVE_DIRECTIVE_LOOKUP_FAILED_NOTICE);
    return recalledItems;
  }

  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const activeDirectives = filterCurrentEntries(directiveRows, nowMs);
  diagnostics.topicProactiveDirectiveCandidateCount = activeDirectives.length;

  const normalizedTurn = normalizeTextForPhraseMatch(currentTurnText);
  const matchedDirectives = activeDirectives.filter((entry) => {
    const metadata = parseDirectiveMetadata(entry);
    return metadata?.polarity === "proactive" && metadata.trigger.startsWith("topic:") && textMatchesTopicTrigger(normalizedTurn, metadata.trigger);
  });
  diagnostics.topicProactiveDirectiveMatchedCount = matchedDirectives.length;
  if (matchedDirectives.length === 0) {
    return recalledItems;
  }

  const directiveItems = matchedDirectives.map((entry) => buildTopicDirectivePatchItem(entry, deps, policy.highConfidenceRecallThreshold));
  return mergeTopicDirectivePatchItems(directiveItems, recalledItems, policy, diagnostics);
}

/** Filters before-turn directive entries to those valid at the current time. */
export function filterCurrentEntries(entries: Durable[], nowMs: number): Durable[] {
  return entries.filter((entry) => isWithinValidityWindow(entry.valid_from, entry.valid_to, nowMs));
}

function buildTopicDirectivePatchItem(entry: Durable, deps: BeforeTurnDeps, score: number): BeforeTurnPatchItem {
  const metadata = parseDirectiveMetadata(entry);
  const projected = projectClaimCentricRecallEntry(buildSyntheticRecallOutput(entry, score), {
    slotPolicyConfig: deps.slotPolicyConfig,
  });
  const provenanceSummary = formatProjectedProvenance(projected.provenance);

  return {
    rank: 0,
    entry,
    sourceKind: "directive",
    score,
    whySurfaced: {
      summary: `proactive memory directive; trigger ${metadata?.trigger ?? "topic"}`,
      reasons: ["proactive memory directive", `trigger ${metadata?.trigger ?? "topic"}`, `importance ${entry.importance}`],
    },
    memoryState: projected.memoryState,
    claimStatus: projected.claimStatus,
    freshnessLabel: projected.freshness.label,
    ...(provenanceSummary ? { provenanceSummary } : {}),
  };
}

function buildSyntheticRecallOutput(entry: Durable, score: number): RecallOutput {
  return {
    entry,
    score,
    scores: {
      relevance: score,
      rrf: score,
      vector: 0,
      lexical: 0,
      recency: 1,
      importance: entry.importance / 10,
      historicalLineage: 0,
      neighborhoodBoost: 0,
      claimKeyTrustPenalty: 0,
      claimKeyRedundancyPenalty: 0,
    },
  };
}

function mergeTopicDirectivePatchItems(
  directiveItems: BeforeTurnPatchItem[],
  recalledItems: BeforeTurnPatchItem[],
  policy: Required<BeforeTurnPolicy>,
  diagnostics: BeforeTurnPatchDiagnostics,
): BeforeTurnPatchItem[] {
  const seenEntryIds = new Set<string>();
  const merged: BeforeTurnPatchItem[] = [];

  for (const item of [...directiveItems, ...recalledItems]) {
    if (seenEntryIds.has(item.entry.id)) {
      continue;
    }

    seenEntryIds.add(item.entry.id);
    merged.push(item);
  }

  return selectDurablePatchItems(merged, policy, diagnostics);
}
