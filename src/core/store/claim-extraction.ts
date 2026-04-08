import type { DatabasePort, LlmPort } from "../ports.js";
import type { EntryType, StoreEntryInput } from "../types.js";
import { applyClaimKeyLifecycle, buildExtractedClaimKeyLifecycle } from "../claim-key-lifecycle.js";
import {
  buildClaimKeySupportSeedFromExamples,
  evaluateClaimKeyCompactness,
  evaluateClaimKeySupport,
  type ClaimKeySupportEvaluation,
} from "../claim-key-support.js";
import {
  compactClaimKey,
  describeClaimKeyNormalizationFailure,
  describeExtractedClaimKeyRejection,
  normalizeClaimKey,
  normalizeClaimKeySegment,
  validateExtractedClaimKey,
} from "../claim-key.js";

const SELF_REFERENTIAL_ENTITIES = new Set(["i", "me", "the_user", "myself", "user", "we", "our_team", "the_project", "this_project"]);
const USER_REFERENTIAL_ENTITIES = new Set(["i", "me", "myself", "the_user", "user"]);
const PROJECT_REFERENTIAL_ENTITIES = new Set(["the_project", "this_project"]);
const DETERMINISTIC_ATTRIBUTE_HEADS = new Set([
  "budget",
  "city",
  "config",
  "deadline",
  "email",
  "employer",
  "language",
  "limit",
  "location",
  "mode",
  "model",
  "name",
  "owner",
  "plan",
  "policy",
  "preference",
  "priority",
  "quota",
  "region",
  "role",
  "schedule",
  "setting",
  "status",
  "strategy",
  "team",
  "theme",
  "timezone",
  "version",
  "window",
]);
const MAX_ENTITY_HINTS = 12;
const MAX_CLAIM_KEY_EXAMPLES = 8;
const MAX_SUPPORT_CLAIM_KEY_EXAMPLES = 128;
const DEFAULT_REPAIR_CONFIDENCE = 0.86;
const HIGH_CONFIDENCE_BACKFILL_THRESHOLD = 0.92;
const SUPPORTED_INGEST_AUTO_APPLY_THRESHOLD = 0.72;
const COMPACTED_SUPPORTED_INGEST_AUTO_APPLY_THRESHOLD = 0.74;
const PROPOSAL_CONFIDENCE_THRESHOLD = 0.75;
const SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD = 0.65;

/** Raw JSON payload expected back from the claim-extraction classifier. */
interface ClaimExtractionResponse {
  entity?: unknown;
  attribute?: unknown;
  confidence?: unknown;
  no_claim?: unknown;
}

/** Prompt modes used for the initial extraction and the JSON repair retry. */
type ClaimExtractionPromptMode = "standard" | "json_retry";

/** Internal normalized hint bundle used by prompt building and deterministic repair. */
interface NormalizedClaimExtractionHints {
  entityHints: string[];
  claimKeyExamples: string[];
  userEntity?: string;
  projectEntity?: string;
  tags: string[];
  sourceContext?: string;
}

/** Ordered mutable hint state shared across a claim-extraction batch. */
interface ClaimExtractionHintState {
  entityHints: string[];
  claimKeyExamples: string[];
  supportClaimKeys: string[];
}

/** Successful model attempt before confidence thresholding is applied. */
interface ClaimExtractionCandidate {
  claimKey: string;
  confidence: number;
  rawEntity: string;
  rawAttribute: string;
  compactedFrom: string | null;
  compactionReason: string | null;
}

/** One successful LLM attempt plus the path that produced it. */
interface ClaimExtractionAttempt {
  path: ClaimExtractionPath;
  response: ClaimExtractionResponse;
}

/**
 * Runtime configuration for optional claim-key extraction.
 */
export interface ClaimExtractionConfig {
  enabled: boolean;
  confidenceThreshold: number;
  eligibleTypes: EntryType[];
  /** Maximum preview workers used by cleanup flows that parallelize claim extraction. Defaults to `10`. */
  concurrency?: number;
}

/**
 * Optional hint inputs used to stabilize claim-key extraction.
 */
export interface ClaimExtractionHints {
  /** Existing entity names that should be preferred when they clearly match. */
  entityHints?: string[];
  /** Existing full claim keys that should be reused when they describe the same slot. */
  claimKeyExamples?: string[];
  /** Optional stable user identifier for resolving phrases like "the user". */
  userId?: string;
  /** Optional stable project identifier for resolving phrases like "the project". */
  project?: string;
  /** Optional entry-local tags that help ground the slot domain without acting as trusted canon. */
  tags?: string[];
  /** Optional entry-local provenance summary that can clarify the durable slot being described. */
  sourceContext?: string;
}

/**
 * Structured preview metadata emitted before claim-extraction thresholding.
 */
export interface ClaimExtractionPreviewOutcome {
  /** Final preview outcome for the model response before deterministic fallback. */
  outcome: "candidate" | "no_claim" | "rejected_candidate";
  /** Model confidence normalized into the closed [0, 1] interval. */
  confidence: number;
  /** Raw entity text returned by the model, when present. */
  rawEntity: string;
  /** Raw attribute text returned by the model, when present. */
  rawAttribute: string;
  /** Preview path that produced the raw response. */
  path: ClaimExtractionPath;
}

/**
 * Observability path that produced one extracted claim key.
 */
export type ClaimExtractionPath = "model" | "json_retry" | "deterministic_repair";

/**
 * Best-effort claim-key extraction outcome.
 */
export interface ClaimExtractionResult {
  claimKey: string | null;
  confidence: number;
  rawEntity: string;
  rawAttribute: string;
  path: ClaimExtractionPath;
  compactedFrom?: string | null;
  compactionReason?: string | null;
  acceptanceRationale?: string | null;
}

/**
 * Structured routing outcome recorded for each ingest-time claim-extraction attempt.
 */
export type ClaimExtractionDiagnosticOutcome =
  | "accepted"
  | "no_claim"
  | "low_confidence_candidate"
  | "rejected_candidate"
  | "extraction_failure"
  | "ineligible_type";

/**
 * Diagnostic payload for accepted, reviewable, and unresolved claim-extraction decisions.
 */
export interface ClaimExtractionDiagnostic {
  outcome: ClaimExtractionDiagnosticOutcome;
  confidence: number | null;
  path: ClaimExtractionPath | null;
  warning: string | null;
  suggestedClaimKey: string | null;
  reviewable: boolean;
  supportEvidence: string[];
  rationale: string | null;
}

/**
 * Full ingest-time claim-extraction decision used by store and ingest flows.
 */
export interface ClaimExtractionDecision {
  result: ClaimExtractionResult | null;
  diagnostic: ClaimExtractionDiagnostic;
}

/** Applies extracted lifecycle metadata directly onto a store input for callers that precompute claim extraction before store. */
export function applyClaimExtractionResultToEntry(entry: StoreEntryInput, extracted: ClaimExtractionResult): void {
  const lifecycle = buildExtractedClaimKeyLifecycle(extracted);
  if (!lifecycle) {
    return;
  }

  applyClaimKeyLifecycle(entry, lifecycle);
}

/**
 * Previews the best validated claim-key suggestion without applying a confidence threshold.
 *
 * This is used by maintenance flows that need to distinguish between
 * high-confidence auto-apply and lower-confidence unresolved proposals.
 *
 * @param entry - Candidate entry content to classify.
 * @param llm - LLM port used for JSON classification.
 * @param config - Runtime extraction controls.
 * @param options - Optional hints plus warning sink for deterministic rejection reasons.
 * @returns Best validated claim metadata, or `null` when no safe suggestion exists.
 */
export async function previewClaimKeyExtraction(
  entry: { type: EntryType; subject: string; content: string },
  llm: LlmPort,
  config: ClaimExtractionConfig,
  options: {
    hints?: ClaimExtractionHints;
    onWarning?: (warning: string) => void;
    onPreviewOutcome?: (outcome: ClaimExtractionPreviewOutcome) => void;
  } = {},
): Promise<ClaimExtractionResult | null> {
  if (!config.enabled || !config.eligibleTypes.includes(entry.type)) {
    return null;
  }

  const normalizedHints = normalizeClaimExtractionHints(options.hints ?? {});
  let attempt: ClaimExtractionAttempt;

  try {
    attempt = await attemptClaimExtraction(entry, normalizedHints, llm);
  } catch (error) {
    const repaired = tryDeterministicClaimKeyRepair(entry, normalizedHints);
    if (repaired) {
      return repaired;
    }

    throw error;
  }

  if (attempt.response.no_claim === true) {
    options.onPreviewOutcome?.(buildPreviewOutcome("no_claim", attempt));
    return null;
  }

  const candidate = buildClaimExtractionCandidate(entry, attempt.response, normalizedHints, options.onWarning);
  if (candidate) {
    options.onPreviewOutcome?.({
      outcome: "candidate",
      confidence: candidate.confidence,
      rawEntity: candidate.rawEntity,
      rawAttribute: candidate.rawAttribute,
      path: attempt.path,
    });
    return {
      claimKey: candidate.claimKey,
      confidence: candidate.confidence,
      rawEntity: candidate.rawEntity,
      rawAttribute: candidate.rawAttribute,
      path: attempt.path,
      ...(candidate.compactedFrom
        ? {
            compactedFrom: candidate.compactedFrom,
            compactionReason: candidate.compactionReason,
          }
        : {}),
    };
  }

  options.onPreviewOutcome?.(buildPreviewOutcome("rejected_candidate", attempt));
  return tryDeterministicClaimKeyRepair(entry, normalizedHints);
}

/**
 * Extracts one normalized claim key for a durable entry when the slot is clear.
 *
 * @param entry - Candidate entry content to classify.
 * @param llm - LLM port used for JSON classification.
 * @param config - Runtime extraction controls.
 * @param options - Optional hints, support examples, plus warning sink for deterministic rejection reasons.
 * @returns Extracted claim metadata, or `null` when no safe claim key was found.
 */
export async function extractClaimKey(
  entry: { type: EntryType; subject: string; content: string },
  llm: LlmPort,
  config: ClaimExtractionConfig,
  options: {
    hints?: ClaimExtractionHints;
    onWarning?: (warning: string) => void;
    supportClaimKeys?: string[];
  } = {},
): Promise<ClaimExtractionResult | null> {
  const decision = await extractClaimKeyDecision(entry, llm, config, options);
  return decision.result;
}

/**
 * Evaluates one ingest-time claim-extraction attempt, including supported near-miss routing.
 *
 * @param entry - Candidate entry content to classify.
 * @param llm - LLM port used for JSON classification.
 * @param config - Runtime extraction controls.
 * @param options - Optional hints, support claim-key examples, and warning sink.
 * @returns Accepted claim key plus structured diagnostics for unresolved outcomes.
 */
export async function extractClaimKeyDecision(
  entry: { type: EntryType; subject: string; content: string; tags?: string[]; source_context?: string },
  llm: LlmPort,
  config: ClaimExtractionConfig,
  options: {
    hints?: ClaimExtractionHints;
    onWarning?: (warning: string) => void;
    supportClaimKeys?: string[];
  } = {},
): Promise<ClaimExtractionDecision> {
  if (!config.enabled || !config.eligibleTypes.includes(entry.type)) {
    return {
      result: null,
      diagnostic: {
        outcome: "ineligible_type",
        confidence: null,
        path: null,
        warning: null,
        suggestedClaimKey: null,
        reviewable: false,
        supportEvidence: [],
        rationale: "entry type is not eligible for claim-key extraction",
      },
    };
  }

  const normalizedHints = normalizeClaimExtractionHints(options.hints ?? {});
  let attempt: ClaimExtractionAttempt;

  try {
    attempt = await attemptClaimExtraction(entry, normalizedHints, llm);
  } catch (error) {
    const repaired = tryDeterministicClaimKeyRepair(entry, normalizedHints);
    if (repaired) {
      return {
        result: repaired,
        diagnostic: buildAcceptedDiagnostic(repaired, "deterministic possessive-slot repair recovered the missing claim key"),
      };
    }

    const warning = formatClaimExtractionError(error);
    options.onWarning?.(`Claim extraction failed for "${entry.subject}": ${warning}`);
    return {
      result: null,
      diagnostic: {
        outcome: "extraction_failure",
        confidence: null,
        path: null,
        warning,
        suggestedClaimKey: null,
        reviewable: false,
        supportEvidence: [],
        rationale: "claim extraction failed before a safe candidate could be produced",
      },
    };
  }

  if (attempt.response.no_claim === true) {
    return {
      result: null,
      diagnostic: {
        outcome: "no_claim",
        confidence: normalizeConfidence(attempt.response.confidence),
        path: attempt.path,
        warning: null,
        suggestedClaimKey: null,
        reviewable: false,
        supportEvidence: [],
        rationale: "model explicitly returned no_claim",
      },
    };
  }

  const warnings: string[] = [];
  const candidate = buildClaimExtractionCandidate(entry, attempt.response, normalizedHints, (warning) => {
    warnings.push(warning);
    options.onWarning?.(warning);
  });
  if (!candidate) {
    const repaired = tryDeterministicClaimKeyRepair(entry, normalizedHints);
    if (repaired) {
      return {
        result: repaired,
        diagnostic: buildAcceptedDiagnostic(repaired, "deterministic possessive-slot repair recovered the missing claim key"),
      };
    }

    return {
      result: null,
      diagnostic: {
        outcome: "rejected_candidate",
        confidence: normalizeConfidence(attempt.response.confidence),
        path: attempt.path,
        warning: warnings[0] ?? null,
        suggestedClaimKey: null,
        reviewable: false,
        supportEvidence: [],
        rationale: "model proposed a structurally unsafe or non-canonical claim key",
      },
    };
  }

  const result = toClaimExtractionResult(candidate, attempt.path);
  if (result.confidence >= config.confidenceThreshold) {
    return {
      result,
      diagnostic: buildAcceptedDiagnostic(result, result.confidence >= config.confidenceThreshold ? "candidate met the ingest confidence threshold" : null),
    };
  }

  const support = evaluateClaimKeySupport(
    {
      subject: entry.subject,
      content: entry.content,
      type: entry.type,
      tags: entry.tags,
      source_context: entry.source_context,
    },
    result.claimKey ?? "",
    buildClaimKeySupportSeedFromExamples(options.supportClaimKeys ?? []),
  );
  const compactness = evaluateClaimKeyCompactness(result.claimKey ?? "", {
    priorCompactedFrom: result.compactedFrom ?? null,
    priorCompactionReason: result.compactionReason ?? null,
  });
  const autoApplyThreshold =
    support.autoApplyClass !== null && compactness.compactedFrom
      ? COMPACTED_SUPPORTED_INGEST_AUTO_APPLY_THRESHOLD
      : support.autoApplyClass !== null
        ? SUPPORTED_INGEST_AUTO_APPLY_THRESHOLD
        : HIGH_CONFIDENCE_BACKFILL_THRESHOLD;
  const proposalThreshold = support.supportedProposal ? SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD : PROPOSAL_CONFIDENCE_THRESHOLD;

  if (compactness.claimKey !== result.claimKey) {
    result.claimKey = compactness.claimKey;
    result.compactedFrom = compactness.compactedFrom;
    result.compactionReason = compactness.compactionReason;
  }

  if (result.confidence >= autoApplyThreshold && compactness.compactEnoughForAutoApply) {
    result.acceptanceRationale =
      support.autoApplyClass !== null
        ? `accepted below the default threshold via ${describeSupportPromotionClass(support)}`
        : "accepted as a high-confidence preview";
    return {
      result,
      diagnostic: buildAcceptedDiagnostic(
        result,
        support.autoApplyClass !== null
          ? `supported near-miss candidate cleared the conservative auto-apply threshold via ${describeSupportPromotionClass(support)}`
          : `candidate cleared the conservative high-confidence threshold of ${autoApplyThreshold.toFixed(2)}`,
      ),
    };
  }

  const repaired = tryDeterministicClaimKeyRepair(entry, normalizedHints);
  if (repaired && (!result.claimKey || repaired.claimKey === result.claimKey)) {
    return {
      result: repaired,
      diagnostic: buildAcceptedDiagnostic(repaired, "deterministic possessive-slot repair recovered the missing claim key"),
    };
  }

  if (result.confidence >= proposalThreshold) {
    return {
      result: null,
      diagnostic: {
        outcome: "low_confidence_candidate",
        confidence: result.confidence,
        path: result.path,
        warning: warnings[0] ?? null,
        suggestedClaimKey: result.claimKey,
        reviewable: true,
        supportEvidence: support.supportEvidence,
        rationale:
          support.rationaleFragments.length > 0
            ? `candidate stayed below the auto-apply threshold but has structured support from ${support.rationaleFragments.join(", ")}`
            : `candidate stayed below the auto-apply threshold of ${autoApplyThreshold.toFixed(2)}`,
      },
    };
  }

  return {
    result: null,
    diagnostic: {
      outcome: "low_confidence_candidate",
      confidence: result.confidence,
      path: result.path,
      warning: warnings[0] ?? null,
      suggestedClaimKey: result.claimKey,
      reviewable: false,
      supportEvidence: support.supportEvidence,
      rationale: "candidate stayed below both the conservative auto-apply and review thresholds",
    },
  };
}

/**
 * Loads existing entity prefixes for claim-key extraction hinting.
 *
 * @param db - Database port used to read existing claim-key prefixes.
 * @returns Distinct active entity prefixes.
 */
export async function getEntityHints(db: DatabasePort): Promise<string[]> {
  return db.getDistinctClaimKeyPrefixes();
}

/**
 * Runs claim-key extraction on entry batches in-place before the store phase.
 *
 * Entries that already have a claim key are preserved and reused as same-batch hints.
 * Ineligible entries are skipped. Per-entry failures are swallowed so ingest can
 * continue without claim keys.
 *
 * @param results - Entry batches whose members may be stamped with `claim_key`.
 * @param ports - Claim-extraction LLM factory plus database access for hint loading.
 * @param config - Runtime extraction controls.
 * @param _concurrency - Reserved for interface compatibility. Batch extraction stays ordered so same-batch hints remain deterministic.
 * @param onWarning - Optional warning sink for deterministic rejection reasons.
 * @param onDiagnostic - Optional sink for structured per-entry routing diagnostics.
 */
export async function runBatchClaimExtraction(
  results: Array<{ entries: StoreEntryInput[] }>,
  ports: {
    createLlm: () => LlmPort;
    db: DatabasePort;
  },
  config: ClaimExtractionConfig,
  _concurrency = 10,
  onWarning?: (warning: string) => void,
  onDiagnostic?: (entry: StoreEntryInput, diagnostic: ClaimExtractionDiagnostic) => void,
): Promise<Map<StoreEntryInput, ClaimExtractionResult>> {
  if (!config.enabled) {
    return new Map();
  }

  const hintState = await loadClaimExtractionHintState(ports.db);
  const llm = ports.createLlm();
  const extractedEntries = new Map<StoreEntryInput, ClaimExtractionResult>();
  const diagnostics = new Map<StoreEntryInput, ClaimExtractionDiagnostic>();
  const retryEntries: StoreEntryInput[] = [];

  for (const result of results) {
    for (const entry of result.entries) {
      if (entry.claim_key) {
        recordClaimKeyHint(hintState, entry.claim_key);
        continue;
      }

      if (!config.eligibleTypes.includes(entry.type)) {
        diagnostics.set(entry, {
          outcome: "ineligible_type",
          confidence: null,
          path: null,
          warning: null,
          suggestedClaimKey: null,
          reviewable: false,
          supportEvidence: [],
          rationale: "entry type is not eligible for claim-key extraction",
        });
        continue;
      }

      const decision = await extractBatchClaimKeyDecision(entry, llm, config, hintState, onWarning);
      diagnostics.set(entry, decision.diagnostic);

      if (decision.result?.claimKey) {
        applyClaimExtractionResultToEntry(entry, decision.result);
        recordClaimKeyHint(hintState, decision.result.claimKey);
        extractedEntries.set(entry, decision.result);
        continue;
      }

      retryEntries.push(entry);
    }
  }

  if (retryEntries.length > 0 && extractedEntries.size > 0) {
    for (const entry of retryEntries) {
      if (entry.claim_key) {
        continue;
      }

      const decision = await extractBatchClaimKeyDecision(entry, llm, config, hintState, onWarning);
      diagnostics.set(entry, decision.diagnostic);

      if (!decision.result?.claimKey) {
        continue;
      }

      applyClaimExtractionResultToEntry(entry, decision.result);
      recordClaimKeyHint(hintState, decision.result.claimKey);
      extractedEntries.set(entry, decision.result);
    }
  }

  for (const result of results) {
    for (const entry of result.entries) {
      const diagnostic = diagnostics.get(entry);
      if (diagnostic) {
        onDiagnostic?.(entry, diagnostic);
      }
    }
  }

  return extractedEntries;
}

/**
 * Runs the shared claim-extraction decision logic for one batch entry using the
 * current mutable hint state. Unexpected failures are converted into structured
 * extraction-failure diagnostics so ingest can continue.
 *
 * @param entry - Store input currently being evaluated.
 * @param llm - Claim-extraction model port.
 * @param config - Runtime extraction controls.
 * @param hintState - Mutable same-batch claim-key hint state.
 * @param onWarning - Optional warning sink.
 * @returns Structured claim-extraction decision for the entry.
 */
async function extractBatchClaimKeyDecision(
  entry: StoreEntryInput,
  llm: LlmPort,
  config: ClaimExtractionConfig,
  hintState: ClaimExtractionHintState,
  onWarning?: (warning: string) => void,
): Promise<ClaimExtractionDecision> {
  try {
    return await extractClaimKeyDecision(
      {
        type: entry.type,
        subject: entry.subject,
        content: entry.content,
        tags: entry.tags,
        source_context: entry.source_context,
      },
      llm,
      config,
      {
        hints: buildEntryHints(hintState, entry),
        onWarning,
        supportClaimKeys: [...hintState.supportClaimKeys],
      },
    );
  } catch {
    return {
      result: null,
      diagnostic: {
        outcome: "extraction_failure",
        confidence: null,
        path: null,
        warning: "claim extraction failed unexpectedly",
        suggestedClaimKey: null,
        reviewable: false,
        supportEvidence: [],
        rationale: "claim extraction failed unexpectedly",
      },
    };
  }
}

/**
 * Builds the classifier system prompt for claim-key extraction.
 *
 * @param hints - Existing hints and metadata used to ground the namespace.
 * @param promptMode - Extraction prompt variant to use.
 * @returns Stable extraction instructions.
 */
function buildClaimExtractionSystemPrompt(hints: NormalizedClaimExtractionHints, promptMode: ClaimExtractionPromptMode): string {
  const metadataHints = [hints.userEntity ? `user_id=${hints.userEntity}` : null, hints.projectEntity ? `project=${hints.projectEntity}` : null].filter(
    (value): value is string => value !== null,
  );
  const groundingHints = [
    hints.tags.length > 0 ? `tags=${hints.tags.join(", ")}` : null,
    hints.sourceContext ? `source_context=${hints.sourceContext}` : null,
  ].filter((value): value is string => value !== null);

  const retryInstructions =
    promptMode === "json_retry"
      ? [
          "",
          "Your previous answer was invalid JSON.",
          "Reply with exactly one JSON object and nothing else.",
          "Do not use markdown fences, commentary, or trailing text.",
        ]
      : [];

  return [
    "You are a knowledge entry classifier. Extract one stable claim key for a durable knowledge entry.",
    "A claim key names the durable slot this entry updates: entity/attribute in lowercase snake_case.",
    "The goal is stable slot naming, not a paraphrase of the current value.",
    "",
    "Stability rules:",
    "- Prefer stable slot names over transient wording.",
    "- Choose attribute names that still make sense if the value changes.",
    "- Prefer short noun-like slot names over sentence-like attribute phrases.",
    "- When a candidate sounds like a rule or explanation sentence, compress it into the reusable slot it governs.",
    "- Prefer concrete entities over pronouns, deictic phrases, or self-referential placeholders.",
    "- Reuse an existing entity or full claim-key example when it clearly matches the same slot.",
    "- Stay domain-general. The same rules apply to people, devices, services, projects, places, organizations, products, datasets, policies, and preferences.",
    "- If the entry states a durable rule, default, workflow, guardrail, source-of-truth rule, architecture boundary, or process constraint plus rationale, extract the primary durable slot rather than the supporting rationale.",
    "- Do not return no_claim just because the entry explains why the rule exists. The durable policy or system slot is usually still the target.",
    "- Avoid full action clauses like requires_x_to_y, preserves_x_across_y, or x_precedes_y when a shorter stable slot such as trigger_condition, context_preservation, source_of_truth, or handoff_order would carry the same durable meaning.",
    "",
    "Return no_claim when:",
    "- The entry is narrative, multi-fact, or mostly a story about what happened.",
    "- The entry is an event or milestone without one continuing slot.",
    "- The entity is ambiguous or can only be named with a pronoun or vague placeholder.",
    "- The entry does not express one durable property, preference, decision, configuration, relationship, or other stable slot.",
    "- When unsure, prefer no_claim over inventing a weak key.",
    "",
    "Positive examples:",
    '- "Jim\'s timezone is America/Chicago." -> jim/timezone',
    '- "Jim prefers oat milk in coffee." -> jim/coffee_preference',
    '- "Pixel 8 is set to dark mode." -> pixel_8/theme_mode',
    '- "Postgres max_connections is 200." -> postgres/max_connections',
    '- "Agenr defaults to gpt-5.4-mini." -> agenr/default_model',
    '- "Mac mini updates should stay manual so debugging stays predictable." -> mac_mini/manual_update_policy',
    '- "Use the warehouse inventory sheet as the source of truth for stock counts." -> stock_counts/source_of_truth',
    '- "The repo workflow is defined by AGENTS.md, even when older notes disagree." -> repo_workflow/source_of_truth',
    '- "Agenr keeps pure logic in src/core and adapters outside it so future hosts can plug in cleanly." -> agenr/core_adapter_boundary',
    '- "The before-prompt-build hook only triggers after a real agent turn or message." -> before_prompt_build_hook/trigger_condition',
    '- "Durable memory preserves context across sessions." -> durable_memory/context_preservation',
    '- "SQLite in this environment supports window functions." -> sqlite/window_function_support',
    '- "Meeting-recorder transcripts need manual cleanup before durable ingest." -> meeting_recorder/transcript_cleanup_workflow',
    '- "Reflection synthesis can hallucinate when it summarizes from partial notes." -> reflection_synthesis/hallucination_risk',
    "",
    "Negative examples:",
    "- Bad: jim/america_chicago -> Good: jim/timezone",
    "- Bad: project_x/details -> Good: project_x/deploy_strategy",
    "- Bad: we/deployment_process -> Good: platform_team/deploy_strategy",
    "- Bad: jim/oat_milk -> Good: jim/coffee_preference",
    "- Bad: release_notes/because_rollbacks_are_hard -> Good: release_process/source_of_truth",
    "- Bad: openclaw/requires_real_agent_turn_or_message_to_trigger -> Good: openclaw/trigger_condition",
    "- Bad: session_continuity/durable_memory_preserves_context_across_sessions -> Good: session_continuity/context_preservation",
    "- Bad: incident_story/we_spent_two_hours_debugging -> Good: no_claim",
    "",
    "Field rules:",
    "- entity: the main concrete thing being described. It can be a person, device, service, product, organization, workflow area, or other durable system/process anchor.",
    "- attribute: the narrow stable slot on that entity. For policy/process entries, name the governing slot such as source_of_truth, default_mode, update_policy, architecture_boundary, deploy_strategy, or escalation_workflow.",
    "- Confidence: 0.0 to 1.0. Use 0.9+ only when the slot is unambiguous and durable.",
    "",
    `Known entity hints: ${hints.entityHints.length > 0 ? hints.entityHints.join(", ") : "(none)"}`,
    `Known claim-key examples: ${hints.claimKeyExamples.length > 0 ? hints.claimKeyExamples.join(", ") : "(none)"}`,
    `Current entry metadata hints: ${metadataHints.length > 0 ? metadataHints.join(", ") : "(none)"}`,
    `Current entry grounding clues: ${groundingHints.length > 0 ? groundingHints.join(", ") : "(none)"}`,
    'If project metadata is present, it may resolve phrases like "the project" when that mapping is obvious.',
    'If user metadata is present, it may resolve phrases like "the user", "I", or "me" when that mapping is obvious.',
    "Tags and source_context are local grounding clues, not proof. Use them to pick the right durable slot only when the entry content already supports that slot.",
    ...retryInstructions,
    "",
    'Respond with JSON: { "entity": string, "attribute": string, "confidence": number, "no_claim"?: boolean }',
  ].join("\n");
}

/**
 * Builds the user prompt for one extraction request.
 *
 * @param entry - Candidate entry content to classify.
 * @returns User-visible extraction payload.
 */
function buildClaimExtractionUserPrompt(entry: { type: EntryType; subject: string; content: string }): string {
  return [`Entry type: ${entry.type}`, `Subject: ${entry.subject}`, `Content: ${entry.content}`].join("\n");
}

/**
 * Attempts claim-key extraction, retrying once when the first response is malformed JSON.
 *
 * @param entry - Candidate entry content to classify.
 * @param hints - Normalized hints used to build the prompt.
 * @param llm - LLM port used for JSON classification.
 * @returns Successful model output plus the path that produced it.
 */
async function attemptClaimExtraction(
  entry: { type: EntryType; subject: string; content: string },
  hints: NormalizedClaimExtractionHints,
  llm: LlmPort,
): Promise<ClaimExtractionAttempt> {
  const userPrompt = buildClaimExtractionUserPrompt(entry);

  try {
    return {
      path: "model",
      response: await llm.completeJson<ClaimExtractionResponse>(buildClaimExtractionSystemPrompt(hints, "standard"), userPrompt),
    };
  } catch (error) {
    if (!isMalformedJsonError(error)) {
      throw error;
    }
  }

  return {
    path: "json_retry",
    response: await llm.completeJson<ClaimExtractionResponse>(buildClaimExtractionSystemPrompt(hints, "json_retry"), userPrompt),
  };
}

/**
 * Converts one raw model response into a normalized candidate before thresholding.
 *
 * @param entry - Candidate entry content being classified.
 * @param response - Raw model JSON payload.
 * @param hints - Normalized hints used for entity resolution.
 * @param onWarning - Optional warning sink for deterministic rejection reasons.
 * @returns Validated candidate when the model proposed a structurally safe key.
 */
function buildClaimExtractionCandidate(
  entry: { subject: string },
  response: ClaimExtractionResponse,
  hints: NormalizedClaimExtractionHints,
  onWarning?: (warning: string) => void,
): ClaimExtractionCandidate | null {
  const confidence = normalizeConfidence(response.confidence);
  const rawEntity = typeof response.entity === "string" ? response.entity.trim() : "";
  const rawAttribute = typeof response.attribute === "string" ? response.attribute.trim() : "";
  const entity = normalizeEntity(rawEntity, hints);
  const attribute = normalizeClaimKeySegment(rawAttribute);
  const normalizedClaimKey = normalizeClaimKey(`${entity}/${attribute}`);
  if (!normalizedClaimKey.ok) {
    onWarning?.(`Claim extraction dropped claim key for "${entry.subject}": ${describeClaimKeyNormalizationFailure(normalizedClaimKey.reason)}.`);
    return null;
  }

  const compactedClaimKey = compactClaimKey(normalizedClaimKey.value.claimKey);
  if (!compactedClaimKey) {
    onWarning?.(`Claim extraction dropped claim key for "${entry.subject}": claim key could not be compacted safely.`);
    return null;
  }

  const validatedClaimKey = validateExtractedClaimKey(compactedClaimKey);
  if (!validatedClaimKey.ok) {
    onWarning?.(
      `Claim extraction rejected "${validatedClaimKey.value.claimKey}" for "${entry.subject}": ${describeExtractedClaimKeyRejection(validatedClaimKey.reason, validatedClaimKey.value)}.`,
    );
    return null;
  }

  return {
    claimKey: validatedClaimKey.value.claimKey,
    confidence,
    rawEntity,
    rawAttribute,
    compactedFrom: compactedClaimKey.compactedFrom,
    compactionReason: compactedClaimKey.reason,
  };
}

/**
 * Converts one normalized candidate plus path into the public extraction-result shape.
 *
 * @param candidate - Validated candidate returned by the model path.
 * @param path - Preview path that produced the candidate.
 * @returns Public extraction-result payload.
 */
function toClaimExtractionResult(candidate: ClaimExtractionCandidate, path: ClaimExtractionPath): ClaimExtractionResult {
  return {
    claimKey: candidate.claimKey,
    confidence: candidate.confidence,
    rawEntity: candidate.rawEntity,
    rawAttribute: candidate.rawAttribute,
    path,
    ...(candidate.compactedFrom
      ? {
          compactedFrom: candidate.compactedFrom,
          compactionReason: candidate.compactionReason,
        }
      : {}),
  };
}

/**
 * Builds the accepted diagnostic payload paired with a successful extraction result.
 *
 * @param result - Accepted extraction result.
 * @param rationale - Optional acceptance rationale.
 * @returns Accepted diagnostic payload.
 */
function buildAcceptedDiagnostic(result: ClaimExtractionResult, rationale: string | null): ClaimExtractionDiagnostic {
  return {
    outcome: "accepted",
    confidence: result.confidence,
    path: result.path,
    warning: null,
    suggestedClaimKey: result.claimKey,
    reviewable: false,
    supportEvidence: [],
    rationale,
  };
}

/**
 * Converts one thrown extraction error into a stable diagnostic string.
 *
 * @param error - Unknown thrown value.
 * @returns Diagnostic-safe error summary.
 */
function formatClaimExtractionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Formats the auto-promotion support class used to accept a near-miss candidate.
 *
 * @param support - Support evaluation for the candidate.
 * @returns Human-readable support class summary.
 */
function describeSupportPromotionClass(support: ClaimKeySupportEvaluation): string {
  switch (support.autoApplyClass) {
    case "trusted_exact_reuse_grounded":
      return "trusted exact-key reuse with local grounding";
    case "trusted_family_template_grounded":
      return "trusted family reuse plus grounded template support";
    case "trusted_family_stable_slot":
      return "trusted family reuse plus a stable compact slot";
    case "trusted_family_grounded_alignment":
      return "trusted family reuse plus grounded dual lexical alignment";
    default:
      return "structural support";
  }
}

/**
 * Tries one deterministic possessive-slot repair for simple safe cases.
 *
 * @param entry - Candidate entry content to inspect.
 * @param hints - Normalized hints used for entity resolution.
 * @returns Repaired claim key when a low-risk pattern is present.
 */
function tryDeterministicClaimKeyRepair(entry: { subject: string; content: string }, hints: NormalizedClaimExtractionHints): ClaimExtractionResult | null {
  const repaired = parsePossessiveClaim(entry.subject) ?? parsePossessiveStatement(entry.content);
  if (!repaired) {
    return null;
  }

  const attribute = normalizeClaimKeySegment(repaired.attribute);
  if (!looksLikeDeterministicAttribute(attribute)) {
    return null;
  }

  const entity = normalizeEntity(repaired.entity, hints);
  const normalizedClaimKey = normalizeClaimKey(`${entity}/${attribute}`);
  if (!normalizedClaimKey.ok) {
    return null;
  }

  const validatedClaimKey = validateExtractedClaimKey(normalizedClaimKey.value);
  if (!validatedClaimKey.ok) {
    return null;
  }

  return {
    claimKey: validatedClaimKey.value.claimKey,
    confidence: DEFAULT_REPAIR_CONFIDENCE,
    rawEntity: repaired.entity,
    rawAttribute: repaired.attribute,
    path: "deterministic_repair",
  };
}

/**
 * Loads initial bounded hint state from the database port.
 *
 * @param db - Database port used to read persisted hint examples.
 * @returns Ordered hint state for batch-local mutation.
 */
async function loadClaimExtractionHintState(db: DatabasePort): Promise<ClaimExtractionHintState> {
  const [entityHintResult, promptClaimKeyExampleResult, supportClaimKeyExampleResult] = await Promise.allSettled([
    getEntityHints(db),
    getClaimKeyExamples(db, MAX_CLAIM_KEY_EXAMPLES),
    getClaimKeyExamples(db, MAX_SUPPORT_CLAIM_KEY_EXAMPLES),
  ]);

  return createHintState({
    entityHints: entityHintResult.status === "fulfilled" ? entityHintResult.value : [],
    claimKeyExamples: promptClaimKeyExampleResult.status === "fulfilled" ? promptClaimKeyExampleResult.value : [],
    supportClaimKeys: supportClaimKeyExampleResult.status === "fulfilled" ? supportClaimKeyExampleResult.value : [],
  });
}

/**
 * Loads full claim-key examples when the database adapter supports them.
 *
 * @param db - Database port used to read persisted hint examples.
 * @returns Bounded full claim-key examples, or an empty list when unsupported.
 */
async function getClaimKeyExamples(db: DatabasePort, limit: number): Promise<string[]> {
  if (typeof db.getClaimKeyExamples !== "function") {
    return [];
  }

  return db.getClaimKeyExamples(limit);
}

/**
 * Creates normalized ordered hint state from raw entity and claim-key inputs.
 *
 * @param input - Raw hint inputs gathered from the database.
 * @returns Mutable ordered hint state with stable caps applied.
 */
function createHintState(input: { entityHints?: string[]; claimKeyExamples?: string[]; supportClaimKeys?: string[] }): ClaimExtractionHintState {
  const claimKeyExamples = normalizeClaimKeyExamples(input.claimKeyExamples ?? []);
  const supportClaimKeys = normalizeSupportClaimKeys(input.supportClaimKeys ?? []);
  const entityHints = limitUnique(
    [
      ...normalizeEntityHints(input.entityHints ?? []),
      ...supportClaimKeys.flatMap((claimKey) => {
        const normalizedClaimKey = normalizeClaimKey(claimKey);
        return normalizedClaimKey.ok ? [normalizedClaimKey.value.entity] : [];
      }),
    ],
    MAX_ENTITY_HINTS,
  );

  return {
    entityHints,
    claimKeyExamples,
    supportClaimKeys,
  };
}

/**
 * Builds per-entry hints from the current batch state plus entry metadata.
 *
 * @param state - Mutable batch hint state.
 * @param entry - Current entry whose metadata may help entity resolution.
 * @returns Hint bundle passed into one extraction request.
 */
function buildEntryHints(
  state: ClaimExtractionHintState,
  entry: Pick<StoreEntryInput, "project" | "user_id" | "tags" | "source_context">,
): ClaimExtractionHints {
  return {
    entityHints: [...state.entityHints],
    claimKeyExamples: [...state.claimKeyExamples],
    userId: entry.user_id,
    project: entry.project,
    tags: entry.tags,
    sourceContext: entry.source_context,
  };
}

/**
 * Records one successful claim key so later entries in the same batch can reuse it.
 *
 * @param state - Mutable batch hint state.
 * @param claimKey - Canonical or near-canonical claim key to record.
 */
function recordClaimKeyHint(state: ClaimExtractionHintState, claimKey: string): void {
  const normalizedClaimKey = normalizeClaimKey(claimKey);
  if (!normalizedClaimKey.ok) {
    return;
  }

  state.claimKeyExamples = prependUnique(state.claimKeyExamples, normalizedClaimKey.value.claimKey, MAX_CLAIM_KEY_EXAMPLES);
  state.supportClaimKeys = prependUnique(state.supportClaimKeys, normalizedClaimKey.value.claimKey, MAX_SUPPORT_CLAIM_KEY_EXAMPLES);
  state.entityHints = prependUnique(state.entityHints, normalizedClaimKey.value.entity, MAX_ENTITY_HINTS);
}

/**
 * Normalizes a hint bundle and derives safe metadata entities.
 *
 * @param hints - Raw hint input from the caller.
 * @returns Normalized hints ready for prompt building and repair logic.
 */
function normalizeClaimExtractionHints(hints: ClaimExtractionHints): NormalizedClaimExtractionHints {
  const claimKeyExamples = normalizeClaimKeyExamples(hints.claimKeyExamples ?? []);
  return {
    entityHints: limitUnique(
      [
        ...normalizeEntityHints(hints.entityHints ?? []),
        ...claimKeyExamples.flatMap((claimKey) => {
          const normalizedClaimKey = normalizeClaimKey(claimKey);
          return normalizedClaimKey.ok ? [normalizedClaimKey.value.entity] : [];
        }),
      ],
      MAX_ENTITY_HINTS,
    ),
    claimKeyExamples,
    userEntity: normalizeMetadataEntity(hints.userId),
    projectEntity: normalizeMetadataEntity(hints.project),
    tags: normalizeHintTags(hints.tags ?? []),
    sourceContext: normalizeSourceContextHint(hints.sourceContext),
  };
}

/**
 * Builds structured preview metadata from one raw claim-extraction attempt.
 *
 * @param outcome - Final preview outcome classification.
 * @param attempt - Successful raw model response plus preview path.
 * @returns Structured preview metadata for diagnostics.
 */
function buildPreviewOutcome(outcome: ClaimExtractionPreviewOutcome["outcome"], attempt: ClaimExtractionAttempt): ClaimExtractionPreviewOutcome {
  return {
    outcome,
    confidence: normalizeConfidence(attempt.response.confidence),
    rawEntity: typeof attempt.response.entity === "string" ? attempt.response.entity.trim() : "",
    rawAttribute: typeof attempt.response.attribute === "string" ? attempt.response.attribute.trim() : "",
    path: attempt.path,
  };
}

/**
 * Normalizes a model-provided confidence into the closed [0, 1] range.
 *
 * @param value - Raw confidence value from the model response.
 * @returns Confidence in the supported range.
 */
function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * Resolves common self-referential entity names to a concrete entity from metadata
 * or the current hint set when there is one low-risk mapping.
 *
 * @param value - Raw entity string returned by the model or repair logic.
 * @param hints - Normalized hints used for alias resolution.
 * @returns Safe claim-key entity segment.
 */
function normalizeEntity(value: string, hints: NormalizedClaimExtractionHints): string {
  const normalizedValue = normalizeClaimKeySegment(value);
  if (normalizedValue.length === 0) {
    return "";
  }

  if (!SELF_REFERENTIAL_ENTITIES.has(normalizedValue)) {
    return normalizedValue;
  }

  if (USER_REFERENTIAL_ENTITIES.has(normalizedValue) && hints.userEntity) {
    return hints.userEntity;
  }

  if (PROJECT_REFERENTIAL_ENTITIES.has(normalizedValue) && hints.projectEntity) {
    return hints.projectEntity;
  }

  const concreteCandidates = limitUnique(
    [hints.projectEntity, hints.userEntity, ...hints.entityHints].filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    ),
    MAX_ENTITY_HINTS,
  );
  if (concreteCandidates.length === 1) {
    return concreteCandidates[0] ?? normalizedValue;
  }

  if (hints.entityHints.length === 1) {
    return hints.entityHints[0] ?? normalizedValue;
  }

  return normalizedValue;
}

/**
 * Normalizes free-form entity hints into safe claim-key entity segments.
 *
 * @param entityHints - Raw entity hint strings.
 * @returns Canonical entity hints with generic self-references removed.
 */
function normalizeEntityHints(entityHints: string[]): string[] {
  return limitUnique(
    entityHints
      .map((entityHint) => normalizeClaimKeySegment(entityHint))
      .filter((entityHint) => entityHint.length > 0 && !SELF_REFERENTIAL_ENTITIES.has(entityHint)),
    MAX_ENTITY_HINTS,
  );
}

/**
 * Normalizes full claim-key examples into canonical stable strings.
 *
 * @param claimKeyExamples - Raw full claim-key examples.
 * @returns Canonical full claim keys capped for prompt stability.
 */
function normalizeClaimKeyExamples(claimKeyExamples: string[]): string[] {
  return limitUnique(
    claimKeyExamples.flatMap((claimKeyExample) => {
      const normalizedClaimKey = normalizeClaimKey(claimKeyExample);
      return normalizedClaimKey.ok ? [normalizedClaimKey.value.claimKey] : [];
    }),
    MAX_CLAIM_KEY_EXAMPLES,
  );
}

/**
 * Normalizes the larger support-example pool used for near-miss routing.
 *
 * @param claimKeys - Raw canonical or near-canonical claim-key examples.
 * @returns Canonical support examples capped for evaluation stability.
 */
function normalizeSupportClaimKeys(claimKeys: string[]): string[] {
  return limitUnique(
    claimKeys.flatMap((claimKey) => {
      const normalizedClaimKey = normalizeClaimKey(claimKey);
      return normalizedClaimKey.ok ? [normalizedClaimKey.value.claimKey] : [];
    }),
    MAX_SUPPORT_CLAIM_KEY_EXAMPLES,
  );
}

/**
 * Normalizes one metadata identifier into a safe reusable entity when possible.
 *
 * @param value - Raw metadata identifier.
 * @returns Canonical reusable entity or `undefined` when the metadata is too weak.
 */
function normalizeMetadataEntity(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeClaimKeySegment(value);
  if (normalized.length === 0 || SELF_REFERENTIAL_ENTITIES.has(normalized) || !/[a-z]/u.test(normalized)) {
    return undefined;
  }

  return normalized;
}

/**
 * Normalizes local grounding tags used for prompt shaping.
 *
 * @param tags - Raw entry tags.
 * @returns Canonical bounded tag hints.
 */
function normalizeHintTags(tags: string[]): string[] {
  return limitUnique(
    tags.map((tag) => normalizeClaimKeySegment(tag)).filter((tag) => tag.length > 0),
    8,
  );
}

/**
 * Normalizes one source-context hint into a compact prompt-safe clue.
 *
 * @param value - Raw source-context string.
 * @returns Trimmed provenance hint, or `undefined` when absent.
 */
function normalizeSourceContextHint(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 157).trimEnd()}...`;
}

/**
 * Returns whether one error most likely came from JSON parsing.
 *
 * @param error - Unknown thrown value.
 * @returns `true` when the error looks like malformed JSON output.
 */
function isMalformedJsonError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /json|unexpected token|unexpected end|unexpected non-whitespace|unterminated|position \d+/iu.test(message);
}

/**
 * Parses a simple possessive subject like `Jim's timezone`.
 *
 * @param subject - Subject text to inspect.
 * @returns Entity plus attribute when a safe possessive pattern is present.
 */
function parsePossessiveClaim(subject: string): { entity: string; attribute: string } | null {
  const match = /^\s*(?<entity>[^.!?\n]+?)[’']s\s+(?<attribute>[^.!?\n]+?)\s*$/iu.exec(subject);
  if (!match?.groups) {
    return null;
  }

  return {
    entity: stripTrailingPunctuation(match.groups.entity),
    attribute: stripTrailingPunctuation(match.groups.attribute),
  };
}

/**
 * Parses a simple possessive statement like `Jim's timezone is America/Chicago`.
 *
 * @param content - Content text to inspect.
 * @returns Entity plus attribute when a safe possessive statement is present.
 */
function parsePossessiveStatement(content: string): { entity: string; attribute: string } | null {
  const match = /^\s*(?<entity>[^.!?\n]+?)[’']s\s+(?<attribute>[^.!?\n]+?)\s+(?:is|are|was|were)\b/iu.exec(content);
  if (!match?.groups) {
    return null;
  }

  return {
    entity: stripTrailingPunctuation(match.groups.entity),
    attribute: stripTrailingPunctuation(match.groups.attribute),
  };
}

/**
 * Strips trailing punctuation that should not become part of a claim-key segment.
 *
 * @param value - Raw phrase extracted from subject or content.
 * @returns Cleaned phrase.
 */
function stripTrailingPunctuation(value: string): string {
  return value
    .trim()
    .replace(/[\s"'“”‘’.,:;!?]+$/gu, "")
    .trim();
}

/**
 * Returns whether one repaired attribute is simple enough to trust deterministically.
 *
 * @param attribute - Canonicalized attribute string.
 * @returns `true` when the attribute uses a known slot-like head noun.
 */
function looksLikeDeterministicAttribute(attribute: string): boolean {
  const parts = attribute.split("_").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 4) {
    return false;
  }

  const head = parts[parts.length - 1];
  return typeof head === "string" && DETERMINISTIC_ATTRIBUTE_HEADS.has(head);
}

/**
 * Prepends one value to an ordered unique list while enforcing a hard cap.
 *
 * @param values - Existing ordered values.
 * @param value - Value to insert at the front.
 * @param limit - Maximum number of values to keep.
 * @returns New ordered unique list.
 */
function prependUnique(values: string[], value: string, limit: number): string[] {
  return limitUnique([value, ...values], limit);
}

/**
 * Deduplicates one string list while preserving order and enforcing a cap.
 *
 * @param values - Candidate ordered values.
 * @param limit - Maximum number of values to keep.
 * @returns Ordered unique values trimmed to the requested cap.
 */
function limitUnique(values: string[], limit: number): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0))).slice(0, limit);
}
