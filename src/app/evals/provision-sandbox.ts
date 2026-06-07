import type { EmbeddingPort } from "../../core/ports.js";

import type { EvalProfileSnapshotFixture } from "./ablation-arm.js";
import { provisionRecallEvalFixtures } from "./recall/provision-fixtures.js";
import { provisionRecallEvalProcedureFixtures } from "./recall/provision-procedure-fixtures.js";
import type { RecallEvalFixtureDurable, RecallEvalFixtureProcedure } from "./recall/contracts.js";
import type { RecallEvalSandboxContext } from "./recall/ports.js";

/** Result of provisioning shared eval fixtures into one sandbox. */
export interface EvalSandboxProvisioningResult {
  /** Durable fixture provisioning metrics, when durable fixtures were supplied. */
  durableProvisionResult?: Awaited<ReturnType<typeof provisionRecallEvalFixtures>>;
  /** Activated profile snapshot id, when one was supplied. */
  profileSnapshotId?: string;
}

/**
 * Provisions the shared fixture families used by recall, before-turn, and session-start evals.
 *
 * @param params - Sandbox, fixture pools, embedding port, and provision timestamp.
 * @returns Provisioning metrics for response diagnostics.
 */
export async function provisionEvalSandbox(params: {
  caseId: string;
  sandbox: RecallEvalSandboxContext;
  memoryPool: RecallEvalFixtureDurable[];
  procedurePool?: RecallEvalFixtureProcedure[];
  profileSnapshot?: EvalProfileSnapshotFixture;
  embedding?: EmbeddingPort;
  provisionedAt: string;
}): Promise<EvalSandboxProvisioningResult> {
  let durableProvisionResult: EvalSandboxProvisioningResult["durableProvisionResult"];
  if (params.memoryPool.length > 0) {
    if (!params.embedding) {
      throw new Error("Embeddings are unavailable.");
    }

    durableProvisionResult = await provisionRecallEvalFixtures({
      caseId: params.caseId,
      memoryPool: params.memoryPool,
      store: params.sandbox.fixtureStore,
      embedding: params.embedding,
      provisionedAt: params.provisionedAt,
    });
  }

  if ((params.procedurePool?.length ?? 0) > 0) {
    await provisionRecallEvalProcedureFixtures({
      caseId: params.caseId,
      procedurePool: params.procedurePool ?? [],
      store: params.sandbox.fixtureStore,
      provisionedAt: params.provisionedAt,
    });
  }

  const profileSnapshot = params.profileSnapshot ? await params.sandbox.provisionProfileSnapshot(params.profileSnapshot, params.provisionedAt) : undefined;

  return {
    ...(durableProvisionResult ? { durableProvisionResult } : {}),
    ...(profileSnapshot ? { profileSnapshotId: profileSnapshot.snapshotId } : {}),
  };
}
