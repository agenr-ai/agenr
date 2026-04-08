import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultClaimKeyScenarioRoot,
  listClaimKeyScenariosRuntime,
  loadClaimKeyScenarioFile,
  runClaimKeyScenariosRuntime,
} from "../../../../src/app/scenarios/claim-keys/index.js";

const tempDirectories: string[] = [];

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
});
