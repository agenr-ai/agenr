import { stringify } from "yaml";

import type { EmbeddingPort } from "../../../core/ports.js";
import { saveProcedureDocument, validateProcedureContent, type ProcedureSaveResult } from "../../web/procedure-editor-service.js";
import {
  isProcedureProposalReviewFailure,
  type ProcedureProposalRecord,
  type ProcedureProposalRepository,
  type ProcedureProposalReviewFailure,
} from "./repository.js";

/** Relative directory inside the procedures workspace for applied drafts. */
const PROPOSED_PROCEDURE_DIRECTORY = "proposed";

/** Ports required to apply one procedure proposal. */
export interface ApplyProcedureProposalDeps {
  /** Procedure-proposal persistence port. */
  repository: ProcedureProposalRepository;
  /** Embedding port used by the procedure sync that follows the YAML write. */
  embedding: EmbeddingPort;
  /** Procedures workspace directory that owns repo-authored YAML. */
  proceduresDir: string;
  /** Knowledge database path used by procedure sync. */
  dbPath: string;
}

/** Failure reasons returned by proposal review operations. */
export type ProcedureProposalServiceFailure = ProcedureProposalReviewFailure | { kind: "invalid_draft"; message: string };

/** Result of applying one procedure proposal. */
export type ApplyProcedureProposalResult =
  | {
      ok: true;
      /** Settled proposal row. */
      proposal: ProcedureProposalRecord;
      /** Relative YAML path written inside the procedures directory. */
      relativePath: string;
      /** Save-and-sync outcome from the procedures pipeline. */
      save: ProcedureSaveResult;
    }
  | { ok: false; failure: ProcedureProposalServiceFailure };

/** Result of rejecting one procedure proposal. */
export type RejectProcedureProposalResult = { ok: true; proposal: ProcedureProposalRecord } | { ok: false; failure: ProcedureProposalReviewFailure };

/** One rendered draft procedure document derived from a proposal. */
export interface ProcedureProposalDraft {
  /** Stable procedure key for the draft. */
  procedureKey: string;
  /** Relative YAML path inside the procedures directory. */
  relativePath: string;
  /** Rendered YAML content. */
  content: string;
}

/**
 * Renders one reviewable draft procedure YAML document from a proposal.
 *
 * The draft is a valid procedure that clearly marks itself as promoted from
 * working memory: the candidate content becomes the single step instruction
 * and the sources carry working-set provenance. Operators are expected to
 * refine the document after apply.
 *
 * @param proposal - Open procedure proposal.
 * @param options - Optional explicit procedure key or relative path overrides.
 * @returns Draft procedure key, relative path, and YAML content.
 */
export function renderProcedureProposalDraft(
  proposal: Pick<ProcedureProposalRecord, "subject" | "content" | "workingSetId" | "evidenceEventSequences">,
  options: { procedureKey?: string; relativePath?: string } = {},
): ProcedureProposalDraft {
  const slug = slugifyProcedureSubject(proposal.subject);
  const procedureKey = options.procedureKey ?? `${PROPOSED_PROCEDURE_DIRECTORY}/${slug}`;
  const relativePath = options.relativePath ?? `${PROPOSED_PROCEDURE_DIRECTORY}/${slug}.yaml`;
  const locator =
    proposal.evidenceEventSequences.length > 0
      ? `working_set:${proposal.workingSetId}#events:${proposal.evidenceEventSequences.join(",")}`
      : `working_set:${proposal.workingSetId}`;

  const document = {
    procedure_key: procedureKey,
    title: proposal.subject,
    goal: proposal.subject,
    steps: [
      {
        id: "review-draft",
        kind: "ask_user",
        instruction: proposal.content,
        prompt: "Review and refine this draft procedure promoted from working memory before relying on it.",
      },
    ],
    verification: ["A human has reviewed and refined this draft procedure."],
    failure_modes: ["Draft promoted from working memory may be incomplete or incorrect."],
    sources: [
      {
        kind: "manual",
        label: "working-memory consolidation",
        locator,
      },
    ],
  };

  return { procedureKey, relativePath, content: stringify(document) };
}

/**
 * Applies one open procedure proposal: writes the draft YAML into the
 * procedures workspace, runs procedure sync, and settles the proposal.
 *
 * @param deps - Repository, embedding, procedures directory, and db path.
 * @param input - Proposal id, reviewer reason, optional overrides, timestamp.
 * @returns Settled proposal plus the save-and-sync outcome, or a stable failure.
 */
export async function applyProcedureProposal(
  deps: ApplyProcedureProposalDeps,
  input: { proposalId: string; reason: string; procedureKey?: string; relativePath?: string; now: string },
): Promise<ApplyProcedureProposalResult> {
  const proposal = await deps.repository.getProposal(input.proposalId);
  if (!proposal) {
    return { ok: false, failure: { kind: "not_found" } };
  }

  if (proposal.status !== "open") {
    return { ok: false, failure: { kind: "already_reviewed", status: proposal.status } };
  }

  const draft = renderProcedureProposalDraft(proposal, {
    ...(input.procedureKey ? { procedureKey: input.procedureKey } : {}),
    ...(input.relativePath ? { relativePath: input.relativePath } : {}),
  });
  const validation = validateProcedureContent(draft.content, draft.relativePath);
  if (!validation.valid) {
    return { ok: false, failure: { kind: "invalid_draft", message: validation.error ?? "Draft procedure failed validation." } };
  }

  const save = await saveProcedureDocument({
    proceduresDir: deps.proceduresDir,
    relativePath: draft.relativePath,
    content: draft.content,
    dbPath: deps.dbPath,
    embedding: deps.embedding,
  });

  const review = await deps.repository.reviewProposal({
    proposalId: proposal.id,
    decision: "applied",
    reason: input.reason,
    appliedProcedurePath: draft.relativePath,
    now: input.now,
  });
  if (isProcedureProposalReviewFailure(review)) {
    return { ok: false, failure: review };
  }

  return { ok: true, proposal: review.proposal, relativePath: draft.relativePath, save };
}

/**
 * Rejects one open procedure proposal with a required reviewer reason.
 *
 * @param deps - Procedure-proposal persistence port.
 * @param input - Proposal id, reviewer reason, and timestamp.
 * @returns Settled proposal, or a stable failure.
 */
export async function rejectProcedureProposal(
  deps: { repository: ProcedureProposalRepository },
  input: { proposalId: string; reason: string; now: string },
): Promise<RejectProcedureProposalResult> {
  const review = await deps.repository.reviewProposal({
    proposalId: input.proposalId,
    decision: "rejected",
    reason: input.reason,
    now: input.now,
  });
  if (isProcedureProposalReviewFailure(review)) {
    return { ok: false, failure: review };
  }

  return { ok: true, proposal: review.proposal };
}

/** Builds a lowercase hyphenated slug from one proposal subject. */
function slugifyProcedureSubject(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");

  return slug || "draft-procedure";
}
