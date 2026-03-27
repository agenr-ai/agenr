import { createRecallAdapter } from "../../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../../adapters/embeddings.js";
import { readConfig } from "../../../config.js";
import type { EmbeddingPort } from "../../../core/ports.js";
import { recall } from "../../../core/recall/index.js";
import type { RecallEvalCaseRequest, RecallEvalCaseResponse } from "./contracts.js";
import { buildRecallEvalErrorResponse, buildRecallEvalSuccessResponse } from "./normalize-response.js";
import { provisionRecallEvalFixtures } from "./provision-fixtures.js";
import { setupRecallEvalSandbox, type RecallEvalSandboxContext } from "./sandbox.js";

/**
 * Executes one recall eval case behind a stable app-layer service seam.
 *
 * @param request - Typed recall eval case request from the HTTP adapter.
 * @returns Stable response envelope for the requested recall eval case.
 */
export async function runRecallEvalCase(request: RecallEvalCaseRequest): Promise<RecallEvalCaseResponse> {
  const startedAt = Date.now();
  const provisionedAt = new Date(startedAt).toISOString();
  let sandbox: RecallEvalSandboxContext | undefined;
  let sharedEmbeddingPort: EmbeddingPort | undefined;

  const getEmbeddingPort = (): EmbeddingPort => {
    if (sharedEmbeddingPort) {
      return sharedEmbeddingPort;
    }

    const config = readConfig();
    sharedEmbeddingPort = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));
    return sharedEmbeddingPort;
  };

  try {
    try {
      sandbox = await setupRecallEvalSandbox(request.sandbox);
    } catch (error) {
      return buildRecallEvalErrorResponse({
        request,
        code: "sandbox_setup_failed",
        message: "Failed to create isolated recall eval sandbox.",
        details: toErrorDetails(error),
        totalMs: elapsedMs(startedAt),
      });
    }

    let provisionedCount = 0;
    if (request.memoryPool.length > 0) {
      try {
        const provisionResult = await provisionRecallEvalFixtures({
          caseId: request.caseId,
          memoryPool: request.memoryPool,
          database: sandbox.database,
          embedding: getEmbeddingPort(),
          provisionedAt,
        });
        provisionedCount = provisionResult.provisionedCount;
      } catch (error) {
        return buildRecallEvalErrorResponse({
          request,
          code: "fixture_provision_failed",
          message: "Failed to provision recall eval fixtures into isolated storage.",
          details: toErrorDetails(error),
          totalMs: elapsedMs(startedAt),
          sandbox,
        });
      }
    }

    try {
      const results = await recall(request.recallRequest, createRecallAdapter(sandbox.database, getEmbeddingPort()));
      return buildRecallEvalSuccessResponse({
        request,
        results,
        provisionedCount,
        totalMs: elapsedMs(startedAt),
        sandbox,
      });
    } catch (error) {
      return buildRecallEvalErrorResponse({
        request,
        code: "recall_execution_failed",
        message: "Failed to execute real recall against isolated eval state.",
        details: toErrorDetails(error),
        totalMs: elapsedMs(startedAt),
        sandbox,
      });
    }
  } catch (error) {
    return buildRecallEvalErrorResponse({
      request,
      code: "internal_error",
      message: "Recall eval execution failed unexpectedly.",
      details: toErrorDetails(error),
      totalMs: elapsedMs(startedAt),
      sandbox,
    });
  } finally {
    await sandbox?.cleanup().catch(() => undefined);
  }
}

/** Converts unknown failures into structured non-stack error details. */
function toErrorDetails(error: unknown): { cause: string } {
  if (error instanceof Error) {
    return {
      cause: error.message,
    };
  }

  return {
    cause: String(error),
  };
}

/** Computes non-negative elapsed milliseconds since the execution start. */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
