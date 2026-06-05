import { randomUUID } from "node:crypto";

import type { EmbeddingPort } from "../../core/ports.js";
import { composeEmbeddingText } from "../../core/store/embedding-text.js";
import { computeContentHash } from "../../core/store/hashing.js";
import { validateSupersessionRules } from "../../core/supersession.js";
import type { DreamCandidate, DreamTemporalizeSummary } from "../../core/dreaming/types.js";
import type { Durable } from "../../core/types.js";
import { throwIfAborted } from "./abort.js";
import { buildDurableFromCandidate } from "./extract.js";
import type { DreamPort } from "./ports.js";

/**
 * Options accepted by the temporalize stage.
 */
export interface DreamTemporalizeOptions {
  runId: string;
  candidates: DreamCandidate[];
  apply: boolean;
  now(): Date;
  signal?: AbortSignal;
}

/**
 * Dependencies required by the temporalize stage.
 */
export interface DreamTemporalizeDeps {
  port: DreamPort;
  embedding: EmbeddingPort;
}

/**
 * Aggregate outcome of one temporalize stage run.
 */
export interface DreamTemporalizeResult {
  summary: DreamTemporalizeSummary;
}

/**
 * Applies calendar- and event-driven revision to refine candidates.
 *
 * Each `refines` candidate becomes a successor durable that inherits the
 * predecessor's canonical claim key. The stage never edits content in place:
 * it inserts the successor, closes the predecessor's valid-time window at the
 * revision instant, and links the predecessor to the successor through
 * `superseded_by`. Point-in-time recall before the revision still returns the
 * predecessor; current-state recall returns the successor.
 *
 * @param options - Run identifier, refine candidates, apply flag, and clock.
 * @param deps - Persistence port used for reads, inserts, and supersession.
 * @returns Revision counters describing identified, applied, and skipped work.
 */
export async function runTemporalizeStage(options: DreamTemporalizeOptions, deps: DreamTemporalizeDeps): Promise<DreamTemporalizeResult> {
  const refineCandidates = options.candidates.filter(
    (candidate): candidate is DreamCandidate & { refinesDurableId: string } => candidate.disposition === "refines" && candidate.refinesDurableId !== null,
  );

  let revisionsIdentified = 0;
  let revisionsApplied = 0;
  let revisionsSkipped = 0;

  for (const candidate of refineCandidates) {
    throwIfAborted(options.signal);

    const predecessor = await deps.port.getDurable(candidate.refinesDurableId);
    if (!predecessor) {
      // The predecessor was retired or superseded between extract and temporalize.
      revisionsSkipped += 1;
      continue;
    }

    const rules = validateSupersessionRules({ type: predecessor.type, expiry: predecessor.expiry }, { type: candidate.type, expiry: candidate.expiry });
    if (!rules.ok) {
      revisionsSkipped += 1;
      continue;
    }

    revisionsIdentified += 1;
    if (!options.apply) {
      continue;
    }

    await applyRevision(candidate, predecessor, options, deps);
    revisionsApplied += 1;
  }

  return {
    summary: {
      revisionsIdentified,
      revisionsApplied,
      revisionsSkipped,
    },
  };
}

/**
 * Writes one supersession revision: insert the embedded successor, close the
 * predecessor window, link supersession, and record the audit action.
 *
 * The successor content is embedded before the write so the revised belief is
 * recallable by vector search. All writes run inside one transaction so a
 * partial failure can never leave the successor inserted without the predecessor
 * being superseded (or vice versa).
 */
async function applyRevision(
  candidate: DreamCandidate & { refinesDurableId: string },
  predecessor: Durable,
  options: DreamTemporalizeOptions,
  deps: DreamTemporalizeDeps,
): Promise<void> {
  const nowIso = options.now().toISOString();
  const successorId = randomUUID();
  const successor = buildDurableFromCandidate(candidate, {
    id: successorId,
    claimKeySource: "dreaming_temporalize",
    claimKeyStatus: predecessor.claim_key_status ?? "tentative",
    claimKeyConfidence: predecessor.claim_key_confidence ?? 0.6,
    claimKeyRationale: `Temporal revision superseding durable ${predecessor.id} from episode evidence.`,
    claimKeyOverride: predecessor.claim_key ?? candidate.claimKey,
    createdAt: nowIso,
    validFrom: nowIso,
  });
  // The successor inherits the family expiry so revision never widens durability.
  successor.expiry = predecessor.expiry;

  const contentHash = successor.content_hash ?? computeContentHash(successor.content);
  const [successorEmbedding = []] = await deps.embedding.embed([composeEmbeddingText(successor)]);

  await deps.port.withTransaction(async (tx) => {
    await tx.insertDurable(successor, successorEmbedding, contentHash);

    // Close the predecessor's validity window before it leaves the active set so
    // point-in-time recall before the revision still surfaces the old belief.
    if (canCloseValidityWindow(predecessor.valid_from, nowIso)) {
      await tx.updateDurable(predecessor.id, { valid_to: nowIso });
    }

    await tx.supersedeDurable(predecessor.id, successorId, "update", "Temporal revision from dreaming evidence.");

    await tx.logRunAction({
      id: randomUUID(),
      runId: options.runId,
      actionType: "supersede_durable",
      durableIds: [predecessor.id, successorId],
      reasoning: `Superseded durable ${predecessor.id} with temporal revision ${successorId}.`,
      recallDelta: null,
      details: {
        claim_key: successor.claim_key ?? null,
        predecessor_id: predecessor.id,
        successor_id: successorId,
        valid_to: nowIso,
      },
      createdAt: nowIso,
    });
  });
}

/** Decides whether closing the predecessor window keeps a strictly ordered range. */
function canCloseValidityWindow(validFrom: string | undefined, nowIso: string): boolean {
  if (!validFrom) {
    return true;
  }

  const fromMs = Date.parse(validFrom);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(fromMs) || Number.isNaN(nowMs)) {
    return true;
  }

  return fromMs < nowMs;
}
