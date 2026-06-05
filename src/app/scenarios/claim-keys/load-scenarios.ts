import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ClaimKeyScenario } from "./types.js";
import { readExpectations } from "./validation/expectations.js";
import { readDreamingInput, readIngestInput, readSandboxConfig, readScenarioKind, readScenarioRoot, readSetup, readStoreInput } from "./validation/input.js";
import { getDefaultClaimKeyScenarioRoot } from "./validation/scenario-root.js";
import { readOptionalNotes, readOptionalString, readOptionalStringArray, readRequiredString } from "./validation/shared.js";

const SUPPORTED_KINDS = ["ingest", "store", "dreaming"] as const;

/**
 * Returns the default repo-local claim-key scenario root.
 *
 * @param options - Optional cwd and module URL overrides used by tests.
 * @returns Absolute path to the default scenario directory.
 */
export { getDefaultClaimKeyScenarioRoot } from "./validation/scenario-root.js";

/**
 * Discovers, parses, and validates all claim-key scenario files under one root.
 *
 * @param rootDir - Root directory containing `ingest`, `store`, and `dreaming` subdirectories.
 * @returns Sorted loaded scenarios ready for listing or execution.
 */
export async function loadClaimKeyScenarios(rootDir = getDefaultClaimKeyScenarioRoot()): Promise<ClaimKeyScenario[]> {
  const discoveredFiles = await discoverScenarioFiles(rootDir);
  const loaded = await Promise.all(discoveredFiles.map((filePath) => loadClaimKeyScenarioFile(filePath, rootDir)));
  return loaded.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Loads one scenario file and validates it into the canonical runtime shape.
 *
 * @param filePath - Absolute path to the scenario JSON file.
 * @param rootDir - Scenario root used for relative fixture resolution checks.
 * @returns Validated scenario object.
 */
export async function loadClaimKeyScenarioFile(filePath: string, rootDir = getDefaultClaimKeyScenarioRoot()): Promise<ClaimKeyScenario> {
  const raw = await readScenarioJsonFile(filePath);
  return validateClaimKeyScenario(raw, filePath, rootDir);
}

/**
 * Validates one raw scenario JSON payload.
 *
 * @param input - Raw parsed JSON value.
 * @param filePath - Source file path used in validation messages.
 * @param rootDir - Scenario root used for relative fixture resolution checks.
 * @returns Canonical validated scenario object.
 */
export function validateClaimKeyScenario(input: unknown, filePath: string, rootDir = getDefaultClaimKeyScenarioRoot()): ClaimKeyScenario {
  const record = readScenarioRoot(input, filePath);
  const id = readRequiredString(record.id, "id", filePath);
  const kind = readScenarioKind(record.kind, filePath);
  const expect = readExpectations(record.expect, filePath);
  const sandbox = readSandboxConfig(record.sandbox, filePath);
  const setup = readSetup(record.setup, filePath, rootDir);
  const description = readOptionalString(record.description, "description", filePath);
  const tags = readOptionalStringArray(record.tags, "tags", filePath);
  const notes = readOptionalNotes(record.notes, filePath);

  if (id !== id.toLowerCase()) {
    throw new Error(`Invalid scenario ${filePath}: id must be lowercase.`);
  }

  const base = {
    id,
    kind,
    filePath,
    expect,
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(setup ? { setup } : {}),
    ...(notes ? { notes } : {}),
  };

  switch (kind) {
    case "ingest":
      return {
        ...base,
        kind,
        input: readIngestInput(record.input, filePath, rootDir),
      };
    case "store":
      return {
        ...base,
        kind,
        input: readStoreInput(record.input, filePath, rootDir),
      };
    case "dreaming":
      return {
        ...base,
        kind,
        input: readDreamingInput(record.input, filePath, rootDir),
      };
  }
}

/**
 * Discovers all scenario JSON files under the supported kind directories.
 *
 * @param rootDir - Scenario root to scan.
 * @returns Absolute file paths for all discovered scenario files.
 */
async function discoverScenarioFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  for (const kind of SUPPORTED_KINDS) {
    const directory = path.join(rootDir, kind);
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      files.push(path.join(directory, entry.name));
    }
  }

  return files.sort();
}

/**
 * Reads one scenario JSON file with contextual parse failures.
 *
 * @param filePath - Absolute scenario file path.
 * @returns Parsed raw JSON payload.
 */
async function readScenarioJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid scenario ${filePath}: JSON parse failed - ${message}`, {
      cause: error,
    });
  }
}
