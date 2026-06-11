import type { DatabasePort, EmbeddingPort } from "../../core/ports.js";
import type { ProcedureProposalRepository } from "../../app/procedures/proposals/repository.js";
import { runWorkingSetConsolidation } from "../../app/working-memory/consolidation.js";
import type { WorkingMemoryRepository } from "../../app/working-memory/repository.js";
import type { WorkingCandidate } from "../../app/working-memory/snapshot.js";
import { formatErrorMessage } from "./errors.js";

/** Runtime services required by the close-time consolidation kickoff. */
export interface WorkingSetConsolidationServices {
  /** Durable database port used by the claim-key-aware store pipeline. */
  durables: DatabasePort;
  /** Embedding port used by the store pipeline. */
  embedding: EmbeddingPort;
  /** Working-memory persistence port. */
  workingMemoryRepository?: WorkingMemoryRepository;
  /** Procedure-proposal persistence port. */
  procedureProposals?: ProcedureProposalRepository;
}

/**
 * Schedules one best-effort consolidation pass for a just-closed working set.
 *
 * The pass promotes pending semantic candidates into the durable store and
 * pending procedural candidates into reviewable procedure proposals through
 * the app-owned consolidation job. Failures are logged, never thrown, and the
 * job stays re-runnable: stranded pending candidates are picked up the next
 * time the closed set is consolidated.
 *
 * @param params - Runtime ports, closed working-set id, and close candidates.
 */
export function scheduleWorkingSetConsolidation(params: {
  services: WorkingSetConsolidationServices;
  workingSetId: string;
  candidates: WorkingCandidate[];
  logger?: Pick<Console, "info" | "warn">;
}): void {
  const logger = params.logger ?? console;
  const pending = params.candidates.some(
    (candidate) => (candidate.kind === "semantic" || candidate.kind === "procedural") && candidate.promotionStatus === "pending",
  );
  if (!pending) {
    return;
  }

  const logContext = `workingSet=${params.workingSetId}`;
  const { workingMemoryRepository, procedureProposals } = params.services;
  if (!workingMemoryRepository || !procedureProposals) {
    logger.info(`[agenr] working-set consolidation skipped for ${logContext} reason=missing_runtime_ports`);
    return;
  }

  void runWorkingSetConsolidation(
    {
      workingMemory: workingMemoryRepository,
      db: params.services.durables,
      embedding: params.services.embedding,
      procedureProposals,
      onWarning: (warning) => logger.warn(`[agenr] working-set consolidation warning for ${logContext}: ${warning}`),
    },
    { workingSetId: params.workingSetId, now: new Date().toISOString() },
  )
    .then((result) => {
      if (!result.ok) {
        logger.warn(`[agenr] working-set consolidation skipped for ${logContext} reason=${result.reason}`);
        return;
      }

      const promoted = result.outcomes.filter((outcome) => outcome.promotionStatus === "promoted").length;
      const rejected = result.outcomes.filter((outcome) => outcome.promotionStatus === "rejected").length;
      logger.info(`[agenr] working-set consolidation finished for ${logContext} changed=${result.changed} promoted=${promoted} rejected=${rejected}`);
    })
    .catch((error: unknown) => {
      logger.warn(`[agenr] working-set consolidation failed for ${logContext}: ${formatErrorMessage(error)}`);
    });
}
