import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../../adapters/embeddings.js";
import { readConfig } from "../../../config.js";
import type { EmbeddingPort, RecallPorts } from "../../../core/ports.js";
import { recall } from "../../../core/recall/index.js";
import { runUnifiedRecall } from "../../recall/index.js";
import { createRecallEvalDiagnosticsCollector } from "./collect-diagnostics.js";
import type { RecallEvalCaseRequest, RecallEvalCaseResponse } from "./contracts.js";
import { createInstrumentedRecallPorts } from "./instrumented-recall-ports.js";
import { buildRecallEvalErrorResponse, buildRecallEvalSuccessResponse } from "./normalize-response.js";
import type { RecallEvalSandboxContext } from "./ports.js";
import { provisionRecallEvalFixtures } from "./provision-fixtures.js";
import { provisionRecallEvalProcedureFixtures } from "./provision-procedure-fixtures.js";
import { setupRecallEvalSandbox } from "./sandbox.js";

/**
 * Executes one recall eval case behind a stable app-layer service seam.
 *
 * @param request - Typed recall eval case request from the HTTP adapter.
 * @returns Stable response envelope for the requested recall eval case.
 */
export async function runRecallEvalCase(request: RecallEvalCaseRequest): Promise<RecallEvalCaseResponse> {
  const startedAt = Date.now();
  const provisionedAt = new Date(startedAt).toISOString();
  const diagnostics = createRecallEvalDiagnosticsCollector(request);
  const recallPath = request.recallPath ?? "core";
  let sandbox: RecallEvalSandboxContext | undefined;
  let sharedEmbeddingPort: EmbeddingPort | undefined;
  let sharedEmbeddingError: string | undefined;

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

  const getEmbeddingPort = (): EmbeddingPort => {
    const support = getEmbeddingSupport();
    if (!support.port) {
      throw new Error(support.error ?? "Embeddings are unavailable.");
    }

    return support.port;
  };

  try {
    const sandboxStartedAt = Date.now();
    try {
      sandbox = await setupRecallEvalSandbox(request.sandbox);
      diagnostics.recordSandboxSetup(elapsedMs(sandboxStartedAt));
    } catch (error) {
      diagnostics.recordSandboxSetup(elapsedMs(sandboxStartedAt));
      return buildRecallEvalErrorResponse({
        request,
        code: "sandbox_setup_failed",
        message: "Failed to create isolated recall eval sandbox.",
        details: toErrorDetails(error),
        diagnostics: diagnostics.buildDiagnostics(),
        timings: diagnostics.buildTimings(elapsedMs(startedAt)),
      });
    }

    if (request.memoryPool.length > 0 || (request.procedurePool?.length ?? 0) > 0) {
      const provisionStartedAt = Date.now();
      try {
        let entryProvisionResult: Awaited<ReturnType<typeof provisionRecallEvalFixtures>> | undefined;
        if (request.memoryPool.length > 0) {
          entryProvisionResult = await provisionRecallEvalFixtures({
            caseId: request.caseId,
            memoryPool: request.memoryPool,
            store: sandbox.fixtureStore,
            embedding: getEmbeddingPort(),
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
        if (entryProvisionResult) {
          diagnostics.recordProvision(entryProvisionResult, elapsedMs(provisionStartedAt));
        } else {
          diagnostics.recordFixtureProvisionTiming(elapsedMs(provisionStartedAt));
        }
      } catch (error) {
        diagnostics.recordFixtureProvisionTiming(elapsedMs(provisionStartedAt));
        return buildRecallEvalErrorResponse({
          request,
          code: "fixture_provision_failed",
          message: "Failed to provision recall eval fixtures into isolated storage.",
          details: toErrorDetails(error),
          diagnostics: diagnostics.buildDiagnostics(),
          timings: diagnostics.buildTimings(elapsedMs(startedAt)),
          sandbox,
        });
      }
    }

    const recallStartedAt = Date.now();
    try {
      const embeddingSupport = getEmbeddingSupport();
      const recallEmbeddingPort =
        request.options?.faultInjection?.queryEmbeddingFailure === true
          ? createUnavailableEmbeddingPort("Injected recall eval query embedding failure.")
          : (embeddingSupport.port ?? createUnavailableEmbeddingPort(embeddingSupport.error ?? "Embeddings are unavailable."));
      const basePorts = applyRecallEvalFaultInjection(sandbox.createRecallPorts(recallEmbeddingPort), request);
      const recallPorts = diagnostics.isObservationEnabled() ? createInstrumentedRecallPorts(basePorts, diagnostics) : basePorts;
      const slotPolicyConfig = request.unified?.memoryPolicy?.slotPolicies;
      const rankingPolicy = request.recallRequest.rankingPolicy;
      const unifiedRecallOptions = {
        ...(slotPolicyConfig ? { slotPolicyConfig } : {}),
        ...(rankingPolicy ? { rankingPolicy } : {}),
        ...(diagnostics.isObservationEnabled() ? { trace: diagnostics.traceSink } : {}),
      };
      const coreRecallOptions = {
        ...(rankingPolicy ? { rankingPolicy } : {}),
        ...(diagnostics.isObservationEnabled() ? { trace: diagnostics.traceSink } : {}),
      };
      const results =
        recallPath === "unified"
          ? await runUnifiedRecall(
              {
                text: request.recallRequest.text,
                ...(request.unified?.mode ? { mode: request.unified.mode } : {}),
                ...(request.recallRequest.limit !== undefined ? { limit: request.recallRequest.limit } : {}),
                ...(request.recallRequest.threshold !== undefined ? { threshold: request.recallRequest.threshold } : {}),
                ...(request.recallRequest.types && request.recallRequest.types.length > 0 ? { types: request.recallRequest.types } : {}),
                ...(request.recallRequest.tags && request.recallRequest.tags.length > 0 ? { tags: request.recallRequest.tags } : {}),
                ...(request.recallRequest.asOf ? { asOf: request.recallRequest.asOf } : {}),
                ...(request.unified?.sessionKey ? { sessionKey: request.unified.sessionKey } : {}),
              },
              {
                database: sandbox.episodeDatabase,
                procedures: sandbox.procedureDatabase,
                recall: recallPorts,
                embeddingAvailable: embeddingSupport.available,
                ...(embeddingSupport.error ? { embeddingError: embeddingSupport.error } : {}),
                ...(slotPolicyConfig ? { claimSlotPolicyConfig: slotPolicyConfig } : {}),
                ...(embeddingSupport.available
                  ? {
                      embedQuery: async (text: string) => {
                        const vectors = await recallEmbeddingPort.embed([text]);
                        return vectors[0] ?? [];
                      },
                    }
                  : {}),
                ...(Object.keys(unifiedRecallOptions).length > 0 ? { recallOptions: unifiedRecallOptions } : {}),
              },
            )
          : await recall(request.recallRequest, recallPorts, Object.keys(coreRecallOptions).length > 0 ? coreRecallOptions : undefined);
      diagnostics.recordRecall(elapsedMs(recallStartedAt));
      return buildRecallEvalSuccessResponse({
        request,
        results,
        diagnostics: diagnostics.buildDiagnostics(),
        timings: diagnostics.buildTimings(elapsedMs(startedAt)),
        sandbox,
      });
    } catch (error) {
      diagnostics.recordRecall(elapsedMs(recallStartedAt));
      return buildRecallEvalErrorResponse({
        request,
        code: "recall_execution_failed",
        message: "Failed to execute real recall against isolated eval state.",
        details: toErrorDetails(error),
        diagnostics: diagnostics.buildDiagnostics(),
        timings: diagnostics.buildTimings(elapsedMs(startedAt)),
        sandbox,
      });
    }
  } catch (error) {
    return buildRecallEvalErrorResponse({
      request,
      code: "internal_error",
      message: "Recall eval execution failed unexpectedly.",
      details: toErrorDetails(error),
      diagnostics: diagnostics.buildDiagnostics(),
      timings: diagnostics.buildTimings(elapsedMs(startedAt)),
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

/** Creates an embedding port that fails lazily when query embeddings are requested. */
function createUnavailableEmbeddingPort(message: string): EmbeddingPort {
  return {
    async embed(): Promise<number[][]> {
      throw new Error(message);
    },
  };
}

/** Applies internal deterministic fault injection for degraded-mode eval cases. */
function applyRecallEvalFaultInjection(ports: RecallPorts, request: RecallEvalCaseRequest): RecallPorts {
  if (request.options?.faultInjection?.vectorSearchFailure !== true) {
    return ports;
  }

  return {
    async embed(text: string): Promise<number[]> {
      return ports.embed(text);
    },
    async vectorSearch(): Promise<never> {
      throw new Error("Injected recall eval vector search failure.");
    },
    async ftsSearch(params) {
      return ports.ftsSearch(params);
    },
    ...(ports.expandNeighborhood
      ? {
          async expandNeighborhood(request) {
            return ports.expandNeighborhood!(request);
          },
        }
      : {}),
    // Cross-encoder remains wired during fault injection so rerank-aware
    // cases can still observe the rerank stage running after the core
    // recall pipeline falls back to lexical-only retrieval. Preserving
    // the port is safe because the core helper fails closed on adapter
    // errors and honors the ranking policy kill switch.
    ...(ports.crossEncoder
      ? {
          crossEncoder: ports.crossEncoder,
        }
      : {}),
    async hydrateEntries(ids: string[]) {
      return ports.hydrateEntries(ids);
    },
    async recordRecallEvents(params) {
      return ports.recordRecallEvents(params);
    },
  };
}

/** Computes non-negative elapsed milliseconds since the execution start. */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
