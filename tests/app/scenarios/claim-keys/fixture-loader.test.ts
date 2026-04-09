import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadClaimExtractionFixtureResponses,
  loadExtractionFixtureResponses,
  loadSeedFixtureEntries,
} from "../../../../src/app/scenarios/claim-keys/fixture-loader.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("claim-key scenario fixture loader", () => {
  it("loads typed seed fixture entries", async () => {
    const root = await createScenarioRoot();
    const relativePath = "fixtures/seed.json";

    await writeJsonFixture(root, relativePath, [
      {
        type: "fact",
        subject: "Jim timezone",
        content: "Jim uses America/Chicago.",
        claim_key: "jim/timezone",
      },
    ]);

    await expect(loadSeedFixtureEntries(root, relativePath)).resolves.toEqual([
      expect.objectContaining({
        type: "fact",
        subject: "Jim timezone",
        content: "Jim uses America/Chicago.",
        claim_key: "jim/timezone",
      }),
    ]);
  });

  it("loads parsed extraction fixtures and rejects parser warnings", async () => {
    const root = await createScenarioRoot();
    const validPath = "fixtures/extraction-valid.json";
    const invalidPath = "fixtures/extraction-invalid.json";

    await writeJsonFixture(root, validPath, [
      {
        entries: [
          {
            type: "fact",
            subject: "Jim timezone",
            content: "Jim's timezone is America/Chicago.",
            importance: 7,
            expiry: "permanent",
          },
        ],
      },
    ]);
    await writeJsonFixture(root, invalidPath, [
      {
        entries: [
          {
            type: "fact",
            subject: "Jim timezone",
            content: "Jim's timezone is America/Chicago.",
            unsupported: true,
          },
        ],
      },
    ]);

    await expect(loadExtractionFixtureResponses(root, validPath)).resolves.toEqual([
      {
        entries: [
          expect.objectContaining({
            content: "Jim's timezone is America/Chicago.",
            expiry: "permanent",
            importance: 7,
            subject: "Jim timezone",
            type: "fact",
          }),
        ],
      },
    ]);
    await expect(loadExtractionFixtureResponses(root, invalidPath)).rejects.toThrow(/unsupported field "unsupported"/i);
  });

  it("loads typed claim-extraction fixtures and rejects malformed responses", async () => {
    const root = await createScenarioRoot();
    const validPath = "fixtures/claim-valid.json";
    const invalidPath = "fixtures/claim-invalid.json";

    await writeJsonFixture(root, validPath, [
      {
        entity: "Jim",
        attribute: "timezone",
        confidence: 0.95,
      },
      {
        __error: "preview failure forces deterministic repair",
      },
    ]);
    await writeJsonFixture(root, invalidPath, [
      {
        entity: "Jim",
      },
    ]);

    await expect(loadClaimExtractionFixtureResponses(root, validPath)).resolves.toEqual([
      {
        entity: "Jim",
        attribute: "timezone",
        confidence: 0.95,
      },
      {
        __error: "preview failure forces deterministic repair",
      },
    ]);
    await expect(loadClaimExtractionFixtureResponses(root, invalidPath)).rejects.toThrow(/entity, attribute, and confidence/i);
  });
});

async function createScenarioRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claim-key-fixtures-"));
  tempDirectories.push(root);
  await mkdir(path.join(root, "fixtures"), { recursive: true });
  return root;
}

async function writeJsonFixture(root: string, relativePath: string, value: unknown): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
