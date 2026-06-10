import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  createLlmClient: vi.fn(),
  resolveLlmCredentials: vi.fn(),
}));

vi.mock("../../../src/adapters/llm.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/adapters/llm.js")>();
  return {
    ...actual,
    createLlmClient: llmMocks.createLlmClient,
    resolveLlmCredentials: llmMocks.resolveLlmCredentials,
  };
});

import { createDatabase } from "../../../src/adapters/db/client.js";
import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { loadDreamActionViewsRuntime, loadDreamStatusRuntime, reviewDreamProposalRuntime, runDreamRuntime } from "../../../src/app/dreaming/runtime.js";
import { computeContentHash, computeNormContentHash } from "../../../src/core/store/hashing.js";
import type { LlmPort } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";

class RuntimeExtractLlm implements LlmPort {
  public readonly metadata = { usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } };

  public constructor(
    private readonly durables: Array<Record<string, unknown>>,
    private readonly costPerCall = 0,
  ) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used by the runtime extract stage.");
  }

  public async completeJson<T>(): Promise<T> {
    this.metadata.usage.inputTokens += 1;
    this.metadata.usage.totalCost += this.costPerCall;
    return { durables: this.durables } as T;
  }
}

const tempDirs: string[] = [];
const originalConfigPath = process.env.AGENR_CONFIG_PATH;
const originalDbPath = process.env.AGENR_DB_PATH;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENR_CONFIG_PATH;
  delete process.env.AGENR_DB_PATH;
});

afterEach(async () => {
  restoreEnv("AGENR_CONFIG_PATH", originalConfigPath);
  restoreEnv("AGENR_DB_PATH", originalDbPath);
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("runDreamRuntime", () => {
  it("wires the extract LLM from the dreaming model config", async () => {
    const { configPath, dbPath } = await createRuntimeFixture({
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
        dreaming: {
          dailyCostCap: 5,
          model: {
            provider: "anthropic",
            model: "claude-dream",
          },
        },
      },
    });
    await insertEpisode(dbPath, "ep-1", "Session recording a durable runtime wiring preference.");

    const llm = new RuntimeExtractLlm(
      [{ type: "fact", subject: "Runtime wiring", content: "Dreaming runtime uses the configured model.", claim_key: "agenr/runtime_wiring" }],
      0.12,
    );
    const env = { AGENR_CONFIG_PATH: configPath, ANTHROPIC_API_KEY: "env-anthropic-key" };
    llmMocks.resolveLlmCredentials.mockReturnValue({ apiKey: "resolved-anthropic-key", source: "test-env" });
    llmMocks.createLlmClient.mockReturnValue(llm);

    const result = await runDreamRuntime({ tier: "standard", apply: false, verbose: false, json: false, env });

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.extract?.candidatesEmitted).toBe(1);
    expect(result.estimatedCostUsd).toBe(0.12);
    expect(llmMocks.resolveLlmCredentials).toHaveBeenCalledWith(expect.objectContaining({ dbPath }), "anthropic", env);
    expect(llmMocks.createLlmClient).toHaveBeenCalledWith("anthropic", "claude-dream", { apiKey: "resolved-anthropic-key" });
  });
});

describe("loadDreamStatusRuntime", () => {
  it("uses the supplied env config path without mutating env state", async () => {
    const { configPath, dbPath, directory } = await createRuntimeFixture({
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
      },
    });
    await initializeDatabase(dbPath);
    const invalidConfigPath = path.join(directory, "invalid-config.json");
    await writeFile(invalidConfigPath, "{not valid json", "utf8");
    process.env.AGENR_CONFIG_PATH = invalidConfigPath;

    const env = { AGENR_CONFIG_PATH: configPath };
    const envBefore = { ...env };

    const status = await loadDreamStatusRuntime({ env });

    expect(status.health.total).toBe(0);
    expect(env).toEqual(envBefore);
    expect(process.env.AGENR_CONFIG_PATH).toBe(invalidConfigPath);
  });
});

describe("loadDreamActionViewsRuntime", () => {
  it("hydrates affected durables that were staled later in the same run", async () => {
    const { configPath, dbPath } = await createRuntimeFixture({
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
      },
    });
    let runId: string | undefined;
    const database = await createDatabase(dbPath);
    try {
      const port = createDreamPort(database);
      const content = "Temporary dreamed rows can be staled after insertion.";
      await database.insertDurable(
        buildRuntimeDurable({
          id: "dreamed-temporary",
          subject: "temporary dreamed row",
          content,
          valid_to: "2026-04-04T12:00:00.000Z",
          supersession_kind: "stale",
          supersession_reason: "Dream prune staled a temporary durable after synthesis.",
        }),
        [],
        computeContentHash(content, "episode:ep-1"),
      );
      runId = await port.createRun({ tier: "deep", dryRun: false, startedAt: "2026-04-04T10:00:00.000Z" });
      await port.logRunAction({
        id: "action-insert-staled",
        runId,
        actionType: "insert_durable",
        durableIds: ["dreamed-temporary"],
        reasoning: "Inserted durable mined from episode evidence.",
        details: { claim_key: "agenr/temporary_dreamed_row" },
        createdAt: "2026-04-04T10:30:00.000Z",
      });
    } finally {
      await database.close();
    }

    const [action] = await loadDreamActionViewsRuntime({
      runId: requireRunId(runId),
      env: { AGENR_CONFIG_PATH: configPath },
    });

    expect(action?.durables).toHaveLength(1);
    expect(action?.durables[0]?.id).toBe("dreamed-temporary");
    expect(action?.durables[0]?.valid_to).toBe("2026-04-04T12:00:00.000Z");
  });
});

describe("reviewDreamProposalRuntime", () => {
  it("applies a duplicate-slot-collapse proposal through the supersession path", async () => {
    const { configPath, dbPath } = await createRuntimeFixture({
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
      },
    });
    let runId: string | undefined;
    const database = await createDatabase(dbPath);
    try {
      const port = createDreamPort(database);
      for (const [id, createdAt] of [
        ["collapse-old", "2026-01-01T00:00:00.000Z"],
        ["collapse-new", "2026-02-01T00:00:00.000Z"],
      ] as const) {
        await database.insertDurable(
          buildRuntimeDurable({
            id,
            subject: `Default shell ${id}`,
            content: `Default shell content ${id}`,
            claim_key: "mac_mini/default_shell",
            claim_key_status: "trusted",
            created_at: createdAt,
            valid_to: undefined,
            supersession_kind: undefined,
            supersession_reason: undefined,
            expiry: "permanent",
          }),
          [],
          computeContentHash(`Default shell content ${id}`, "episode:ep-1"),
        );
      }
      runId = await port.createRun({ tier: "deep", dryRun: false });
      await port.logRunProposal({
        id: "proposal-collapse",
        runId,
        groupId: "claim-key-duplicate-slot:mac_mini/default_shell",
        issueKind: "duplicate_slot_collapse",
        scope: "cluster",
        durableIds: ["collapse-new", "collapse-old"],
        currentClaimKeys: ["mac_mini/default_shell"],
        proposedClaimKeys: ["mac_mini/default_shell"],
        rationale: "Exclusive slot holds two active durables.",
        confidence: 0.9,
        source: "duplicate_slot_collapse",
        eligibleForApply: true,
        createdAt: "2026-04-04T12:00:00.000Z",
        reviewStatus: "open",
        reviewedAt: null,
        reviewReason: null,
        appliedActionCount: 0,
      });
    } finally {
      await database.close();
    }

    const result = await reviewDreamProposalRuntime({
      proposalId: "proposal-collapse",
      decision: "apply",
      reason: "Operator confirmed the collapse.",
      env: { AGENR_CONFIG_PATH: configPath },
    });

    expect(result.proposal.reviewStatus).toBe("applied");
    expect(result.updatedDurableIds).toEqual(["collapse-old"]);

    const verifyDatabase = await createDatabase(dbPath);
    try {
      const rows = await verifyDatabase.execute({
        sql: "SELECT id, superseded_by, supersession_kind FROM durables ORDER BY id ASC",
        args: [],
      });
      expect(rows.rows).toEqual([
        expect.objectContaining({ id: "collapse-new", superseded_by: null }),
        expect.objectContaining({ id: "collapse-old", superseded_by: "collapse-new", supersession_kind: "duplicate_collapse" }),
      ]);

      const actions = await createDreamPort(verifyDatabase).getRunActions(requireRunId(runId));
      const mergeActions = actions.filter((action) => action.actionType === "merge");
      expect(mergeActions).toHaveLength(1);
      expect(mergeActions[0]?.durableIds).toEqual(["collapse-old", "collapse-new"]);
    } finally {
      await verifyDatabase.close();
    }
  });
});

async function createRuntimeFixture(input: { config: Record<string, unknown> }): Promise<{ directory: string; configPath: string; dbPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-dream-runtime-"));
  tempDirs.push(directory);
  const dbPath = path.join(directory, "knowledge.db");
  const configPath = path.join(directory, "config.json");
  await writeRuntimeConfig(configPath, { ...input.config, dbPath });
  return { directory, configPath, dbPath };
}

async function writeRuntimeConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function initializeDatabase(dbPath: string): Promise<void> {
  const database = await createDatabase(dbPath);
  await database.close();
}

async function insertEpisode(dbPath: string, id: string, summary: string): Promise<void> {
  const database = await createDatabase(dbPath);
  try {
    await database.execute({
      sql: `
        INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, created_at, updated_at)
        VALUES (?, 'openclaw', ?, '2026-04-04T10:00:00.000Z', '2026-04-04T11:00:00.000Z', ?, '2026-04-04T11:00:00.000Z', '2026-04-04T11:00:00.000Z')
      `,
      args: [id, `session-${id}`, summary],
    });
  } finally {
    await database.close();
  }
}

function buildRuntimeDurable(overrides: Pick<Durable, "id" | "subject" | "content"> & Partial<Durable>): Durable {
  const sourceFile = overrides.source_file ?? "episode:ep-1";
  return {
    id: overrides.id,
    type: overrides.type ?? "fact",
    subject: overrides.subject,
    content: overrides.content,
    importance: overrides.importance ?? 5,
    expiry: overrides.expiry ?? "temporary",
    tags: overrides.tags ?? [],
    source_file: sourceFile,
    source_context: overrides.source_context,
    embedding: undefined,
    content_hash: overrides.content_hash ?? computeContentHash(overrides.content, sourceFile),
    norm_content_hash: overrides.norm_content_hash ?? computeNormContentHash(overrides.content),
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    directive_polarity: overrides.directive_polarity,
    directive_trigger: overrides.directive_trigger,
    claim_key: overrides.claim_key,
    claim_key_raw: overrides.claim_key_raw,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_key_confidence: overrides.claim_key_confidence,
    claim_key_rationale: overrides.claim_key_rationale,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    user_id: overrides.user_id,
    project: overrides.project,
    created_at: overrides.created_at ?? "2026-04-04T10:30:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-04T10:30:00.000Z",
  };
}

function requireRunId(runId: string | undefined): string {
  if (!runId) {
    throw new Error("Expected test fixture to create a dreaming run.");
  }
  return runId;
}

function restoreEnv(key: "AGENR_CONFIG_PATH" | "AGENR_DB_PATH", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
