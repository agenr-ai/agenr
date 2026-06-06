import { isMemoryOffArm, resolveAblationConfig, shouldProvisionProfileSnapshot } from "../ablation-arm.js";
import { createEvalEmbeddingResolver, createUnavailableEmbeddingPort } from "../eval-embedding.js";
import { parseEvalNow } from "../eval-clock.js";
import { provisionEvalSandbox } from "../provision-sandbox.js";
import { runBeforeTurn } from "../../before-turn/index.js";
import type { CrossEncoderPort } from "../../../core/ports.js";
import { attachCrossEncoderPort } from "../recall/attach-cross-encoder.js";
import { setupRecallEvalSandbox } from "../recall/sandbox.js";
import { applyTelemetryWriteGate } from "../recall/telemetry-write-gate.js";
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
  const ablation = resolveAblationConfig(request.sandbox);
  const evalNow = parseEvalNow(ablation.now);
  const embeddingResolver = createEvalEmbeddingResolver();
  let sandbox: Awaited<ReturnType<typeof setupRecallEvalSandbox>> | undefined;
  let timings: BeforeTurnEvalCaseTimings | undefined;

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

    if (request.memoryPool.length > 0 || (request.procedurePool?.length ?? 0) > 0 || shouldProvisionProfileSnapshot(ablation)) {
      const provisionStartedAt = Date.now();
      try {
        await provisionEvalSandbox({
          caseId: request.caseId,
          sandbox,
          memoryPool: request.memoryPool,
          procedurePool: request.procedurePool,
          profileSnapshot: shouldProvisionProfileSnapshot(ablation) ? ablation.profileSnapshot : undefined,
          embedding: request.memoryPool.length > 0 ? embeddingResolver.portOrUnavailable() : undefined,
          provisionedAt,
        });
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
      if (isMemoryOffArm(ablation)) {
        timings = {
          ...timings,
          beforeTurnMs: elapsedMs(beforeTurnStartedAt),
          totalMs: elapsedMs(startedAt),
        };
        return buildBeforeTurnEvalSuccessResponse({
          request,
          patch: {
            durableMemory: [],
            diagnostics: {
              abstained: true,
              abstentionReasons: ["memory_off_ablation"],
              queryVariants: [],
              recentTurnCount: 0,
              turnSignalLabels: [],
              durableRecallUsed: false,
              durableRecallCandidateCount: 0,
              procedureRecallUsed: false,
              procedureCandidateCount: 0,
              notices: ["memory-off ablation arm stubbed before-turn injection."],
            },
          },
          timings: request.options?.includeTimings === true ? timings : undefined,
          sandbox,
        });
      }

      const activeSandbox = sandbox;
      if (!activeSandbox) {
        throw new Error("Before-turn eval sandbox was not initialized.");
      }

      const embeddingSupport = embeddingResolver.getSupport();
      const sandboxRecallPorts = activeSandbox.createRecallPorts(
        embeddingSupport.port ?? createUnavailableEmbeddingPort(embeddingSupport.error ?? "Embeddings are unavailable."),
      );
      const recallPorts = applyTelemetryWriteGate(attachCrossEncoderPort(sandboxRecallPorts, dependencies.crossEncoder), activeSandbox);
      const patch = await runBeforeTurn(request.beforeTurnInput, {
        recall: recallPorts,
        procedures: activeSandbox.procedureDatabase,
        ...(evalNow ? { now: evalNow } : {}),
        listActiveAbstainDirectives: () => activeSandbox.listActiveAbstainDirectives(evalNow),
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
        sandbox: activeSandbox,
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

/** Returns elapsed milliseconds since the provided start time. */
function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
