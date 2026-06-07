import { runSessionStart } from "../../session-start/index.js";
import { isMemoryOffArm, resolveAblationConfig, shouldProvisionProfileSnapshot } from "../ablation-arm.js";
import { createEvalEmbeddingResolver, createUnavailableEmbeddingPort } from "../eval-embedding.js";
import { parseEvalNow } from "../eval-clock.js";
import { provisionEvalSandbox } from "../provision-sandbox.js";
import { setupRecallEvalSandbox } from "../recall/sandbox.js";
import type { SessionStartEvalCaseRequest, SessionStartEvalCaseResponse, SessionStartEvalCaseTimings } from "./contracts.js";
import { buildSessionStartEvalErrorResponse, buildSessionStartEvalSuccessResponse } from "./normalize-response.js";

/**
 * Executes one session-start eval case behind a stable app-layer service seam.
 */
export async function runSessionStartEvalCase(request: SessionStartEvalCaseRequest): Promise<SessionStartEvalCaseResponse> {
  const startedAt = Date.now();
  const provisionedAt = new Date(startedAt).toISOString();
  const ablation = resolveAblationConfig(request.sandbox);
  const evalNow = parseEvalNow(ablation.now);
  const embeddingResolver = createEvalEmbeddingResolver();
  let sandbox: Awaited<ReturnType<typeof setupRecallEvalSandbox>> | undefined;
  let timings: SessionStartEvalCaseTimings | undefined;

  try {
    const sandboxStartedAt = Date.now();
    try {
      sandbox = await setupRecallEvalSandbox(request.sandbox);
      timings = { sandboxSetupMs: elapsedMs(sandboxStartedAt) };
    } catch (error) {
      return buildSessionStartEvalErrorResponse({
        request,
        code: "sandbox_setup_failed",
        message: "Failed to create isolated session-start eval sandbox.",
        details: toErrorDetails(error),
        timings: request.options?.includeTimings === true ? { totalMs: elapsedMs(startedAt), sandboxSetupMs: elapsedMs(sandboxStartedAt) } : undefined,
      });
    }

    if (request.memoryPool.length > 0 || shouldProvisionProfileSnapshot(ablation)) {
      const provisionStartedAt = Date.now();
      try {
        await provisionEvalSandbox({
          caseId: request.caseId,
          sandbox,
          memoryPool: request.memoryPool,
          profileSnapshot: shouldProvisionProfileSnapshot(ablation) ? ablation.profileSnapshot : undefined,
          embedding: request.memoryPool.length > 0 ? embeddingResolver.portOrUnavailable() : undefined,
          provisionedAt,
        });

        timings = { ...timings, fixtureProvisionMs: elapsedMs(provisionStartedAt) };
      } catch (error) {
        return buildSessionStartEvalErrorResponse({
          request,
          code: "fixture_provision_failed",
          message: "Failed to provision session-start eval fixtures into isolated storage.",
          details: toErrorDetails(error),
          timings:
            request.options?.includeTimings === true
              ? { ...timings, totalMs: elapsedMs(startedAt), fixtureProvisionMs: elapsedMs(provisionStartedAt) }
              : undefined,
          sandbox,
        });
      }
    }

    const sessionStartStartedAt = Date.now();
    try {
      if (isMemoryOffArm(ablation)) {
        timings = {
          ...timings,
          sessionStartMs: elapsedMs(sessionStartStartedAt),
          totalMs: elapsedMs(startedAt),
        };
        return buildSessionStartEvalSuccessResponse({
          request,
          patch: {
            durableMemory: [],
            diagnostics: {
              coreCandidateCount: 0,
              profileCandidateCount: 0,
              proactiveDirectiveCandidateCount: 0,
              artifactRecallCandidateCount: 0,
              artifactRecallUsed: false,
              notices: ["memory-off ablation arm stubbed session-start injection."],
            },
          },
          timings: request.options?.includeTimings === true ? timings : undefined,
          sandbox,
        });
      }

      const activeSandbox = sandbox;
      if (!activeSandbox) {
        throw new Error("Session-start eval sandbox was not initialized.");
      }

      const embeddingSupport = embeddingResolver.getSupport();
      const recallPorts = activeSandbox.createRecallPorts(
        embeddingSupport.port ?? createUnavailableEmbeddingPort(embeddingSupport.error ?? "Embeddings are unavailable."),
      );
      const patch = await runSessionStart(request.sessionStartInput, {
        repository: activeSandbox.sessionStartRepository,
        recall: recallPorts,
        ...(evalNow ? { now: evalNow } : {}),
        listActiveAbstainDirectives: () => activeSandbox.listActiveAbstainDirectives(evalNow),
        listActiveProactiveDirectives: () => activeSandbox.listActiveSessionStartProactiveDirectives(evalNow),
      });

      timings = {
        ...timings,
        sessionStartMs: elapsedMs(sessionStartStartedAt),
        totalMs: elapsedMs(startedAt),
      };

      return buildSessionStartEvalSuccessResponse({
        request,
        patch,
        timings: request.options?.includeTimings === true ? timings : undefined,
        sandbox: activeSandbox,
      });
    } catch (error) {
      return buildSessionStartEvalErrorResponse({
        request,
        code: "session_start_execution_failed",
        message: "Failed to execute real session-start selection against isolated eval state.",
        details: toErrorDetails(error),
        timings:
          request.options?.includeTimings === true
            ? { ...timings, totalMs: elapsedMs(startedAt), sessionStartMs: elapsedMs(sessionStartStartedAt) }
            : undefined,
        sandbox,
      });
    }
  } catch (error) {
    return buildSessionStartEvalErrorResponse({
      request,
      code: "internal_error",
      message: "Session-start eval execution failed unexpectedly.",
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
