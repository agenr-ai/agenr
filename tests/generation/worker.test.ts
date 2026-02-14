import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";

import { getAdapterByPlatformOwner, markAdapterPublic, upsertSandboxAdapter } from "../../src/db/adapters";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createJob, getJob } from "../../src/jobs/generation-queue";
import { startGenerationWorker, stopGenerationWorker } from "../../src/jobs/generation-worker";

let testDb: Client | null = null;
let originalPollInterval: string | undefined;
let originalAdaptersDir: string | undefined;
let testAdaptersDir: string;

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  originalPollInterval = process.env.AGENR_JOB_POLL_INTERVAL_MS;
  originalAdaptersDir = process.env.AGENR_ADAPTERS_DIR;
  process.env.AGENR_JOB_POLL_INTERVAL_MS = "25";
  testAdaptersDir = await mkdtemp(path.join(tmpdir(), "agenr-worker-adapters-"));
  process.env.AGENR_ADAPTERS_DIR = testAdaptersDir;
  process.env.AGENR_RUNTIME_ADAPTERS_DIR = testAdaptersDir;
});

afterEach(async () => {
  stopGenerationWorker();

  if (originalPollInterval === undefined) {
    delete process.env.AGENR_JOB_POLL_INTERVAL_MS;
  } else {
    process.env.AGENR_JOB_POLL_INTERVAL_MS = originalPollInterval;
  }

  if (originalAdaptersDir === undefined) {
    delete process.env.AGENR_ADAPTERS_DIR;
    delete process.env.AGENR_RUNTIME_ADAPTERS_DIR;
  } else {
    process.env.AGENR_ADAPTERS_DIR = originalAdaptersDir;
    process.env.AGENR_RUNTIME_ADAPTERS_DIR = originalAdaptersDir;
  }

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;

  await rm(testAdaptersDir, { recursive: true, force: true });
});

async function waitForJobStatus(
  jobId: string,
  expectedStatus: "complete" | "failed",
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await getJob(jobId);
    if (job?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for job '${jobId}' to reach status '${expectedStatus}'.`);
}

describe("generation worker", () => {
  test("worker persists sandbox adapter metadata and hot-loads scoped adapter", async () => {
    const hotLoaded: Array<{ platform: string; ownerId: string; filePath: string }> = [];
    const registry = {
      hotLoadScoped: async (platform: string, ownerId: string, filePath: string) => {
        hotLoaded.push({ platform, ownerId, filePath });
      },
    };

    const job = await createJob({ platform: "toast", ownerKeyId: "owner-1" });
    let receivedAdapterOutputPath: string | undefined;

    startGenerationWorker(registry, {
      generateFn: async (options, log) => {
        receivedAdapterOutputPath = options.adapterOutputPath;
        log("starting");
        log("finishing");

        const outputPath = options.adapterOutputPath ?? "missing-output-path.ts";
        const generatedSource = "export default class GeneratedToastAdapter {}";
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, generatedSource, "utf8");

        return {
          adapterPath: outputPath,
          profilePath: "data/interaction-profiles/toast.json",
          attempts: 1,
          docsUsed: [],
          runtime: {
            provider: "openai",
            source: "api-key",
            authMode: "api-key",
            token: "token",
            model: "test-model",
            baseUrl: "https://api.example.com",
          },
          businessProfileUpdate: {
            profilePath: "data/user-profile.json",
            status: "exists",
            message: "already exists",
          },
        };
      },
    });

    await waitForJobStatus(job.id, "complete");

    const updatedJob = await getJob(job.id);
    expect(updatedJob?.status).toBe("complete");
    expect(updatedJob?.logs).toEqual(["starting", "finishing"]);
    expect(typeof receivedAdapterOutputPath).toBe("string");
    expect(receivedAdapterOutputPath?.includes("/owner-1/toast.ts")).toBe(true);

    const storedAdapter = await getAdapterByPlatformOwner("toast", "owner-1");
    expect(storedAdapter?.status).toBe("sandbox");
    expect(storedAdapter?.filePath).toBe(receivedAdapterOutputPath);
    expect(storedAdapter?.sourceCode).toBe("export default class GeneratedToastAdapter {}");
    expect(storedAdapter?.sourceHash).toBe(
      createHash("sha256").update("export default class GeneratedToastAdapter {}").digest("hex"),
    );
    expect(hotLoaded).toEqual([
      {
        platform: "toast",
        ownerId: "owner-1",
        filePath: receivedAdapterOutputPath!,
      },
    ]);
    expect(updatedJob?.result).toEqual({
      adapterPath: receivedAdapterOutputPath,
      profilePath: "data/interaction-profiles/toast.json",
      attempts: 1,
      runtime: {
        provider: "openai",
        model: "test-model",
      },
    });
  });

  test("worker fails job when owner already has a public adapter for that platform", async () => {
    const ownerId = "owner-2";
    const initial = await upsertSandboxAdapter({
      platform: "stripe",
      ownerId,
      filePath: "/tmp/stripe-initial.ts",
    });
    await markAdapterPublic({
      adapterId: initial.id,
      promotedBy: "admin",
      filePath: "/tmp/stripe-public.ts",
    });

    const registry = {
      hotLoadScoped: async () => {},
    };
    const job = await createJob({ platform: "stripe", ownerKeyId: ownerId });

    startGenerationWorker(registry, {
      generateFn: async () => {
        throw new Error("generateFn should not have been called");
      },
    });

    await waitForJobStatus(job.id, "failed");
    const failed = await getJob(job.id);
    expect(failed?.error).toContain("Demote it before generating a new sandbox adapter.");
  });
});
