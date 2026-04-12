import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SurgeonProgressEvent } from "../../../src/app/surgeon/progress.js";

/** Strips ANSI escape codes from a string for assertion matching. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-9;]*m/g, "");

const {
  loadSurgeonActionsRuntimeMock,
  loadSurgeonBacklogRuntimeMock,
  loadSurgeonHistoryRuntimeMock,
  loadSurgeonProposalsRuntimeMock,
  loadSurgeonStatusRuntimeMock,
  reviewSurgeonProposalRuntimeMock,
  runSurgeonRuntimeMock,
} = vi.hoisted(() => ({
  loadSurgeonActionsRuntimeMock: vi.fn(),
  loadSurgeonBacklogRuntimeMock: vi.fn(),
  loadSurgeonHistoryRuntimeMock: vi.fn(),
  loadSurgeonProposalsRuntimeMock: vi.fn(),
  loadSurgeonStatusRuntimeMock: vi.fn(),
  reviewSurgeonProposalRuntimeMock: vi.fn(),
  runSurgeonRuntimeMock: vi.fn(),
}));

vi.mock("../../../src/app/surgeon/runtime.js", () => ({
  loadSurgeonActionsRuntime: loadSurgeonActionsRuntimeMock,
  loadSurgeonBacklogRuntime: loadSurgeonBacklogRuntimeMock,
  loadSurgeonHistoryRuntime: loadSurgeonHistoryRuntimeMock,
  loadSurgeonProposalsRuntime: loadSurgeonProposalsRuntimeMock,
  loadSurgeonStatusRuntime: loadSurgeonStatusRuntimeMock,
  reviewSurgeonProposalRuntime: reviewSurgeonProposalRuntimeMock,
  runSurgeonRuntime: runSurgeonRuntimeMock,
}));

import { registerSurgeonCommand } from "../../../src/cli/commands/surgeon.js";

describe("registerSurgeonCommand", () => {
  beforeEach(() => {
    runSurgeonRuntimeMock.mockResolvedValue({
      runId: "run-1",
      status: "completed",
      passType: "claim_key_quality",
      actionsTaken: 2,
      entriesRetired: 0,
      inputTokens: 100,
      outputTokens: 0,
      estimatedCostUsd: 0.02,
      summary: "Claim-key cleanup complete.",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loadSurgeonActionsRuntimeMock.mockReset();
    loadSurgeonBacklogRuntimeMock.mockReset();
    loadSurgeonHistoryRuntimeMock.mockReset();
    loadSurgeonProposalsRuntimeMock.mockReset();
    loadSurgeonStatusRuntimeMock.mockReset();
    reviewSurgeonProposalRuntimeMock.mockReset();
    runSurgeonRuntimeMock.mockReset();
  });

  it("writes concise progress to stderr and preserves the final human summary on stdout", async () => {
    const { program, stdout, stderr } = createProgramWithCapturedOutput();
    runSurgeonRuntimeMock.mockImplementation(async (input: { onProgress?: (event: SurgeonProgressEvent) => void }) => {
      input.onProgress?.({ kind: "phase", phase: "start", passType: "claim_key_quality", apply: true });
      input.onProgress?.({ kind: "phase", phase: "backup_start", passType: "claim_key_quality", apply: true });
      input.onProgress?.({
        kind: "phase",
        phase: "backup_complete",
        passType: "claim_key_quality",
        apply: true,
        backupPath: "/tmp/knowledge.db.surgeon-backup",
      });
      input.onProgress?.({
        kind: "claim_key_quality_progress",
        passType: "claim_key_quality",
        apply: true,
        stage: "missing",
        status: "preview_progress",
        completed: 0,
        total: 200,
        unitLabel: "entries",
        previewQueued: 200,
        previewCompleted: 120,
        previewTotal: 200,
        previewConcurrency: 10,
        processedEntries: 180,
        totalEntries: 1200,
        counts: {
          identifiedNormalizations: 4,
          appliedNormalizations: 3,
          identifiedBackfills: 18,
          appliedBackfills: 12,
          identifiedMetadataRewrites: 1,
          appliedMetadataRewrites: 0,
          identifiedEntityFamilyConvergences: 0,
          appliedEntityFamilyConvergences: 0,
          proposalsEmitted: 8,
          skippedNoClaim: 6,
          skippedLowConfidence: 3,
          skippedCollision: 1,
          skippedAmbiguous: 2,
        },
        elapsedMs: 12_000,
      });

      return {
        runId: "run-1",
        status: "completed",
        passType: "claim_key_quality",
        actionsTaken: 2,
        entriesRetired: 0,
        inputTokens: 100,
        outputTokens: 0,
        estimatedCostUsd: 0.02,
        summary: "Claim-key cleanup complete.",
      };
    });

    await program.parseAsync(["surgeon", "run", "--pass", "claim_key_quality", "--apply"], { from: "user" });

    const stderrText = stripAnsi(stderr.join(""));
    expect(stderrText).toContain("Surgeon run: claim_key_quality");
    expect(stderrText).toContain("Creating DB backup...");
    expect(stderrText).toContain("Backup complete");
    expect(stderrText).toContain("/tmp/knowledge.db.surgeon-backup");
    expect(stderrText).toContain("missing: 0/200 entries, preview 120/200, 15 applied, 8 proposals, 12s");
    expect(stderrText).not.toContain("skipped no-claim");
    const stdoutText = stripAnsi(stdout.join(""));
    expect(stdoutText).toContain("Surgeon Run run-1");
    expect(stdoutText).toContain("Claim-key cleanup complete.");
  });

  it("makes verbose deterministic progress output richer", async () => {
    const { program, stderr } = createProgramWithCapturedOutput();
    runSurgeonRuntimeMock.mockImplementation(async (input: { onProgress?: (event: SurgeonProgressEvent) => void }) => {
      input.onProgress?.({
        kind: "claim_key_quality_progress",
        passType: "claim_key_quality",
        apply: false,
        stage: "missing",
        status: "progress",
        completed: 50,
        total: 120,
        unitLabel: "entries",
        previewQueued: 120,
        previewCompleted: 120,
        previewTotal: 120,
        previewConcurrency: 10,
        processedEntries: 90,
        totalEntries: 600,
        counts: {
          identifiedNormalizations: 4,
          appliedNormalizations: 3,
          identifiedBackfills: 10,
          appliedBackfills: 7,
          identifiedMetadataRewrites: 2,
          appliedMetadataRewrites: 1,
          identifiedEntityFamilyConvergences: 0,
          appliedEntityFamilyConvergences: 0,
          proposalsEmitted: 5,
          skippedNoClaim: 2,
          skippedLowConfidence: 4,
          skippedCollision: 1,
          skippedAmbiguous: 3,
        },
        elapsedMs: 9_000,
      });

      return {
        runId: "run-1",
        status: "completed",
        passType: "claim_key_quality",
        actionsTaken: 2,
        entriesRetired: 0,
        inputTokens: 100,
        outputTokens: 0,
        estimatedCostUsd: 0.02,
        summary: "Claim-key cleanup complete.",
      };
    });

    await program.parseAsync(["surgeon", "run", "--pass", "claim_key_quality", "--verbose"], { from: "user" });

    const stderrText = stripAnsi(stderr.join(""));
    expect(stderrText).toContain("missing: 50/120 entries, preview 120/120, 11 applied, 5 proposals, 9s");
    expect(stderrText).toContain("normalize 3/4");
    expect(stderrText).toContain("backfill 7/10");
    expect(stderrText).toContain("metadata 1/2");
  });

  it("keeps JSON mode coherent by sending progress to stderr and JSON to stdout", async () => {
    const { program, stdout, stderr } = createProgramWithCapturedOutput();
    runSurgeonRuntimeMock.mockImplementation(async (input: { onProgress?: (event: SurgeonProgressEvent) => void }) => {
      input.onProgress?.({ kind: "phase", phase: "start", passType: "claim_key_quality", apply: false });
      return {
        runId: "run-1",
        status: "completed",
        passType: "claim_key_quality",
        actionsTaken: 0,
        entriesRetired: 0,
        inputTokens: 10,
        outputTokens: 0,
        estimatedCostUsd: 0,
        summary: null,
      };
    });

    await program.parseAsync(["surgeon", "run", "--pass", "claim_key_quality", "--json"], { from: "user" });

    const stderrText = stripAnsi(stderr.join(""));
    expect(stderrText).toContain("Surgeon run: claim_key_quality");
    expect(stderrText).toContain("dry-run");
    expect(JSON.parse(stdout.join(""))).toEqual({
      runId: "run-1",
      status: "completed",
      passType: "claim_key_quality",
      actionsTaken: 0,
      entriesRetired: 0,
      inputTokens: 10,
      outputTokens: 0,
      estimatedCostUsd: 0,
      summary: null,
    });
  });

  it("forwards preset and project selection to runtime and renders aggregate preset output", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    runSurgeonRuntimeMock.mockResolvedValue({
      preset: "structural",
      passes: [{ passType: "claim_key_quality" }, { passType: "supersession" }],
      status: "completed",
      actionsTaken: 3,
      entriesRetired: 0,
      inputTokens: 150,
      outputTokens: 20,
      estimatedCostUsd: 0.03,
      summary: "Structural cleanup complete.",
    });

    await program.parseAsync(["surgeon", "run", "--preset", "structural", "--project", "Agenr"], { from: "user" });

    expect(runSurgeonRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "structural",
        project: "Agenr",
      }),
    );
    const stdoutText = stripAnsi(stdout.join(""));
    expect(stdoutText).toContain("Surgeon Preset: structural");
    expect(stdoutText).toContain("claim_key_quality -> supersession");
    expect(stdoutText).toContain("Structural cleanup complete.");
  });

  it("normalizes run arguments before invoking the runtime", async () => {
    const { program } = createProgramWithCapturedOutput();

    await program.parseAsync(
      [
        "surgeon",
        "run",
        "--pass",
        "claim_key_quality",
        "--project",
        " Agenr ",
        "--type",
        " decision ",
        "--claim-key-prefix",
        " agent:jim ",
        "--entry-id",
        " entry-1 ",
        "--entry-id",
        "entry-1",
        "--provider",
        " openai ",
        "--model",
        " gpt-5.4-mini ",
        "--trace",
        " /tmp/surgeon.log ",
      ],
      { from: "user" },
    );

    expect(runSurgeonRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "Agenr",
        type: "decision",
        claimKeyPrefix: "agent:jim",
        entryIds: ["entry-1"],
        provider: "openai",
        model: "gpt-5.4-mini",
        tracePath: "/tmp/surgeon.log",
      }),
    );
  });

  it("renders lifecycle health counts in surgeon status output", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    loadSurgeonStatusRuntimeMock.mockResolvedValue({
      health: {
        total: 17,
        claimKeyLifecycle: {
          trusted: 8,
          tentative: 2,
          unresolved: 1,
          legacy: 3,
          noKey: 3,
        },
        proposalBacklogCount: 4,
        eligibleProposalBacklogCount: 3,
        oldestOpenProposalCreatedAt: "2026-03-28T08:00:00.000Z",
        retirementCandidateCount: 6,
        recentlyEvaluatedCount: 2,
      },
      lastRun: {
        passType: "claim_key_quality",
        status: "completed",
        dryRun: true,
        estimatedCostUsd: 0.04,
      },
    });

    await program.parseAsync(["surgeon", "status"], { from: "user" });

    expect(loadSurgeonStatusRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: process.env,
      }),
    );
    const stdoutText = stripAnsi(stdout.join(""));
    expect(stdoutText).toContain("Surgeon Status");
    expect(stdoutText).toContain("17");
    expect(stdoutText).toContain("8 trusted");
    expect(stdoutText).toContain("2 tentative");
    expect(stdoutText).toContain("1 unresolved");
    expect(stdoutText).toContain("3 legacy");
    expect(stdoutText).toContain("3 no key");
    expect(stdoutText).toContain("4 open, 3 eligible");
    expect(stdoutText).toContain("6 candidates");
    expect(stdoutText).toContain("4 new, 2 recently evaluated");
    expect(stdoutText).toContain("claim_key_quality");
    expect(stdoutText).toContain("completed");
    expect(stdoutText).toContain("$0.0400");
  });

  it("renders the global proposal backlog", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    loadSurgeonBacklogRuntimeMock.mockResolvedValue([
      {
        proposal: {
          id: "proposal-1",
          runId: "run-1",
          groupId: "group-1",
          issueKind: "mixed_claim_family",
          scope: "cluster",
          entryIds: ["entry-1", "entry-2"],
          currentClaimKeys: ["jim/home_city"],
          proposedClaimKeys: ["jim/location"],
          rationale: "Review split-family entries.",
          confidence: 0.86,
          source: "claim_key_quality",
          eligibleForApply: true,
          createdAt: "2026-03-30T12:00:00.000Z",
          reviewStatus: "open",
          reviewedAt: null,
          reviewReason: null,
          appliedActionCount: 0,
        },
        runPassType: "claim_key_quality",
        runStartedAt: "2026-03-30T11:55:00.000Z",
        runStatus: "completed",
        runDryRun: true,
      },
    ]);

    await program.parseAsync(["surgeon", "backlog", "--eligible-only"], { from: "user" });

    expect(loadSurgeonBacklogRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "open",
        eligibleOnly: true,
        env: process.env,
      }),
    );
    const stdoutText = stripAnsi(stdout.join(""));
    expect(stdoutText).toContain("Surgeon Backlog");
    expect(stdoutText).toContain("eligible");
    expect(stdoutText).toContain("open");
    expect(stdoutText).toContain("claim_key_quality");
    expect(stdoutText).toContain("completed");
  });

  it("renders unresolved proposals for one surgeon run", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    loadSurgeonProposalsRuntimeMock.mockResolvedValue([
      {
        id: "proposal-1",
        runId: "run-1",
        groupId: "group-1",
        issueKind: "mixed_claim_family",
        scope: "cluster",
        entryIds: ["entry-1", "entry-2"],
        currentClaimKeys: ["jim/home_city"],
        proposedClaimKeys: ["jim/home_city", "jim/location"],
        rationale: "The family mixes a trusted canonical key with an alternative candidate that needs review.",
        confidence: 0.86,
        source: "claim_key_quality",
        eligibleForApply: false,
        createdAt: "2026-03-30T12:00:00.000Z",
        reviewStatus: "open",
        reviewedAt: null,
        reviewReason: null,
        appliedActionCount: 0,
      },
    ]);

    await program.parseAsync(["surgeon", "proposals", "run-1"], { from: "user" });

    expect(loadSurgeonProposalsRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        env: process.env,
      }),
    );
    const stdoutText = stripAnsi(stdout.join(""));
    expect(stdoutText).toContain("Surgeon Proposals run-1");
    expect(stdoutText).toContain("mixed_claim_family");
    expect(stdoutText).toContain("scope=cluster");
    expect(stdoutText).toContain("confidence=0.86");
    expect(stdoutText).toContain("not eligible");
    expect(stdoutText).toContain("entries: entry-1, entry-2");
    expect(stdoutText).toContain("jim/home_city -> jim/home_city, jim/location");
  });

  it("renders proposal review results after apply or reject", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    reviewSurgeonProposalRuntimeMock.mockResolvedValue({
      proposal: {
        id: "proposal-1",
        runId: "run-1",
        groupId: "group-1",
        issueKind: "mixed_claim_family",
        scope: "cluster",
        entryIds: ["entry-1", "entry-2"],
        currentClaimKeys: ["jim/home_city"],
        proposedClaimKeys: ["jim/location"],
        rationale: "Review split-family entries.",
        confidence: 0.86,
        source: "claim_key_quality",
        eligibleForApply: true,
        createdAt: "2026-03-30T12:00:00.000Z",
        reviewStatus: "applied",
        reviewedAt: "2026-03-30T13:00:00.000Z",
        reviewReason: "Canonical family already exists.",
        appliedActionCount: 1,
      },
      updatedEntryIds: ["entry-1", "entry-2"],
      backupPath: "/tmp/knowledge.db.surgeon-backup",
    });

    await program.parseAsync(["surgeon", "review", "proposal-1", "--decision", "apply", "--reason", "Canonical family already exists."], {
      from: "user",
    });

    expect(reviewSurgeonProposalRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "proposal-1",
        decision: "apply",
        reason: "Canonical family already exists.",
        env: process.env,
      }),
    );
    const stdoutText = stripAnsi(stdout.join(""));
    expect(stdoutText).toContain("Proposal Review proposal-1");
    expect(stdoutText).toContain("applied");
    expect(stdoutText).toContain("entry-1, entry-2");
    expect(stdoutText).toContain("/tmp/knowledge.db.surgeon-backup");
  });
});

function createProgramWithCapturedOutput(): { program: Command; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });

  const program = new Command();
  registerSurgeonCommand(program);
  return { program, stdout, stderr };
}
