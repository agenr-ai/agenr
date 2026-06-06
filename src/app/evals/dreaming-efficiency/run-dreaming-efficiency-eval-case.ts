import { deriveDreamEfficiencySummary, estimateProfileInjectionTokens } from "../../../core/dreaming/efficiency.js";
import { resolveAblationConfig, shouldProvisionProfileSnapshot } from "../ablation-arm.js";
import { createEvalEmbeddingResolver } from "../eval-embedding.js";
import { provisionEvalSandbox } from "../provision-sandbox.js";
import { setupRecallEvalSandbox } from "../recall/sandbox.js";
import type { DreamingEfficiencyEvalCaseRequest, DreamingEfficiencyEvalCaseResponse, DreamingEfficiencyEvalCaseTimings } from "./contracts.js";
import { buildDreamingEfficiencyEvalErrorResponse, buildDreamingEfficiencyEvalSuccessResponse } from "./normalize-response.js";

/**
 * Executes one dreaming-efficiency eval case behind a stable app-layer service seam.
 */
export async function runDreamingEfficiencyEvalCase(request: DreamingEfficiencyEvalCaseRequest): Promise<DreamingEfficiencyEvalCaseResponse> {
  const startedAt = Date.now();
  const provisionedAt = new Date(startedAt).toISOString();
  const ablation = resolveAblationConfig(request.sandbox);
  const shouldProvisionProfile = shouldProvisionProfileSnapshot(ablation);
  const embeddingResolver = createEvalEmbeddingResolver();
  let sandbox: Awaited<ReturnType<typeof setupRecallEvalSandbox>> | undefined;
  let timings: DreamingEfficiencyEvalCaseTimings | undefined;
  let dreamRunId: string | undefined;

  try {
    const sandboxStartedAt = Date.now();
    try {
      sandbox = await setupRecallEvalSandbox(request.sandbox);
      timings = { sandboxSetupMs: elapsedMs(sandboxStartedAt) };
    } catch (error) {
      return buildDreamingEfficiencyEvalErrorResponse({
        request,
        code: "sandbox_setup_failed",
        message: "Failed to create isolated dreaming-efficiency eval sandbox.",
        details: toErrorDetails(error),
        timings: request.options?.includeTimings === true ? { totalMs: elapsedMs(startedAt), sandboxSetupMs: elapsedMs(sandboxStartedAt) } : undefined,
      });
    }

    const provisionStartedAt = Date.now();
    try {
      if (request.memoryPool.length > 0) {
        await provisionEvalSandbox({
          caseId: request.caseId,
          sandbox,
          memoryPool: request.memoryPool,
          embedding: request.memoryPool.length > 0 ? embeddingResolver.portOrUnavailable() : undefined,
          provisionedAt,
        });
      }

      const seededRun = await sandbox.dreamRunStore.provisionDreamRun(request.dreamRunFixture);
      dreamRunId = seededRun.runId;

      if (shouldProvisionProfile) {
        await sandbox.provisionProfileSnapshot(
          {
            ...ablation.profileSnapshot!,
            runId: dreamRunId,
          },
          provisionedAt,
        );
      }

      timings = { ...timings, fixtureProvisionMs: elapsedMs(provisionStartedAt) };
    } catch (error) {
      return buildDreamingEfficiencyEvalErrorResponse({
        request,
        code: "fixture_provision_failed",
        message: "Failed to provision dreaming-efficiency eval fixtures into isolated storage.",
        details: toErrorDetails(error),
        timings:
          request.options?.includeTimings === true
            ? { ...timings, totalMs: elapsedMs(startedAt), fixtureProvisionMs: elapsedMs(provisionStartedAt) }
            : undefined,
        sandbox,
      });
    }

    try {
      const persistedRun = dreamRunId ? await sandbox.dreamRunStore.getDreamRun(dreamRunId) : null;
      if (!persistedRun?.summaryJson) {
        return buildDreamingEfficiencyEvalErrorResponse({
          request,
          code: "efficiency_resolution_failed",
          message: "Persisted dreaming run summary is required for dreaming-efficiency eval cases.",
          timings: request.options?.includeTimings === true ? { ...timings, totalMs: elapsedMs(startedAt) } : undefined,
          sandbox,
        });
      }

      const efficiency = deriveDreamEfficiencySummary(persistedRun.summaryJson, persistedRun.estimatedCostUsd);
      if (!efficiency) {
        return buildDreamingEfficiencyEvalErrorResponse({
          request,
          code: "efficiency_resolution_failed",
          message: "Persisted dreaming run summary must include scan and project counters for efficiency derivation.",
          timings: request.options?.includeTimings === true ? { ...timings, totalMs: elapsedMs(startedAt) } : undefined,
          sandbox,
        });
      }

      const directiveCount = request.memoryPool.filter((entry) => entry.type === "directive").length;
      const storeOnlyEquivalentTokenEstimate =
        request.memoryPool.length > 0 ? estimateProfileInjectionTokens(request.memoryPool.length, directiveCount) : undefined;

      timings = {
        ...timings,
        totalMs: elapsedMs(startedAt),
      };

      return buildDreamingEfficiencyEvalSuccessResponse({
        request,
        efficiency,
        profileInjectionTokenEstimate: efficiency.profileInjectionTokenEstimate,
        ...(storeOnlyEquivalentTokenEstimate !== undefined ? { storeOnlyEquivalentTokenEstimate } : {}),
        timings: request.options?.includeTimings === true ? timings : undefined,
        sandbox,
      });
    } catch (error) {
      return buildDreamingEfficiencyEvalErrorResponse({
        request,
        code: "efficiency_resolution_failed",
        message: "Failed to resolve dreaming-efficiency telemetry from isolated eval state.",
        details: toErrorDetails(error),
        timings: request.options?.includeTimings === true ? { ...timings, totalMs: elapsedMs(startedAt) } : undefined,
        sandbox,
      });
    }
  } catch (error) {
    return buildDreamingEfficiencyEvalErrorResponse({
      request,
      code: "internal_error",
      message: "Dreaming-efficiency eval execution failed unexpectedly.",
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
    return { cause: error.message };
  }

  return { cause: String(error) };
}

/** Returns elapsed milliseconds since the provided start time. */
function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
