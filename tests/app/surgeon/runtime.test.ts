import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../../src/adapters/db/client.js";
import { createSurgeonRun, getSurgeonRunActions, logSurgeonProposal } from "../../../src/adapters/db/surgeon-run-log.js";

const { runAutonomousSurgeonMock, runSurgeonMock } = vi.hoisted(() => ({
  runAutonomousSurgeonMock: vi.fn(),
  runSurgeonMock: vi.fn(),
}));

vi.mock("../../../src/app/surgeon/service.js", () => ({
  runAutonomousSurgeon: runAutonomousSurgeonMock,
  runSurgeon: runSurgeonMock,
}));

import { loadSurgeonBacklogRuntime, loadSurgeonStatusRuntime, reviewSurgeonProposalRuntime, runSurgeonRuntime } from "../../../src/app/surgeon/runtime.js";

const tempPaths: string[] = [];

afterEach(async () => {
  runAutonomousSurgeonMock.mockReset();
  runSurgeonMock.mockReset();

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { recursive: true, force: true });
  }
});

beforeEach(() => {
  runSurgeonMock.mockResolvedValue({
    runId: "run-1",
    status: "completed",
    passType: "retirement",
    actionsTaken: 0,
    entriesRetired: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    summary: null,
  });
  runAutonomousSurgeonMock.mockResolvedValue({
    cyclesCompleted: 1,
    passes: [],
    status: "completed",
    actionsTaken: 0,
    entriesRetired: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    summary: null,
  });
});

describe("surgeon runtime", () => {
  it("prefers CLI provider and model overrides and creates recall ports when embeddings are configured", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-runtime-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        openaiApiKey: "openai-key",
        anthropicApiKey: "anthropic-key",
      },
      surgeon: {
        model: {
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    });

    await runSurgeonRuntime({
      pass: "retirement",
      budget: 0,
      apply: false,
      verbose: false,
      json: false,
      provider: "openai",
      model: "gpt-5.4-mini",
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(runSurgeonMock).toHaveBeenCalledTimes(1);
    const [options, deps] = runSurgeonMock.mock.calls[0] as Parameters<typeof runSurgeonMock>;

    expect(options).toMatchObject({
      pass: "retirement",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(deps.dbPath).toBe(dbPath);
    expect(deps.model.provider).toBe("openai");
    expect(deps.model.id).toBe("gpt-5.4-mini");
    await expect(deps.getApiKey?.("openai")).resolves.toBe("openai-key");
    expect(deps.recallPorts).toBeDefined();
  });

  it("falls back to config defaults and disables recall simulation when no embedding key is configured", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-runtime-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        anthropicApiKey: "anthropic-key",
      },
    });

    await runSurgeonRuntime({
      pass: "retirement",
      budget: 0,
      apply: false,
      verbose: false,
      json: false,
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(runSurgeonMock).toHaveBeenCalledTimes(1);
    const [, deps] = runSurgeonMock.mock.calls[0] as Parameters<typeof runSurgeonMock>;

    expect(deps.model.provider).toBe("anthropic");
    expect(deps.model.id).toBe("claude-sonnet-4-6");
    await expect(deps.getApiKey?.("anthropic")).resolves.toBe("anthropic-key");
    expect(deps.recallPorts).toBeUndefined();
  });

  it("forwards runtime progress reporters into the surgeon service dependencies", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-runtime-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");
    const onProgress = vi.fn();

    await writeJson(configPath, {
      provider: "openai",
      model: "gpt-5.4-mini",
      credentials: {
        openaiApiKey: "openai-key",
      },
    });

    await runSurgeonRuntime({
      pass: "claim_key_quality",
      budget: 0,
      apply: false,
      verbose: false,
      json: false,
      dbPath,
      onProgress,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(runSurgeonMock).toHaveBeenCalledTimes(1);
    const [options, deps] = runSurgeonMock.mock.calls[0] as Parameters<typeof runSurgeonMock>;

    expect(options).toMatchObject({
      pass: "claim_key_quality",
      includeInactive: true,
    });
    expect(deps.reportProgress).toBe(onProgress);
  });

  it("routes bare runs through the autonomous service entry point", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-runtime-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      provider: "openai",
      model: "gpt-5.4-mini",
      credentials: {
        openaiApiKey: "openai-key",
      },
    });

    await runSurgeonRuntime({
      budget: 0,
      apply: false,
      verbose: false,
      json: false,
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(runAutonomousSurgeonMock).toHaveBeenCalledTimes(1);
    expect(runSurgeonMock).not.toHaveBeenCalled();
    const [options, deps] = runAutonomousSurgeonMock.mock.calls[0] as Parameters<typeof runAutonomousSurgeonMock>;

    expect(options).toMatchObject({
      includeInactive: true,
    });
    expect(deps.createClaimExtractionLlm).toBeDefined();
  });

  it("loads status from the configured database", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-status-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      dbPath,
    });

    const database = await createDatabase(dbPath);
    try {
      await database.execute({
        sql: `
          INSERT INTO entries (
            id,
            type,
            subject,
            content,
            importance,
            expiry,
            tags,
            source_file,
            source_context,
            embedding,
            content_hash,
            norm_content_hash,
            minhash_sig,
            quality_score,
            recall_count,
            last_recalled_at,
            superseded_by,
            cluster_id,
            retired,
            retired_at,
            retired_reason,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          "entry-1",
          "milestone",
          "Status candidate",
          "A session handoff that should be reviewed by surgeon.",
          3,
          "temporary",
          "[]",
          null,
          null,
          null,
          "hash-1",
          null,
          null,
          0.3,
          0,
          null,
          null,
          null,
          0,
          null,
          null,
          "2026-01-01T00:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
        ],
      });
      await createSurgeonRun(database, {
        passType: "retirement",
        dryRun: true,
        startedAt: "2026-03-29T10:00:00.000Z",
      });
    } finally {
      await database.close();
    }

    const result = await loadSurgeonStatusRuntime({
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(result.health.total).toBe(1);
    expect(result.health.retirementCandidateCount).toBe(1);
    expect(result.lastRun).toMatchObject({
      passType: "retirement",
      dryRun: true,
    });
  });

  it("lists backlog rows and applies eligible proposals through the existing update path", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-review-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      dbPath,
    });

    const database = await createDatabase(dbPath);
    let runId!: string;
    try {
      await database.insertEntry(
        {
          id: "entry-1",
          type: "fact",
          subject: "pager policy",
          content: "Taylor is on call this week.",
          importance: 8,
          expiry: "permanent",
          tags: [],
          quality_score: 0.8,
          recall_count: 0,
          retired: false,
          created_at: "2026-03-20T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z",
        },
        Array.from({ length: 1024 }, () => 0),
        "hash-1",
      );
      runId = await createSurgeonRun(database, {
        passType: "claim_key_quality",
        dryRun: true,
        startedAt: "2026-03-29T10:00:00.000Z",
      });
      await logSurgeonProposal(database, {
        id: "proposal-1",
        runId,
        groupId: "group-1",
        issueKind: "missing_claim_key",
        scope: "single_entry",
        entryIds: ["entry-1"],
        currentClaimKeys: [],
        proposedClaimKeys: ["ops/on_call_owner"],
        rationale: "This entry is clearly about the on-call owner slot.",
        confidence: 0.93,
        source: "mixed_group_consensus",
        eligibleForApply: true,
        createdAt: "2026-03-29T10:01:00.000Z",
      });
    } finally {
      await database.close();
    }

    const backlog = await loadSurgeonBacklogRuntime({
      dbPath,
      state: "open",
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });
    expect(backlog).toHaveLength(1);
    expect(backlog[0]).toMatchObject({
      proposal: {
        id: "proposal-1",
        reviewStatus: "open",
      },
      runPassType: "claim_key_quality",
    });

    const result = await reviewSurgeonProposalRuntime({
      proposalId: "proposal-1",
      decision: "apply",
      reason: "Canonical slot is obvious.",
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(result.proposal).toMatchObject({
      id: "proposal-1",
      reviewStatus: "applied",
      reviewReason: "Canonical slot is obvious.",
      appliedActionCount: 1,
    });
    expect(result.updatedEntryIds).toEqual(["entry-1"]);
    expect(result.backupPath).toContain("surgeon-backup");

    const reloadedDatabase = await createDatabase(dbPath);
    try {
      const updatedEntry = await reloadedDatabase.getEntry("entry-1");
      expect(updatedEntry).toMatchObject({
        claim_key: "ops/on_call_owner",
        claim_key_status: "trusted",
      });
      const proposals = await reloadedDatabase.execute({
        sql: "SELECT review_status, review_reason, applied_action_count FROM surgeon_run_proposals WHERE id = ?",
        args: ["proposal-1"],
      });
      expect(proposals.rows[0]).toEqual({
        review_status: "applied",
        review_reason: "Canonical slot is obvious.",
        applied_action_count: 1,
      });
      expect(await getSurgeonRunActions(reloadedDatabase, runId)).toEqual([
        expect.objectContaining({
          actionType: "update_entry",
          entryIds: ["entry-1"],
          details: expect.objectContaining({
            proposal_id: "proposal-1",
            proposal_review_status: "applied",
            target_claim_key: "ops/on_call_owner",
          }),
        }),
      ]);
    } finally {
      await reloadedDatabase.close();
    }
  });
});

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.push(directory);
  return directory;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
