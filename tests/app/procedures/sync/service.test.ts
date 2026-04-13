import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../../src/adapters/db/client.js";
import { executeProcedureSync, prepareProcedureSync, type ProcedureFilePort, type ProcedureSyncPlan } from "../../../../src/app/procedures/sync/index.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../../src/core/procedures/hashing.js";
import { parseAndNormalizeProcedureYaml } from "../../../../src/core/procedures/normalization.js";
import { composeProcedureRecallText } from "../../../../src/core/procedures/recall-text.js";
import type { Procedure } from "../../../../src/core/types.js";

describe("procedure sync service", () => {
  const databases: SqlDatabase[] = [];
  const databasePaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();

    while (databases.length > 0) {
      await databases.pop()?.close();
    }

    while (databasePaths.length > 0) {
      await rm(databasePaths.pop() ?? "", { force: true });
    }
  });

  it("classifies create, update_source_only, supersede, unchanged, and invalid files", async () => {
    const database = await createTestDatabase();
    const releasePath = "/repo/procedures/agenr-release.yaml";
    const sandboxPath = "/repo/procedures/agenr-sandbox-validation.yaml";
    const openclawPath = "/repo/procedures/agenr-openclaw-local-plugin-check.yaml";
    const surgeonPath = "/repo/procedures/agenr-surgeon-review.yaml";
    const invalidPath = "/repo/procedures/invalid.yaml";
    const releaseYaml = buildProcedureYaml({
      procedureKey: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Ship a release safely.",
    });
    const releaseReformattedYaml = buildProcedureYaml(
      {
        procedureKey: "agenr/release",
        title: "Release agenr and publish packages",
        goal: "Ship a release safely.",
      },
      { reformat: true },
    );
    const sandboxYaml = buildProcedureYaml({
      procedureKey: "agenr/sandbox-validation",
      title: "Validate agenr changes against the local sandbox",
      goal: "Run sandbox validation safely.",
    });
    const openclawOldYaml = buildProcedureYaml({
      procedureKey: "agenr/openclaw-local-plugin-check",
      title: "Check the local OpenClaw plugin build",
      goal: "Verify the local plugin build.",
    });
    const openclawNewYaml = buildProcedureYaml({
      procedureKey: "agenr/openclaw-local-plugin-check",
      title: "Check the local OpenClaw plugin build",
      goal: "Verify the local plugin build and gateway tool registration.",
    });
    const surgeonYaml = buildProcedureYaml({
      procedureKey: "agenr/surgeon-review",
      title: "Review surgeon proposals and apply or reject them safely",
      goal: "Review one surgeon proposal.",
    });

    await database.upsertProcedure(createStoredProcedureFromYaml(releaseYaml, releasePath, { id: "procedure-release" }));
    await database.upsertProcedure(createStoredProcedureFromYaml(sandboxYaml, sandboxPath, { id: "procedure-sandbox" }));
    await database.upsertProcedure(createStoredProcedureFromYaml(openclawOldYaml, openclawPath, { id: "procedure-openclaw" }));

    const filePort = createMockFilePort({
      [releasePath]: releaseReformattedYaml,
      [sandboxPath]: sandboxYaml,
      [openclawPath]: openclawNewYaml,
      [surgeonPath]: surgeonYaml,
      [invalidPath]: "procedure_key: agenr/invalid\nsteps:\n  - nope\n",
    });
    const plan = await prepareProcedureSync("/repo/procedures", {
      files: filePort,
      db: database,
    });

    expect(plan.totals).toEqual({
      discovered: 5,
      create: 1,
      updateSourceOnly: 1,
      supersede: 1,
      unchanged: 1,
      invalid: 1,
    });
    expect(plan.items.map((item) => item.action)).toEqual(["update_source_only", "unchanged", "supersede", "create", "invalid"]);
  });

  it("marks duplicate procedure keys as invalid before DB classification", async () => {
    const duplicatePathA = "/repo/procedures/a.yaml";
    const duplicatePathB = "/repo/procedures/b.yaml";
    const duplicateYaml = buildProcedureYaml({
      procedureKey: "agenr/release",
      title: "Release agenr",
      goal: "Ship a release.",
    });
    const findActiveProcedureByKey = vi.fn(async () => null);
    const plan = await prepareProcedureSync("/repo/procedures", {
      files: createMockFilePort({
        [duplicatePathA]: duplicateYaml,
        [duplicatePathB]: duplicateYaml,
      }),
      db: {
        findActiveProcedureByKey,
      } as never,
    });

    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((item) => item.action === "invalid")).toBe(true);
    expect(findActiveProcedureByKey).not.toHaveBeenCalled();
  });

  it("executes source updates and supersessions against the real database", async () => {
    const database = await createTestDatabase();
    const releasePath = "/repo/procedures/agenr-release.yaml";
    const sandboxPath = "/repo/procedures/agenr-sandbox-validation.yaml";
    const openclawPath = "/repo/procedures/agenr-openclaw-local-plugin-check.yaml";
    const surgeonPath = "/repo/procedures/agenr-surgeon-review.yaml";
    const releaseYaml = buildProcedureYaml({
      procedureKey: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Ship a release safely.",
    });
    const releaseReformattedYaml = buildProcedureYaml(
      {
        procedureKey: "agenr/release",
        title: "Release agenr and publish packages",
        goal: "Ship a release safely.",
      },
      { reformat: true },
    );
    const sandboxYaml = buildProcedureYaml({
      procedureKey: "agenr/sandbox-validation",
      title: "Validate agenr changes against the local sandbox",
      goal: "Run sandbox validation safely.",
    });
    const openclawOldYaml = buildProcedureYaml({
      procedureKey: "agenr/openclaw-local-plugin-check",
      title: "Check the local OpenClaw plugin build",
      goal: "Verify the local plugin build.",
    });
    const openclawNewYaml = buildProcedureYaml({
      procedureKey: "agenr/openclaw-local-plugin-check",
      title: "Check the local OpenClaw plugin build",
      goal: "Verify the local plugin build and gateway tool registration.",
    });
    const surgeonYaml = buildProcedureYaml({
      procedureKey: "agenr/surgeon-review",
      title: "Review surgeon proposals and apply or reject them safely",
      goal: "Review one surgeon proposal.",
    });

    const releaseStored = await database.upsertProcedure(createStoredProcedureFromYaml(releaseYaml, releasePath, { id: "procedure-release" }));
    const sandboxStored = await database.upsertProcedure(createStoredProcedureFromYaml(sandboxYaml, sandboxPath, { id: "procedure-sandbox" }));
    const openclawStored = await database.upsertProcedure(createStoredProcedureFromYaml(openclawOldYaml, openclawPath, { id: "procedure-openclaw" }));

    const plan = await prepareProcedureSync("/repo/procedures", {
      files: createMockFilePort({
        [releasePath]: releaseReformattedYaml,
        [sandboxPath]: sandboxYaml,
        [openclawPath]: openclawNewYaml,
        [surgeonPath]: surgeonYaml,
      }),
      db: database,
    });
    const embed = vi.fn(async (texts: string[]) => texts.map((_text, index) => createEmbedding(index, 1)));
    const execution = await executeProcedureSync(plan, {
      db: database,
      embedding: { embed },
    });

    expect(execution.totals).toEqual({
      created: 1,
      updatedSourceOnly: 1,
      superseded: 1,
      unchanged: 1,
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]?.[0]).toHaveLength(2);

    const releaseActive = await database.findActiveProcedureByKey("agenr/release");
    const sandboxActive = await database.findActiveProcedureByKey("agenr/sandbox-validation");
    const openclawActive = await database.findActiveProcedureByKey("agenr/openclaw-local-plugin-check");
    const surgeonActive = await database.findActiveProcedureByKey("agenr/surgeon-review");

    expect(releaseActive?.id).toBe(releaseStored.id);
    expect(sandboxActive?.id).toBe(sandboxStored.id);
    expect(openclawActive?.id).not.toBe(openclawStored.id);
    expect(surgeonActive?.id).toBeDefined();

    const releaseRow = await database.execute({
      sql: "SELECT source_hash, updated_at FROM procedures WHERE id = ?",
      args: [releaseStored.id],
    });
    expect(releaseRow.rows[0]?.source_hash).toBe(computeProcedureSourceHash(releaseReformattedYaml));
    expect(releaseRow.rows[0]?.updated_at).not.toBe(releaseStored.updated_at);

    const openclawOldRow = await database.execute({
      sql: "SELECT superseded_by FROM procedures WHERE id = ?",
      args: [openclawStored.id],
    });
    expect(openclawOldRow.rows[0]?.superseded_by).toBe(openclawActive?.id);

    const activeCount = await database.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM procedures
        WHERE procedure_key = ?
          AND retired = 0
          AND superseded_by IS NULL
      `,
      args: ["agenr/openclaw-local-plugin-check"],
    });
    expect(Number(activeCount.rows[0]?.count ?? 0)).toBe(1);
  });

  it("rejects invalid plans before execution starts", async () => {
    const withTransaction = vi.fn();
    const embed = vi.fn();
    const invalidPlan: ProcedureSyncPlan = {
      targetPath: "/repo/procedures",
      files: ["/repo/procedures/invalid.yaml"],
      items: [
        {
          action: "invalid",
          filePath: "/repo/procedures/invalid.yaml",
          error: "Invalid procedure root",
        },
      ],
      totals: {
        discovered: 1,
        create: 0,
        updateSourceOnly: 0,
        supersede: 0,
        unchanged: 0,
        invalid: 1,
      },
    };

    await expect(
      executeProcedureSync(invalidPlan, {
        db: {
          withTransaction,
        } as never,
        embedding: {
          embed,
        },
      }),
    ).rejects.toThrow(/invalid file/i);
    expect(embed).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  async function createTestDatabase(): Promise<SqlDatabase> {
    const databasePath = path.join(os.tmpdir(), `agenr-procedure-sync-${randomUUID()}.sqlite`);
    databasePaths.push(databasePath);

    const database = await createDatabase(databasePath);
    databases.push(database);
    return database;
  }
});

/**
 * Creates one mock procedure file port from an absolute-path source map.
 *
 * @param files - Raw file contents keyed by absolute path.
 * @returns Mock procedure file port.
 */
function createMockFilePort(files: Record<string, string>): ProcedureFilePort {
  const orderedFiles = Object.keys(files);
  return {
    discoverFiles: async () => orderedFiles,
    readFile: async (filePath: string) => {
      const source = files[filePath];
      if (!source) {
        throw new Error(`Missing mock procedure file ${filePath}`);
      }

      return source;
    },
  };
}

/**
 * Builds one stored procedure row from authored YAML source.
 *
 * @param yaml - Raw authored YAML.
 * @param filePath - Source file path used for normalization and provenance.
 * @param overrides - Optional stored-row overrides.
 * @returns Canonical stored procedure payload.
 */
function createStoredProcedureFromYaml(yaml: string, filePath: string, overrides: Partial<Procedure> = {}): Procedure {
  const procedure = parseAndNormalizeProcedureYaml(yaml, filePath);
  const now = overrides.created_at ?? "2026-04-13T12:00:00.000Z";
  return {
    id: overrides.id ?? randomUUID(),
    ...procedure,
    recall_text: composeProcedureRecallText(procedure),
    revision_hash: computeProcedureRevisionHash(procedure),
    source_hash: computeProcedureSourceHash(yaml),
    source_file: filePath,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    superseded_by: overrides.superseded_by,
    created_at: now,
    updated_at: overrides.updated_at ?? now,
  };
}

/**
 * Builds one minimal valid procedure YAML document.
 *
 * @param params - Key fields to vary across tests.
 * @param options - Optional formatting variant.
 * @returns Authored YAML string.
 */
function buildProcedureYaml(
  params: {
    procedureKey: string;
    title: string;
    goal: string;
  },
  options: {
    reformat?: boolean;
  } = {},
): string {
  if (options.reformat) {
    return `
procedure_key: "${params.procedureKey}"
title: " ${params.title} "
goal: " ${params.goal} "
steps:
  - id: read-reference
    kind: read_reference
    instruction: "Read the reference."
    ref: { kind: doc, path: README.md }
verification: [Procedure completed.]
failure_modes: [Procedure failed.]
sources:
  - { kind: doc, path: README.md }
`;
  }

  return [
    `procedure_key: ${params.procedureKey}`,
    `title: ${params.title}`,
    `goal: ${params.goal}`,
    "steps:",
    "  - id: read-reference",
    "    kind: read_reference",
    "    instruction: Read the reference.",
    "    ref:",
    "      kind: doc",
    "      path: README.md",
    "verification:",
    "  - Procedure completed.",
    "failure_modes:",
    "  - Procedure failed.",
    "sources:",
    "  - kind: doc",
    "    path: README.md",
    "",
  ].join("\n");
}

/**
 * Creates a deterministic dense embedding with one emphasized coordinate.
 *
 * @param offset - Coordinate offset to emphasize.
 * @param value - Value written at the emphasized coordinate.
 * @returns Fixed-length embedding vector.
 */
function createEmbedding(offset: number, value: number): number[] {
  const embedding = new Array<number>(1024).fill(0);
  embedding[offset] = value;
  return embedding;
}
