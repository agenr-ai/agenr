import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../../adapters/embeddings.js";
import { readConfig } from "../../../config.js";
import { runBeforeTurn } from "../../before-turn/index.js";
import type { CrossEncoderPort, EmbeddingPort } from "../../../core/ports.js";
import { attachCrossEncoderPort } from "../recall/attach-cross-encoder.js";
import { provisionRecallEvalFixtures } from "../recall/provision-fixtures.js";
import { provisionRecallEvalProcedureFixtures } from "../recall/provision-procedure-fixtures.js";
import { setupRecallEvalSandbox } from "../recall/sandbox.js";
import type { BeforeTurnEvalCaseRequest, BeforeTurnEvalCaseResponse, BeforeTurnEvalCaseTimings } from "./contracts.js";
import { buildBeforeTurnEvalErrorResponse, buildBeforeTurnEvalSuccessResponse, maybeRenderBeforeTurnPatch } from "./normalize-response.js";

/**
 * Optional runtime dependencies injected by the HTTP adapter.
 *
 * The eval server constructs these once at startup so every before-turn
 * case shares the same cross-encoder port without rebuilding it
 * per-request. Mirrors the recall runner's dependency shape so both eval
 * flows exercise phase-4 rerank through the same wiring seam.
 */
export interface BeforeTurnEvalCaseDependencies {
  /**
   * Optional cross-encoder port merged into the recall ports produced by
   * the sandbox before being handed to `runBeforeTurn`. When omitted, the
   * durable-recall trace records `degradedReason: "not_configured"` on
   * its cross-encoder branch just like the recall runner.
   */
  crossEncoder?: CrossEncoderPort;
}

/**
 * Executes one before-turn eval case behind a stable app-layer service seam.
 *
 * @param request - Typed before-turn eval case request from the HTTP adapter.
 * @param dependencies - Optional runtime dependencies wired by the HTTP adapter.
 * @returns Stable response envelope for the requested before-turn eval case.
 */
export async function runBeforeTurnEvalCase(
  request: BeforeTurnEvalCaseRequest,
  dependencies: BeforeTurnEvalCaseDependencies = {},
): Promise<BeforeTurnEvalCaseResponse> {
  const startedAt = Date.now();
  const provisionedAt = new Date(startedAt).toISOString();
  let sandbox: Awaited<ReturnType<typeof setupRecallEvalSandbox>> | undefined;
  let sharedEmbeddingPort: EmbeddingPort | undefined;
  let sharedEmbeddingError: string | undefined;
  let timings: BeforeTurnEvalCaseTimings | undefined;

  const getEmbeddingSupport = (): {
    available: boolean;
    error?: string;
    port?: EmbeddingPort;
  } => {
    if (sharedEmbeddingPort) {
      return {
        available: true,
        port: sharedEmbeddingPort,
      };
    }

    if (sharedEmbeddingError) {
      return {
        available: false,
        error: sharedEmbeddingError,
      };
    }

    const config = readConfig();
    try {
      sharedEmbeddingPort = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));
      return {
        available: true,
        port: sharedEmbeddingPort,
      };
    } catch (error) {
      sharedEmbeddingError = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: sharedEmbeddingError,
      };
    }
  };

  try {
    const sandboxStartedAt = Date.now();
    try {
      sandbox = await setupRecallEvalSandbox(request.sandbox);
      timings = {
        ...timings,
        sandboxSetupMs: elapsedMs(sandboxStartedAt),
      };
    } catch (error) {
      timings = {
        ...timings,
        totalMs: elapsedMs(startedAt),
        sandboxSetupMs: elapsedMs(sandboxStartedAt),
      };
      return buildBeforeTurnEvalErrorResponse({
        request,
        code: "sandbox_setup_failed",
        message: "Failed to create isolated before-turn eval sandbox.",
        details: toErrorDetails(error),
        timings: request.options?.includeTimings === true ? timings : undefined,
      });
    }

    if (request.memoryPool.length > 0 || (request.procedurePool?.length ?? 0) > 0) {
      const provisionStartedAt = Date.now();
      try {
        if (request.memoryPool.length > 0) {
          const embeddingSupport = getEmbeddingSupport();
          const embeddingPort = embeddingSupport.port ?? createUnavailableEmbeddingPort(embeddingSupport.error ?? "Embeddings are unavailable.");
          await provisionRecallEvalFixtures({
            caseId: request.caseId,
            memoryPool: request.memoryPool,
            store: sandbox.fixtureStore,
            embedding: embeddingPort,
            provisionedAt,
          });
        }
        if ((request.procedurePool?.length ?? 0) > 0) {
          await provisionRecallEvalProcedureFixtures({
            caseId: request.caseId,
            procedurePool: request.procedurePool ?? [],
            store: sandbox.fixtureStore,
            provisionedAt,
          });
        }
        timings = {
          ...timings,
          fixtureProvisionMs: elapsedMs(provisionStartedAt),
        };
      } catch (error) {
        timings = {
          ...timings,
          totalMs: elapsedMs(startedAt),
          fixtureProvisionMs: elapsedMs(provisionStartedAt),
        };
        return buildBeforeTurnEvalErrorResponse({
          request,
          code: "fixture_provision_failed",
          message: "Failed to provision before-turn eval fixtures into isolated storage.",
          details: toErrorDetails(error),
          timings: request.options?.includeTimings === true ? timings : undefined,
          sandbox,
        });
      }
    }

    const beforeTurnStartedAt = Date.now();
    try {
      const embeddingSupport = getEmbeddingSupport();
      const sandboxRecallPorts = sandbox.createRecallPorts(
        embeddingSupport.port ?? createUnavailableEmbeddingPort(embeddingSupport.error ?? "Embeddings are unavailable."),
      );
      const recallPorts = attachCrossEncoderPort(sandboxRecallPorts, dependencies.crossEncoder);
      const patch = await runBeforeTurn(request.beforeTurnInput, {
        recall: recallPorts,
        procedures: sandbox.procedureDatabase,
        embedQuery: embeddingSupport.port
          ? async (text: string) => {
              const vectors = await embeddingSupport.port!.embed([text]);
              return vectors[0] ?? [];
            }
          : undefined,
      });
      timings = {
        ...timings,
        beforeTurnMs: elapsedMs(beforeTurnStartedAt),
      };

      let renderedPatchText: string | undefined;
      if (request.options?.includeRenderedPatch === true) {
        const renderStartedAt = Date.now();
        renderedPatchText = maybeRenderBeforeTurnPatch(request, patch);
        timings = {
          ...timings,
          renderPatchMs: elapsedMs(renderStartedAt),
        };
      }

      timings = {
        ...timings,
        totalMs: elapsedMs(startedAt),
      };
      return buildBeforeTurnEvalSuccessResponse({
        request,
        patch,
        renderedPatchText,
        timings: request.options?.includeTimings === true ? timings : undefined,
        sandbox,
      });
    } catch (error) {
      timings = {
        ...timings,
        totalMs: elapsedMs(startedAt),
        beforeTurnMs: elapsedMs(beforeTurnStartedAt),
      };
      return buildBeforeTurnEvalErrorResponse({
        request,
        code: "before_turn_execution_failed",
        message: "Failed to execute real before-turn selection against isolated eval state.",
        details: toErrorDetails(error),
        timings: request.options?.includeTimings === true ? timings : undefined,
        sandbox,
      });
    }
  } catch (error) {
    return buildBeforeTurnEvalErrorResponse({
      request,
      code: "internal_error",
      message: "Before-turn eval execution failed unexpectedly.",
      details: toErrorDetails(error),
      timings: request.options?.includeTimings === true ? { ...timings, totalMs: elapsedMs(startedAt) } : undefined,
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

/** Creates an embedding port that fails lazily when embeddings are requested. */
function createUnavailableEmbeddingPort(message: string): EmbeddingPort {
  return {
    async embed(): Promise<number[][]> {
      throw new Error(message);
    },
  };
}

/** Returns elapsed milliseconds since the provided start time. */
function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
