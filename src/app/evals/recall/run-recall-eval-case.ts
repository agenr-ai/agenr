import { isMemoryOffArm, resolveAblationConfig, shouldProvisionProfileSnapshot } from "../ablation-arm.js";
import { createEvalEmbeddingResolver, createUnavailableEmbeddingPort } from "../eval-embedding.js";
import { parseEvalNow } from "../eval-clock.js";
import { provisionEvalSandbox } from "../provision-sandbox.js";
import type { CrossEncoderPort, RecallPorts } from "../../../core/ports.js";
import { recall } from "../../../core/recall/index.js";
import { runUnifiedRecall } from "../../recall/index.js";
import { attachCrossEncoderPort } from "./attach-cross-encoder.js";
import { createRecallEvalDiagnosticsCollector } from "./collect-diagnostics.js";
import type { RecallEvalCaseRequest, RecallEvalCaseResponse } from "./contracts.js";
import { createInstrumentedRecallPorts } from "./instrumented-recall-ports.js";
import { buildRecallEvalErrorResponse, buildRecallEvalSuccessResponse } from "./normalize-response.js";
import type { RecallEvalSandboxContext } from "./ports.js";
import { setupRecallEvalSandbox } from "./sandbox.js";
import { applyTelemetryWriteGate } from "./telemetry-write-gate.js";

/**
 * Optional runtime dependencies injected by the HTTP adapter.
 *
 * The eval server constructs these once at startup so every case shares
 * the same cross-encoder port without rebuilding it per-request.
 */
export interface RecallEvalCaseDependencies {
  /**
   * Optional cross-encoder port merged into the recall ports produced by
   * the sandbox. When omitted, recall still runs but the core helper
   * records `degradedReason: "not_configured"` on its cross-encoder trace.
   */
  crossEncoder?: CrossEncoderPort;
}

/**
 * Executes one recall eval case behind a stable app-layer service seam.
 *
 * @param request - Typed recall eval case request from the HTTP adapter.
 * @param dependencies - Optional runtime dependencies wired by the HTTP adapter.
 * @returns Stable response envelope for the requested recall eval case.
 */
export async function runRecallEvalCase(request: RecallEvalCaseRequest, dependencies: RecallEvalCaseDependencies = {}): Promise<RecallEvalCaseResponse> {
  const startedAt = Date.now();
  const provisionedAt = new Date(startedAt).toISOString();
  const diagnostics = createRecallEvalDiagnosticsCollector(request);
  const recallPath = request.recallPath ?? "core";
  const ablation = resolveAblationConfig(request.sandbox);
  const evalNow = parseEvalNow(ablation.now);
  const embeddingResolver = createEvalEmbeddingResolver();
  let sandbox: RecallEvalSandboxContext | undefined;

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

    if (request.memoryPool.length > 0 || (request.procedurePool?.length ?? 0) > 0 || shouldProvisionProfileSnapshot(ablation)) {
      const provisionStartedAt = Date.now();
      try {
        const provisionResult = await provisionEvalSandbox({
          caseId: request.caseId,
          sandbox,
          memoryPool: request.memoryPool,
          procedurePool: request.procedurePool,
          profileSnapshot: shouldProvisionProfileSnapshot(ablation) ? ablation.profileSnapshot : undefined,
          embedding: request.memoryPool.length > 0 ? embeddingResolver.requirePort() : undefined,
          provisionedAt,
        });
        if (provisionResult.entryProvisionResult) {
          diagnostics.recordProvision(provisionResult.entryProvisionResult, elapsedMs(provisionStartedAt));
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
      if (isMemoryOffArm(ablation)) {
        diagnostics.recordRecall(elapsedMs(recallStartedAt));
        return buildRecallEvalSuccessResponse({
          request,
          results: [],
          diagnostics: diagnostics.buildDiagnostics(),
          timings: diagnostics.buildTimings(elapsedMs(startedAt)),
          sandbox,
        });
      }

      const activeSandbox = sandbox;
      if (!activeSandbox) {
        throw new Error("Recall eval sandbox was not initialized.");
      }

      const embeddingSupport = embeddingResolver.getSupport();
      const recallEmbeddingPort =
        request.options?.faultInjection?.queryEmbeddingFailure === true
          ? createUnavailableEmbeddingPort("Injected recall eval query embedding failure.")
          : (embeddingSupport.port ?? createUnavailableEmbeddingPort(embeddingSupport.error ?? "Embeddings are unavailable."));
      const sandboxPorts = activeSandbox.createRecallPorts(recallEmbeddingPort);
      const portsWithCrossEncoder = attachCrossEncoderPort(sandboxPorts, dependencies.crossEncoder);
      const telemetryGatedPorts = applyTelemetryWriteGate(portsWithCrossEncoder, activeSandbox);
      const basePorts = applyRecallEvalFaultInjection(telemetryGatedPorts, request);
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
                database: activeSandbox.episodeDatabase,
                procedures: activeSandbox.procedureDatabase,
                recall: recallPorts,
                embeddingAvailable: embeddingSupport.available,
                ...(embeddingSupport.error ? { embeddingError: embeddingSupport.error } : {}),
                ...(slotPolicyConfig ? { claimSlotPolicyConfig: slotPolicyConfig } : {}),
                ...(evalNow ? { now: evalNow } : {}),
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
          : await recall(request.recallRequest, recallPorts, {
              ...(Object.keys(coreRecallOptions).length > 0 ? coreRecallOptions : {}),
              ...(evalNow ? { now: evalNow } : {}),
            });
      diagnostics.recordRecall(elapsedMs(recallStartedAt));
      return buildRecallEvalSuccessResponse({
        request,
        results,
        diagnostics: diagnostics.buildDiagnostics(),
        timings: diagnostics.buildTimings(elapsedMs(startedAt)),
        sandbox: activeSandbox,
        observedArtifactFacts: request.options?.includeDebugArtifact === true ? diagnostics.buildObservedArtifactFacts() : undefined,
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
