import { createHash } from "node:crypto";

import type { DatabasePort, EmbeddingPort } from "../../core/ports.js";
import { storeDurablesDetailed, type StoreDurableDetail } from "../../core/store/pipeline.js";
import type { StoreDurableInput } from "../../core/types.js";
import type { ProcedureProposalRepository } from "../procedures/proposals/repository.js";
import { isCloseManagedStatus } from "./constants.js";
import type { WorkingSetRecord } from "./records.js";
import { isWorkingSetWriteFailure, type WorkingMemoryRepository, type WorkingSetWriteFailure } from "./repository.js";
import type { CandidateProvenance, WorkingCandidate, WorkingDurableCandidate, WorkingSnapshot } from "./snapshot.js";

/** Durable kind used when a semantic candidate carries no suggested kind. */
const DEFAULT_SEMANTIC_CANDIDATE_KIND = "fact" as const;

/** Ports required by the working-set consolidation job. */
export interface WorkingSetConsolidationDeps {
  /** Working-memory persistence port. */
  workingMemory: WorkingMemoryRepository;
  /** Durable database port used by the claim-key-aware store pipeline. */
  db: DatabasePort;
  /** Embedding port used by the store pipeline. */
  embedding: EmbeddingPort;
  /** Procedure-proposal persistence port. */
  procedureProposals: ProcedureProposalRepository;
  /** Optional warning sink for non-fatal store pipeline warnings. */
  onWarning?: (warning: string) => void;
}

/** Stable reasons one consolidation pass can fail before any write. */
export type WorkingSetConsolidationFailureReason = "not_found" | "not_closed" | "revision_conflict";

/** Outcome recorded for one semantic candidate. */
export interface SemanticCandidateOutcome {
  /** Candidate discriminator. */
  kind: "semantic";
  /** Candidate subject. */
  subject: string;
  /** Final promotion status persisted on the candidate. */
  promotionStatus: "promoted" | "rejected";
  /** Store pipeline result for the candidate. */
  result: "stored" | "duplicate" | "rejected";
  /** Persisted durable id when the candidate was stored. */
  durableId?: string;
}

/** Outcome recorded for one procedural candidate. */
export interface ProceduralCandidateOutcome {
  /** Candidate discriminator. */
  kind: "procedural";
  /** Candidate subject. */
  subject: string;
  /** Final promotion status persisted on the candidate. */
  promotionStatus: "promoted" | "rejected";
  /** Proposal result for the candidate. */
  result: "proposal_created" | "proposal_exists" | "rejected";
  /** Reviewable proposal id when one exists. */
  proposalId?: string;
}

/** Per-candidate outcome emitted by one consolidation pass. */
export type WorkingSetCandidateOutcome = SemanticCandidateOutcome | ProceduralCandidateOutcome;

/** Result of one working-set consolidation pass. */
export type RunWorkingSetConsolidationResult =
  | {
      ok: true;
      /** True when at least one candidate status changed and was persisted. */
      changed: boolean;
      /** Per-candidate outcomes in snapshot order. */
      outcomes: WorkingSetCandidateOutcome[];
      /** Working set after the bookkeeping write, or the loaded set when nothing changed. */
      workingSet: WorkingSetRecord;
    }
  | { ok: false; reason: WorkingSetConsolidationFailureReason };

/**
 * Promotes pending semantic and procedural candidates on one closed working set.
 *
 * Semantic candidates flow through the claim-key-aware durable store pipeline
 * with provenance back to the working set and its evidence event sequences.
 * Procedural candidates become reviewable procedure proposals. Episodic
 * candidates stay owned by the episode promotion path.
 *
 * The pass is idempotent: non-pending candidates are skipped, re-stored
 * semantic content dedupes by content hash, and procedural proposals dedupe
 * by candidate fingerprint. Outcomes are persisted with one bookkeeping write
 * that flips candidate statuses and appends a `consolidated` ledger event.
 *
 * @param deps - Working-memory, durable store, embedding, and proposal ports.
 * @param input - Closed working-set id and timestamp.
 * @returns Per-candidate outcomes, or a stable failure reason.
 */
export async function runWorkingSetConsolidation(
  deps: WorkingSetConsolidationDeps,
  input: { workingSetId: string; now: string },
): Promise<RunWorkingSetConsolidationResult> {
  const workingSet = await deps.workingMemory.getWorkingSet(input.workingSetId);
  if (!workingSet) {
    return { ok: false, reason: "not_found" };
  }

  if (!isCloseManagedStatus(workingSet.status)) {
    return { ok: false, reason: "not_closed" };
  }

  const candidates = workingSet.snapshot.candidates ?? [];
  const pending = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry): entry is { candidate: WorkingDurableCandidate; index: number } => isPendingDurableCandidate(entry.candidate));
  if (pending.length === 0) {
    return { ok: true, changed: false, outcomes: [], workingSet };
  }

  const outcomesByIndex = new Map<number, WorkingSetCandidateOutcome>();

  const semantic = pending.filter((entry) => entry.candidate.kind === "semantic");
  if (semantic.length > 0) {
    const semanticOutcomes = await promoteSemanticCandidates(deps, workingSet, semantic);
    for (const [index, outcome] of semanticOutcomes) {
      outcomesByIndex.set(index, outcome);
    }
  }

  const procedural = pending.filter((entry) => entry.candidate.kind === "procedural");
  for (const entry of procedural) {
    outcomesByIndex.set(entry.index, await promoteProceduralCandidate(deps, workingSet, entry.candidate, input.now));
  }

  const nextCandidates = candidates.map((candidate, index) => {
    const outcome = outcomesByIndex.get(index);
    if (!outcome) {
      return candidate;
    }

    return { ...candidate, promotionStatus: outcome.promotionStatus };
  });
  const nextSnapshot: WorkingSnapshot = { ...workingSet.snapshot, candidates: nextCandidates };
  const outcomes = [...outcomesByIndex.entries()].sort(([a], [b]) => a - b).map(([, outcome]) => outcome);

  const writeResult = await deps.workingMemory.recordCandidateConsolidation({
    workingSetId: workingSet.id,
    expectedRevision: workingSet.revision,
    snapshot: nextSnapshot,
    auditEvent: {
      payload: { outcomes },
      actor: "system",
      source: "consolidation_job",
    },
    now: input.now,
  });
  if (isWorkingSetWriteFailure(writeResult)) {
    return { ok: false, reason: mapWriteFailureReason(writeResult) };
  }

  return { ok: true, changed: true, outcomes, workingSet: writeResult.workingSet };
}

/** Returns true for pending semantic or procedural candidates. */
function isPendingDurableCandidate(candidate: WorkingCandidate): candidate is WorkingDurableCandidate {
  return (candidate.kind === "semantic" || candidate.kind === "procedural") && candidate.promotionStatus === "pending";
}

/** Promotes pending semantic candidates through the durable store pipeline. */
async function promoteSemanticCandidates(
  deps: WorkingSetConsolidationDeps,
  workingSet: WorkingSetRecord,
  entries: Array<{ candidate: WorkingDurableCandidate; index: number }>,
): Promise<Array<[number, SemanticCandidateOutcome]>> {
  const inputs = entries.map((entry) => buildSemanticStoreInput(workingSet, entry.candidate));
  const result = await storeDurablesDetailed(inputs, deps.db, deps.embedding, {
    ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
  });

  return entries.map((entry, position) => {
    const detail = result.details.find((candidate) => candidate.inputIndex === position);
    return [entry.index, buildSemanticOutcome(entry.candidate, detail)];
  });
}

/** Maps one store pipeline detail to a semantic candidate outcome. */
function buildSemanticOutcome(candidate: WorkingDurableCandidate, detail: StoreDurableDetail | undefined): SemanticCandidateOutcome {
  if (detail?.outcome === "stored") {
    return {
      kind: "semantic",
      subject: candidate.subject,
      promotionStatus: "promoted",
      result: "stored",
      ...(detail.durableId ? { durableId: detail.durableId } : {}),
    };
  }

  // Duplicate skips mean the knowledge is already durable, so the candidate
  // still counts as promoted for working-memory bookkeeping.
  if (detail?.outcome === "skipped") {
    return { kind: "semantic", subject: candidate.subject, promotionStatus: "promoted", result: "duplicate" };
  }

  return { kind: "semantic", subject: candidate.subject, promotionStatus: "rejected", result: "rejected" };
}

/** Builds one claim-key-aware store input from a semantic candidate. */
function buildSemanticStoreInput(workingSet: WorkingSetRecord, candidate: WorkingDurableCandidate): StoreDurableInput {
  return {
    type: candidate.suggestedKind ?? DEFAULT_SEMANTIC_CANDIDATE_KIND,
    subject: candidate.subject,
    content: candidate.content,
    source_file: buildWorkingSetSourceFile(workingSet.id),
    source_context: buildCandidateSourceContext(workingSet.id, candidate.provenance),
    ...(workingSet.project ? { project: workingSet.project } : {}),
    ...(candidate.suggestedClaimKey
      ? {
          claim_key: candidate.suggestedClaimKey,
          claim_support_source_kind: "tool_call",
          claim_support_locator: `${buildWorkingSetSourceFile(workingSet.id)}#agenr_work`,
          claim_support_observed_at: workingSet.closedAt ?? workingSet.updatedAt,
          claim_support_mode: "explicit",
        }
      : {}),
  };
}

/** Promotes one procedural candidate into a reviewable procedure proposal. */
async function promoteProceduralCandidate(
  deps: WorkingSetConsolidationDeps,
  workingSet: WorkingSetRecord,
  candidate: WorkingDurableCandidate,
  now: string,
): Promise<ProceduralCandidateOutcome> {
  if (!candidate.subject.trim() || !candidate.content.trim()) {
    return { kind: "procedural", subject: candidate.subject, promotionStatus: "rejected", result: "rejected" };
  }

  const fingerprint = computeCandidateFingerprint(candidate);
  const existing = await deps.procedureProposals.findProposalByFingerprint(workingSet.id, fingerprint);
  if (existing) {
    return {
      kind: "procedural",
      subject: candidate.subject,
      promotionStatus: "promoted",
      result: "proposal_exists",
      proposalId: existing.id,
    };
  }

  const proposal = await deps.procedureProposals.createProposal({
    workingSetId: workingSet.id,
    candidateFingerprint: fingerprint,
    subject: candidate.subject,
    content: candidate.content,
    evidenceEventSequences: candidate.provenance.evidenceEventSequences,
    ...(candidate.provenance.sourceRef ? { sourceRef: candidate.provenance.sourceRef } : {}),
    now,
  });

  return {
    kind: "procedural",
    subject: candidate.subject,
    promotionStatus: "promoted",
    result: "proposal_created",
    proposalId: proposal.id,
  };
}

/** Computes the stable idempotency fingerprint for one durable candidate. */
export function computeCandidateFingerprint(candidate: Pick<WorkingDurableCandidate, "kind" | "subject" | "content">): string {
  return createHash("sha256").update(`${candidate.kind}\n${candidate.subject}\n${candidate.content}`, "utf8").digest("hex");
}

/** Builds the hash-affecting source-file provenance label for one working set. */
function buildWorkingSetSourceFile(workingSetId: string): string {
  return `working_set:${workingSetId}`;
}

/** Builds the dedup-neutral source-context provenance text for one candidate. */
function buildCandidateSourceContext(workingSetId: string, provenance: CandidateProvenance): string {
  const parts = [`Promoted from working set ${workingSetId} by the consolidation job.`];
  if (provenance.evidenceEventSequences.length > 0) {
    parts.push(`Evidence event sequences: ${provenance.evidenceEventSequences.join(", ")}.`);
  }

  if (provenance.sourceRef) {
    parts.push(`Source ref: ${provenance.sourceRef}.`);
  }

  return parts.join(" ");
}

/** Maps repository write failures to stable consolidation failure reasons. */
function mapWriteFailureReason(failure: WorkingSetWriteFailure): WorkingSetConsolidationFailureReason {
  switch (failure.kind) {
    case "not_found":
      return "not_found";
    case "revision_conflict":
      return "revision_conflict";
    case "terminal_status":
      return "not_closed";
    default: {
      const exhaustive: never = failure;
      throw new Error(`Unhandled working-set write failure: ${JSON.stringify(exhaustive)}`);
    }
  }
}
