import path from "node:path";
import { readFileSync } from "node:fs";

import { runGeneration } from "../cli/generator";
import type { LlmProviderPreference } from "../cli/types";
import type { AdapterRegistry } from "../core/adapter-registry";
import { getAdapterByPlatformOwner, upsertSandboxAdapter } from "../db/adapters";
import { resolveSandboxAdapterPath } from "../utils/adapter-paths";
import { logger } from "../utils/logger";
import {
  appendJobLog,
  claimNextJob,
  completeJob,
  failJob,
} from "./generation-queue";

type GenerationFn = typeof runGeneration;
type AdapterRegistryLike = Pick<AdapterRegistry, "hotLoadScoped">;

interface StartGenerationWorkerOptions {
  generateFn?: GenerationFn;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function toProviderPreference(value: string | null): LlmProviderPreference | undefined {
  if (!value) {
    return undefined;
  }

  if (
    value === "codex" ||
    value === "claude-code" ||
    value === "openai-api" ||
    value === "anthropic-api"
  ) {
    return value;
  }

  return undefined;
}

async function processNextJob(registry: AdapterRegistryLike, generateFn: GenerationFn): Promise<void> {
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    const job = await claimNextJob();
    if (!job) {
      return;
    }

    logger.info("worker_job_processing_started", {
      jobId: job.id,
      platform: job.platform,
      ownerKeyId: job.ownerKeyId,
    });

    let logWriteChain = Promise.resolve();
    const onLog = (message: string) => {
      logWriteChain = logWriteChain
        .then(() => appendJobLog(job.id, message))
        .catch((error) => {
          logger.warn("worker_job_log_append_failed", {
            jobId: job.id,
            error,
          });
        });
    };

    try {
      const ownerId = job.ownerKeyId ?? "admin";
      const existingAdapter = await getAdapterByPlatformOwner(job.platform, ownerId);
      if (existingAdapter?.status === "public") {
        throw new Error(
          `Adapter '${job.platform}' for owner '${ownerId}' is public. Demote it before generating a new sandbox adapter.`,
        );
      }

      const sandboxAdapterPath = resolveSandboxAdapterPath(ownerId, job.platform);
      const generated = await generateFn(
        {
          platformName: job.platform,
          docsUrl: job.docsUrl ?? undefined,
          providerOverride: toProviderPreference(job.provider) ?? toProviderPreference(process.env.AGENR_DEFAULT_PROVIDER ?? null),
          modelOverride: job.model === null ? undefined : job.model,
          adapterOutputPath: sandboxAdapterPath,
          verbose: false,
          showThinking: false,
        },
        onLog,
      );

      await logWriteChain;
      const persistedAdapterPath = path.resolve(generated.adapterPath);
      const sourceCode = readFileSync(persistedAdapterPath, "utf8");
      const persistedAdapter = await upsertSandboxAdapter({
        platform: job.platform,
        ownerId,
        filePath: persistedAdapterPath,
        sourceCode,
      });

      await registry.hotLoadScoped(job.platform, ownerId, persistedAdapter.filePath);
      await completeJob(job.id, {
        adapterPath: persistedAdapter.filePath,
        profilePath: generated.profilePath,
        attempts: generated.attempts,
        runtime: {
          provider: generated.runtime.provider,
          model: generated.runtime.model,
        },
      });

      logger.info("worker_job_complete", {
        jobId: job.id,
        platform: job.platform,
      });
    } catch (error) {
      await logWriteChain;
      const message = error instanceof Error ? error.message : String(error);
      await failJob(job.id, message);
      logger.warn("worker_job_failed", {
        jobId: job.id,
        platform: job.platform,
        message,
      });
    }
  } catch (error) {
    logger.error("worker_processing_loop_failed", { error });
  } finally {
    isProcessing = false;
  }
}

export function startGenerationWorker(
  registry: AdapterRegistryLike,
  options: StartGenerationWorkerOptions = {},
): void {
  stopGenerationWorker();

  const pollIntervalMs = parsePositiveInt(
    process.env.AGENR_JOB_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const generateFn = options.generateFn ?? runGeneration;

  intervalId = setInterval(() => {
    void processNextJob(registry, generateFn);
  }, pollIntervalMs);

  void processNextJob(registry, generateFn);
}

export function stopGenerationWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  isProcessing = false;
}
