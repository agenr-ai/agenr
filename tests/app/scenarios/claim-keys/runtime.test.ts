import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultClaimKeyScenarioRoot,
  listClaimKeyScenariosRuntime,
  loadClaimKeyScenarioFile,
  runClaimKeyScenariosRuntime,
} from "../../../../src/app/scenarios/claim-keys/index.js";

const tempDirectories: string[] = [];
const WAVE_TWO_SCENARIO_IDS = [
  "claim-keys.ingest.ambiguous-narrative-abstains",
  "claim-keys.surgeon.ambiguous-family-proposal",
  "claim-keys.surgeon.missing-key-backfill-high-confidence",
] as const;
const WAVE_THREE_SCENARIO_IDS = [
  "claim-keys.ingest.clear-slot-inferred",
  "claim-keys.store.extracted-model-key-trusted",
  "claim-keys.store.deterministic-repair-tentative",
] as const;

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop() ?? "", { recursive: true, force: true });
  }
});

describe("claim-key scenario runtime", () => {
  it("lists the repo-local scenario corpus and supports kind filters", async () => {
    const allScenarios = await listClaimKeyScenariosRuntime();
    const storeScenarios = await listClaimKeyScenariosRuntime({ kind: "store" });

    expect(allScenarios).toHaveLength(10);
    expect(allScenarios.map((scenario) => scenario.id)).toEqual([
      "claim-keys.ingest.ambiguous-narrative-abstains",
      "claim-keys.ingest.clear-slot-inferred",
      "claim-keys.ingest.explicit-tool-key-preserved",
      "claim-keys.store.deterministic-repair-tentative",
      "claim-keys.store.extracted-model-key-trusted",
      "claim-keys.store.manual-key-trusted",
      "claim-keys.store.trusted-exact-sibling-auto-supersedes",
      "claim-keys.surgeon.ambiguous-family-proposal",
      "claim-keys.surgeon.malformed-key-normalized",
      "claim-keys.surgeon.missing-key-backfill-high-confidence",
    ]);
    expect(storeScenarios).toHaveLength(4);
    expect(storeScenarios.every((scenario) => scenario.kind === "store")).toBe(true);
  });

  it("rejects sandbox.reset=false during scenario validation", async () => {
    const tempRoot = await createScenarioRoot("claim-key-validate-");
    const filePath = path.join(tempRoot, "store", "invalid.json");

    await writeFile(
      filePath,
      JSON.stringify(
        {
          id: "claim-keys.store.invalid",
          kind: "store",
          sandbox: {
            reset: false,
          },
          input: {
            entries: [
              {
                type: "fact",
                subject: "Invalid",
                content: "This is a valid content body for validation.",
              },
            ],
          },
          expect: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(loadClaimKeyScenarioFile(filePath, tempRoot)).rejects.toThrow(/sandbox\.reset=false/iu);
  });

  it("runs real store, ingest, and surgeon scenarios end to end", async () => {
    const summary = await runClaimKeyScenariosRuntime({
      ids: ["claim-keys.store.manual-key-trusted", "claim-keys.ingest.explicit-tool-key-preserved", "claim-keys.surgeon.malformed-key-normalized"],
    });

    expect(summary.matchedCount).toBe(3);
    expect(summary.passedCount).toBe(3);
    expect(summary.failedCount).toBe(0);
    expect(summary.results.every((result) => result.status === "passed")).toBe(true);

    await expect(access(path.join(summary.artifactRoot, "claim-keys.store.manual-key-trusted", "actual.json"))).resolves.toBeUndefined();
    await expect(access(path.join(summary.artifactRoot, "claim-keys.store.manual-key-trusted", "sandbox"))).rejects.toBeDefined();
  });

  it("runs the full repo-local scenario corpus successfully", async () => {
    const summary = await runClaimKeyScenariosRuntime();

    expect(summary.matchedCount).toBe(10);
    expect(summary.passedCount).toBe(10);
    expect(summary.failedCount).toBe(0);
  });

  it("runs the Wave 2 scenario set end to end and writes surgeon artifacts", async () => {
    const summary = await runClaimKeyScenariosRuntime({
      ids: [...WAVE_TWO_SCENARIO_IDS],
    });

    expect(summary.matchedCount).toBe(3);
    expect(summary.passedCount).toBe(3);
    expect(summary.failedCount).toBe(0);

    const ingestActual = JSON.parse(
      await readFile(path.join(summary.artifactRoot, "claim-keys.ingest.ambiguous-narrative-abstains", "actual.json"), "utf8"),
    ) as {
      rowCount: {
        entriesWithClaimKey: number;
      };
    };
    const proposals = JSON.parse(
      await readFile(path.join(summary.artifactRoot, "claim-keys.surgeon.ambiguous-family-proposal", "proposals.json"), "utf8"),
    ) as Array<{
      eligibleForApply: boolean;
      issueKind: string;
    }>;
    const surgeonSummary = JSON.parse(
      await readFile(path.join(summary.artifactRoot, "claim-keys.surgeon.missing-key-backfill-high-confidence", "surgeon-summary.json"), "utf8"),
    ) as {
      summary: {
        counts: {
          appliedBackfills: number;
          identifiedBackfills: number;
        };
      };
    };

    expect(ingestActual.rowCount.entriesWithClaimKey).toBe(0);
    expect(proposals).toEqual([
      expect.objectContaining({
        eligibleForApply: false,
        issueKind: "mixed_claim_key_group",
      }),
    ]);
    expect(surgeonSummary.summary.counts.identifiedBackfills).toBe(1);
    expect(surgeonSummary.summary.counts.appliedBackfills).toBe(1);
  });

  it("runs the Wave 3 scenario set end to end and writes store artifacts", async () => {
    const summary = await runClaimKeyScenariosRuntime({
      ids: [...WAVE_THREE_SCENARIO_IDS],
    });

    expect(summary.matchedCount).toBe(3);
    expect(summary.passedCount).toBe(3);
    expect(summary.failedCount).toBe(0);

    const ingestActual = JSON.parse(await readFile(path.join(summary.artifactRoot, "claim-keys.ingest.clear-slot-inferred", "actual.json"), "utf8")) as {
      rows: Array<{
        claim_key: string | null;
        claim_key_status: string | null;
        claim_support_locator: string | null;
        claim_support_mode: string | null;
        claim_support_source_kind: string | null;
        subject: string;
      }>;
    };
    const trustedStoreResult = JSON.parse(
      await readFile(path.join(summary.artifactRoot, "claim-keys.store.extracted-model-key-trusted", "store-result.json"), "utf8"),
    ) as {
      rejected: number;
      skipped: number;
      stored: number;
    };
    const repairActual = JSON.parse(
      await readFile(path.join(summary.artifactRoot, "claim-keys.store.deterministic-repair-tentative", "actual.json"), "utf8"),
    ) as {
      rows: Array<{
        claim_key_source: string | null;
        claim_key_status: string | null;
        subject: string;
      }>;
    };

    expect(ingestActual.rows).toContainEqual(
      expect.objectContaining({
        claim_key: "jim/timezone",
        claim_key_status: "trusted",
        claim_support_mode: "inferred",
        claim_support_source_kind: "transcript_ingest",
        subject: "Jim timezone",
      }),
    );
    expect(ingestActual.rows[0]?.claim_support_locator).toContain("#observed_at:");
    expect(trustedStoreResult).toEqual({
      stored: 1,
      skipped: 0,
      rejected: 0,
    });
    expect(repairActual.rows).toContainEqual(
      expect.objectContaining({
        claim_key_source: "deterministic_repair",
        claim_key_status: "tentative",
        subject: "Jim's timezone",
      }),
    );
  });

  it("preserves failed sandboxes and writes actual plus diff artifacts", async () => {
    const tempRoot = await createScenarioRoot("claim-key-failure-");
    const scenarioPath = path.join(tempRoot, "store", "manual-key-trusted.json");

    await writeFile(
      scenarioPath,
      JSON.stringify(
        {
          id: "claim-keys.store.manual-key-trusted",
          kind: "store",
          sandbox: {
            reset: true,
            preserveOnFailure: true,
          },
          input: {
            entries: [
              {
                type: "fact",
                subject: "Jim timezone",
                content: "Jim's timezone is America/Chicago.",
                claim_key: "jim/timezone",
              },
            ],
          },
          expect: {
            rows: [
              {
                match: {
                  subject: "Jim timezone",
                },
                assert: {
                  claim_key: "jim/home_city",
                },
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const summary = await runClaimKeyScenariosRuntime({
      rootDir: tempRoot,
      ids: ["claim-keys.store.manual-key-trusted"],
    });

    const result = summary.results[0];
    expect(result?.status).toBe("failed");
    expect(result?.preservedSandboxPath).toBeDefined();

    const actual = JSON.parse(await readFile(path.join(summary.artifactRoot, "claim-keys.store.manual-key-trusted", "actual.json"), "utf8")) as {
      rows: Array<{ claim_key?: string }>;
    };
    const diff = JSON.parse(await readFile(path.join(summary.artifactRoot, "claim-keys.store.manual-key-trusted", "diff.json"), "utf8")) as {
      diffSummary: string[];
    };

    expect(actual.rows[0]?.claim_key).toBe("jim/timezone");
    expect(diff.diffSummary[0]).toContain("claim_key");
    await expect(access(result?.preservedSandboxPath ?? "")).resolves.toBeUndefined();
  });
});

async function createScenarioRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(root);

  await Promise.all([
    mkdir(path.join(root, "ingest"), { recursive: true }),
    mkdir(path.join(root, "store"), { recursive: true }),
    mkdir(path.join(root, "surgeon"), { recursive: true }),
    mkdir(path.join(root, "fixtures"), { recursive: true }),
  ]);

  return root;
}

describe("default scenario root", () => {
  it("points at the repo-local claim-key scenario directory", () => {
    expect(getDefaultClaimKeyScenarioRoot()).toBe(path.resolve("tests/scenarios/claim-keys"));
  });

  it("resolves the repo-local scenario directory from the bundled cli output path", () => {
    const bundledCliUrl = pathToFileURL(path.resolve("dist/cli.js")).href;

    expect(
      getDefaultClaimKeyScenarioRoot({
        cwd: "/",
        moduleUrl: bundledCliUrl,
      }),
    ).toBe(path.resolve("tests/scenarios/claim-keys"));
  });
});
