import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

import { getModel, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runAgentLoopMock } = vi.hoisted(() => ({
  runAgentLoopMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-agent-core")>("@earendil-works/pi-agent-core");
  return {
    ...actual,
    runAgentLoop: runAgentLoopMock,
  };
});

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createSurgeonPort } from "../../../src/adapters/db/surgeon-port.js";
import type { SurgeonProgressEvent } from "../../../src/app/surgeon/progress.js";
import {
  completeSurgeonRun,
  createSurgeonRun,
  getLastSurgeonRun,
  getSurgeonRunActions,
  getSurgeonRunHistory,
  logSurgeonProposal,
} from "../../../src/adapters/db/surgeon-run-log.js";
import { runAutonomousSurgeon, runSurgeon, type SurgeonRunOptions } from "../../../src/app/surgeon/service.js";
import type { Entry } from "../../../src/core/types.js";

const TEST_NOW = new Date("2026-03-29T12:00:00.000Z");
const TEST_MODEL = getModel("openai", "gpt-5.4-mini");
const TEST_USAGE: Usage = {
  input: 1_200,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_500,
  cost: {
    input: 0.01,
    output: 0.03,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.04,
  },
};

describe("runSurgeon", () => {
  const databases: SqlDatabase[] = [];
  const tempPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    runAgentLoopMock.mockReset();

    while (databases.length > 0) {
      await databases.pop()?.close();
    }

    while (tempPaths.length > 0) {
      await rm(tempPaths.pop() ?? "", { recursive: true, force: true });
    }
  });

  it("completes a dry-run workflow and persists the finalized run", async () => {
    const db = await createTestDatabase(databases);
    mockSuccessfulRunAgentLoop();

    const result = await runSurgeon(createRunOptions({ budget: 0.1 }), {
      port: createSurgeonPort(db),
      config: null,
      model: TEST_MODEL,
      now: () => TEST_NOW,
    });

    expect(result).toMatchObject({
      runId: expect.any(String),
      status: "completed",
      passType: "retirement",
      actionsTaken: 0,
      entriesRetired: 0,
      inputTokens: 1_200,
      outputTokens: 300,
      estimatedCostUsd: 0.04,
      summary: "Dry-run sweep complete.",
    });

    const run = await getLastSurgeonRun(db);
    expect(run).toMatchObject({
      id: result.runId,
      passType: "retirement",
      status: "completed",
      dryRun: true,
      inputTokens: 1_200,
      outputTokens: 300,
      estimatedCostUsd: 0.04,
      actionsTaken: 0,
      actionsSkipped: 1,
      entriesRetired: 0,
      summaryJson: {
        actions_taken: 0,
        entries_skipped: [{ entry_id: "stale-milestone", reason: "Needs another pass." }],
        observations: ["Dry-run sweep complete."],
        recommendations: ["Broaden to all scope if budget remains."],
      },
      error: null,
    });

    expect(await getSurgeonRunActions(db, result.runId)).toEqual([
      expect.objectContaining({
        runId: result.runId,
        actionType: "skip",
        entryIds: ["stale-milestone"],
        reasoning: "Needs another pass.",
      }),
    ]);
  });

  it("writes trace output into a generated file when the trace path is an existing directory", async () => {
    const db = await createTestDatabase(databases);
    const traceDir = await createTempDirectory(tempPaths, "agenr-surgeon-trace-");
    mockSuccessfulRunAgentLoop();

    const result = await runSurgeon(
      createRunOptions({
        budget: 0.1,
        tracePath: traceDir,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    const files = await readdir(traceDir);
    expect(files).toEqual([`surgeon-retirement-${result.runId}.jsonl`]);

    const traceLines = (await readFile(path.join(traceDir, files[0] ?? ""), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { timestamp: string; kind: string });

    expect(traceLines.length).toBeGreaterThan(0);
    expect(traceLines[0]).toEqual(
      expect.objectContaining({
        timestamp: expect.any(String),
        kind: "assistant_message",
      }),
    );
  });

  it("rejects a new run when the daily cost cap has already been exceeded", async () => {
    const db = await createTestDatabase(databases);
    const previousRunId = await createSurgeonRun(db, {
      passType: "retirement",
      dryRun: false,
      startedAt: daysAgoIso(1 / 24),
    });
    await completeSurgeonRun(db, previousRunId, {
      status: "completed",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 1.25,
      actionsTaken: 0,
      actionsSkipped: 0,
      entriesRetired: 0,
      completedAt: TEST_NOW.toISOString(),
    });

    await expect(
      runSurgeon(createRunOptions({ budget: 1 }), {
        port: createSurgeonPort(db),
        config: {
          surgeon: {
            dailyCostCap: 1,
          },
        },
        model: TEST_MODEL,
        now: () => TEST_NOW,
      }),
    ).rejects.toThrow("Surgeon daily cost cap exceeded.");

    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(await getSurgeonRunHistory(db, 10)).toHaveLength(1);
  });

  it("finalizes the run as aborted when the signal is already aborted", async () => {
    const db = await createTestDatabase(databases);
    const controller = new AbortController();
    controller.abort();
    runAgentLoopMock.mockImplementation(async (prompts: AgentMessage[]) => prompts);

    const result = await runSurgeon(
      createRunOptions({
        budget: 1,
        signal: controller.signal,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "aborted",
      summary: "Run aborted by user.",
      estimatedCostUsd: 0,
    });

    const run = await getLastSurgeonRun(db);
    expect(run).toMatchObject({
      id: result.runId,
      status: "aborted",
      error: "Run aborted by user (SIGINT).",
      summaryJson: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it("propagates clean database errors before the agent loop starts", async () => {
    const db = await createTestDatabase(databases);
    vi.spyOn(db, "execute").mockRejectedValue(new Error("Database unavailable."));

    await expect(
      runSurgeon(createRunOptions(), {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      }),
    ).rejects.toThrow("Database unavailable.");

    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("emits startup and backup progress before an apply run begins long work", async () => {
    const db = await createTestDatabase(databases);
    const port = createSurgeonPort(db);
    const progress: SurgeonProgressEvent[] = [];
    let releaseBackup: ((backupPath: string) => void) | undefined;
    const backupDb = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseBackup = resolve;
        }),
    );

    const runPromise = runSurgeon(
      createRunOptions({
        pass: "claim_key_quality",
        apply: true,
      }),
      {
        port,
        dbPath: "/tmp/knowledge.db",
        backupDb,
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
        reportProgress: (event) => progress.push(event),
      },
    );

    await vi.waitFor(() =>
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "phase", phase: "start", passType: "claim_key_quality" }),
          expect.objectContaining({ kind: "phase", phase: "backup_start", passType: "claim_key_quality" }),
        ]),
      ),
    );

    expect(progress.some((event) => event.kind === "phase" && event.phase === "backup_complete")).toBe(false);
    releaseBackup?.("/tmp/knowledge.db.surgeon-backup");

    await expect(runPromise).resolves.toMatchObject({
      status: "completed",
    });
    expect(backupDb).toHaveBeenCalledWith("/tmp/knowledge.db");
    expect(progress).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "phase", phase: "backup_complete", backupPath: "/tmp/knowledge.db.surgeon-backup" })]),
    );
  });

  it("emits working-set loading progress before claim_key_quality finishes loading entries", async () => {
    const db = await createTestDatabase(databases);
    const port = createSurgeonPort(db);
    const progress: SurgeonProgressEvent[] = [];
    let releaseEntries: ((entries: Entry[]) => void) | undefined;

    vi.spyOn(port, "listClaimKeyQualityEntries").mockImplementation(
      async () =>
        new Promise<Entry[]>((resolve) => {
          releaseEntries = resolve;
        }),
    );

    const runPromise = runSurgeon(
      createRunOptions({
        pass: "claim_key_quality",
      }),
      {
        port,
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
        reportProgress: (event) => progress.push(event),
      },
    );

    await vi.waitFor(() =>
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "phase", phase: "start", passType: "claim_key_quality" }),
          expect.objectContaining({ kind: "phase", phase: "load_working_set_start", passType: "claim_key_quality" }),
        ]),
      ),
    );

    expect(progress.some((event) => event.kind === "phase" && event.phase === "load_working_set_complete")).toBe(false);
    releaseEntries?.([]);

    await expect(runPromise).resolves.toMatchObject({
      status: "completed",
    });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "phase", phase: "load_working_set_complete", workingSetSize: 0 }),
        expect.objectContaining({ kind: "phase", phase: "pass_start", passType: "claim_key_quality" }),
      ]),
    );
  });

  it("assembles the system and initial prompts from corpus state and budget", async () => {
    const db = await createTestDatabase(databases);
    runAgentLoopMock.mockImplementation(async (prompts: AgentMessage[]) => prompts);

    await runSurgeon(
      createRunOptions({
        budget: 1.25,
        contextLimit: 4_096,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    const [prompts, context] = runAgentLoopMock.mock.calls[0] as [AgentMessage[], AgentContext, AgentLoopConfig];
    const initialPrompt = getUserMessageText(prompts[0]);

    expect(context.systemPrompt).toContain("## The Corpus");
    expect(context.systemPrompt).toContain("## Protection Rules");
    expect(context.systemPrompt).toContain("# Retirement Pass");
    expect(initialPrompt).toContain("Entries: 4.");
    expect(initialPrompt).toContain("Requested scope: corpus-wide.");
    expect(initialPrompt).toContain("Observed type mix: fact=2, decision=1, milestone=1.");
    expect(initialPrompt).toContain("Claim-key coverage: trusted=0, tentative=0, unresolved=0, legacy=0, noKey=4.");
    expect(initialPrompt).toContain("Actionable cleanup pool: 2.");
    expect(initialPrompt).toContain("Your cost budget is $1.2500.");
    expect(initialPrompt).toContain("Your context window is 4096 tokens.");
  });

  it("assembles the supersession prompt and tool set from corpus state", async () => {
    const db = await createTestDatabase(databases);
    await insertEntry(db, {
      id: "sup-old",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(90),
      updated_at: daysAgoIso(90),
    });
    await insertEntry(db, {
      id: "sup-new",
      subject: "Mac mini update policy revised",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(10),
      updated_at: daysAgoIso(10),
    });
    runAgentLoopMock.mockImplementation(async (prompts: AgentMessage[]) => prompts);

    await runSurgeon(
      createRunOptions({
        pass: "supersession",
        budget: 1.25,
        contextLimit: 4_096,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    const [prompts, context] = runAgentLoopMock.mock.calls[0] as [AgentMessage[], AgentContext, AgentLoopConfig];
    const initialPrompt = getUserMessageText(prompts[0]);

    expect(context.systemPrompt).toContain("# Supersession Pass");
    expect(context.systemPrompt).not.toContain("Retirement is the only pass in scope.");
    expect(context.systemPrompt).toContain("Do not assume the entries are about software");
    expect(context.tools?.map((tool) => tool.name)).toEqual([
      "get_health_stats",
      "query_supersession_candidates",
      "inspect_entry",
      "simulate_recall",
      "link_supersession",
      "assign_claim_key",
      "set_validity",
      "update_entry",
      "complete_pass",
    ]);
    expect(initialPrompt).toContain("Begin supersession pass.");
    expect(initialPrompt).toContain("Requested scope: corpus-wide.");
    expect(initialPrompt).toContain("Observed type mix:");
    expect(initialPrompt).toContain("Claim-key coverage:");
    expect(initialPrompt).toContain("Claim-key clusters: 1.");
    expect(initialPrompt).toContain("Subject clusters:");
  });

  it("completes an apply supersession run and persists the supersession link", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "policy-old",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(120),
    });
    await insertEntry(db, {
      id: "policy-new",
      subject: "Mac mini update policy clarified",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(20),
      updated_at: daysAgoIso(20),
    });
    await insertEntry(db, {
      id: "other-preference",
      subject: "Mac mini maintenance window",
      type: "preference",
      claim_key: "mac_mini/maintenance_window",
      created_at: daysAgoIso(15),
      updated_at: daysAgoIso(15),
    });
    mockSuccessfulSupersessionRunAgentLoop();

    const result = await runSurgeon(
      createRunOptions({
        pass: "supersession",
        apply: true,
        budget: 0.1,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      passType: "supersession",
      actionsTaken: 1,
    });

    const rows = await db.execute({
      sql: "SELECT id, superseded_by, supersession_kind, supersession_reason FROM entries WHERE id IN (?, ?, ?) ORDER BY id ASC",
      args: ["other-preference", "policy-new", "policy-old"],
    });
    expect(rows.rows).toEqual([
      {
        id: "other-preference",
        superseded_by: null,
        supersession_kind: null,
        supersession_reason: null,
      },
      {
        id: "policy-new",
        superseded_by: null,
        supersession_kind: null,
        supersession_reason: null,
      },
      {
        id: "policy-old",
        superseded_by: "policy-new",
        supersession_kind: "duplicate",
        supersession_reason: "These preferences say the same thing. Keep the newer wording as the survivor.",
      },
    ]);
  });

  it("reconciles supersession summary_json action counts with persisted actions", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "policy-old",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(120),
    });
    await insertEntry(db, {
      id: "policy-new",
      subject: "Mac mini update policy clarified",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(20),
      updated_at: daysAgoIso(20),
    });
    runAgentLoopMock.mockImplementation(
      async (
        prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        emit: (event: AgentEvent) => void,
        signal?: AbortSignal,
      ): Promise<AgentMessage[]> => {
        const queryArgs = {
          scope: "claim_key",
          limit: 20,
          offset: 0,
        };
        const queryAssistantMessage = createAssistantToolMessage({
          id: "tool-query-supersession-misaligned",
          name: "query_supersession_candidates",
          arguments: queryArgs,
          reasoning: "Load the claim_key supersession cluster.",
          usage: TEST_USAGE,
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: queryAssistantMessage,
          args: queryArgs,
        });

        const linkArgs = {
          old_entry_id: "policy-old",
          new_entry_id: "policy-new",
          kind: "duplicate",
          reason: "These preferences say the same thing. Keep the newer wording as the survivor.",
        };
        const linkAssistantMessage = createAssistantToolMessage({
          id: "tool-link-supersession-misaligned",
          name: "link_supersession",
          arguments: linkArgs,
          reasoning: "This is a clear duplicate pair.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: linkAssistantMessage,
          args: linkArgs,
        });

        const completeArgs = {
          actions_taken: 0,
          entries_skipped: [],
          observations: ["Claim-key sweep complete."],
          recommendations: ["No lower-confidence subject sweep was needed."],
        };
        const completeAssistantMessage = createAssistantToolMessage({
          id: "tool-complete-supersession-misaligned",
          name: "complete_pass",
          arguments: completeArgs,
          reasoning: "The sweep is complete.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: completeAssistantMessage,
          args: completeArgs,
        });

        return [...prompts, queryAssistantMessage, linkAssistantMessage, completeAssistantMessage];
      },
    );

    const result = await runSurgeon(
      createRunOptions({
        pass: "supersession",
        apply: true,
        budget: 0.1,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      passType: "supersession",
      actionsTaken: 1,
      summary: expect.stringContaining("Persisted 1 non-skip action earlier in this pass."),
    });
    expect(await getLastSurgeonRun(db)).toMatchObject({
      status: "completed",
      actionsTaken: 1,
      summaryJson: expect.objectContaining({
        actions_taken: 1,
        observations: expect.arrayContaining(["Persisted 1 non-skip action earlier in this pass.", "Claim-key sweep complete."]),
      }),
    });
  });

  it("appends custom surgeon instructions to the system prompt", async () => {
    const db = await createTestDatabase(databases);
    runAgentLoopMock.mockImplementation(async (prompts: AgentMessage[]) => prompts);

    await runSurgeon(createRunOptions({ budget: 1 }), {
      port: createSurgeonPort(db),
      config: {
        surgeon: {
          customInstructions: "Custom surgeon rule: always mention provenance when you skip an entry.",
        },
      },
      model: TEST_MODEL,
      now: () => TEST_NOW,
    });

    const [, context] = runAgentLoopMock.mock.calls[0] as [AgentMessage[], AgentContext, AgentLoopConfig];
    expect(context.systemPrompt).toContain("Custom surgeon rule: always mention provenance when you skip an entry.");
  });

  it("preserves agent-loop execution while emitting context progress for retirement", async () => {
    const db = await createTestDatabase(databases);
    const progress: SurgeonProgressEvent[] = [];
    mockSuccessfulRunAgentLoop();

    const result = await runSurgeon(createRunOptions(), {
      port: createSurgeonPort(db),
      config: null,
      model: TEST_MODEL,
      now: () => TEST_NOW,
      reportProgress: (event) => progress.push(event),
    });

    expect(result.status).toBe("completed");
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "phase", phase: "start", passType: "retirement" }),
        expect.objectContaining({ kind: "phase", phase: "load_pass_context_start", passType: "retirement" }),
        expect.objectContaining({
          kind: "phase",
          phase: "load_pass_context_complete",
          passType: "retirement",
          workingSetSize: 4,
          retirementAvailableActionableCount: expect.any(Number),
          retirementAvailableAllCount: expect.any(Number),
          retirementRecentlyEvaluatedCount: expect.any(Number),
        }),
        expect.objectContaining({ kind: "phase", phase: "pass_start", passType: "retirement" }),
      ]),
    );
  });

  it("runs claim_key_quality as a first-class surgeon pass without invoking the agent loop", async () => {
    const db = await createTestDatabase(databases);
    await insertEntry(db, {
      id: "claim-noncanonical",
      subject: "Jim home city",
      type: "fact",
      claim_key: " Jim / Home City ",
      created_at: daysAgoIso(60),
      updated_at: daysAgoIso(60),
    });

    const result = await runSurgeon(
      createRunOptions({
        pass: "claim_key_quality",
        apply: true,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      passType: "claim_key_quality",
    });

    const run = await getLastSurgeonRun(db);
    expect(run).toMatchObject({
      id: result.runId,
      passType: "claim_key_quality",
      status: "completed",
    });

    const actions = await getSurgeonRunActions(db, result.runId);
    expect(actions[0]).toMatchObject({
      actionType: "update_entry",
      details: expect.objectContaining({
        issue_kind: "noncanonical_claim_key",
        new_claim_key: "jim/home_city",
        proposal_source: "normalize",
      }),
    });
  });

  it("returns no_work for retirement when no candidates remain after preflight filtering", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "protected-decision",
      subject: "Keep libsql as the durable store",
      type: "decision",
      importance: 10,
      expiry: "permanent",
      recall_count: 3,
      created_at: daysAgoIso(180),
      updated_at: daysAgoIso(5),
    });

    const result = await runSurgeon(createRunOptions(), {
      port: createSurgeonPort(db),
      config: null,
      model: TEST_MODEL,
      now: () => TEST_NOW,
    });

    expect(result).toMatchObject({
      status: "no_work",
      passType: "retirement",
      summary: "No retirement candidates were available after applying current filters.",
    });
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("uses persisted non-skip action counts instead of trusting complete_pass totals", async () => {
    const db = await createTestDatabase(databases);
    await insertEntry(db, {
      id: "persisted-retire-once",
      subject: "Retire once",
      type: "fact",
      importance: 2,
      expiry: "temporary",
      recall_count: 0,
      created_at: daysAgoIso(180),
      updated_at: daysAgoIso(90),
    });
    runAgentLoopMock.mockImplementation(
      async (
        prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        emit: (event: AgentEvent) => void,
        signal?: AbortSignal,
      ): Promise<AgentMessage[]> => {
        const actionableQueryArgs = {
          limit: 20,
          offset: 0,
        };
        const actionableQueryAssistantMessage = createAssistantToolMessage({
          id: "tool-query-persisted-actionable",
          name: "query_candidates",
          arguments: actionableQueryArgs,
          reasoning: "Inspect the actionable retirement pool first.",
          usage: TEST_USAGE,
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: actionableQueryAssistantMessage,
          args: actionableQueryArgs,
        });

        const allScopeQueryArgs = {
          scope: "all",
          limit: 20,
          offset: 0,
        };
        const allScopeQueryAssistantMessage = createAssistantToolMessage({
          id: "tool-query-persisted-all",
          name: "query_candidates",
          arguments: allScopeQueryArgs,
          reasoning: "Confirm the broader pool before completing.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: allScopeQueryAssistantMessage,
          args: allScopeQueryArgs,
        });

        const retireArgs = {
          entry_id: "persisted-retire-once",
          reason: "This temporary artifact is obsolete.",
        };
        const retireAssistantMessage = createAssistantToolMessage({
          id: "tool-retire-persisted-count",
          name: "retire_entry",
          arguments: retireArgs,
          reasoning: "There is one clear safe retirement.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: retireAssistantMessage,
          args: retireArgs,
        });

        const completeArgs = {
          actions_taken: 9,
          entries_skipped: [],
          observations: ["One retirement was persisted."],
          recommendations: [],
        };
        const completeAssistantMessage = createAssistantToolMessage({
          id: "tool-complete-persisted-count",
          name: "complete_pass",
          arguments: completeArgs,
          reasoning: "The bounded slice is complete.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: completeAssistantMessage,
          args: completeArgs,
        });

        return [...prompts, actionableQueryAssistantMessage, allScopeQueryAssistantMessage, retireAssistantMessage, completeAssistantMessage];
      },
    );

    const result = await runSurgeon(
      createRunOptions({
        apply: true,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      actionsTaken: 1,
      entriesRetired: 1,
    });
    expect(await getLastSurgeonRun(db)).toMatchObject({
      actionsTaken: 1,
      entriesRetired: 1,
      summaryJson: expect.objectContaining({
        actions_taken: 1,
        observations: expect.arrayContaining(["Persisted 1 non-skip action earlier in this pass.", "One retirement was persisted."]),
      }),
    });
  });

  it("marks an agent-loop pass as stalled when bounded slices stop making progress", async () => {
    const db = await createTestDatabase(databases);
    runAgentLoopMock.mockImplementation(async (prompts: AgentMessage[]) => prompts);

    const result = await runSurgeon(createRunOptions(), {
      port: createSurgeonPort(db),
      config: null,
      model: TEST_MODEL,
      now: () => TEST_NOW,
    });

    expect(result).toMatchObject({
      status: "stalled",
      passType: "retirement",
    });
    expect(runAgentLoopMock).toHaveBeenCalledTimes(3);
  });

  it("counts reviewed retirement entries as bounded-slice progress", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    for (const entryId of ["review-candidate-a", "review-candidate-b", "review-candidate-c"]) {
      await insertEntry(db, {
        id: entryId,
        subject: `Retirement review ${entryId}`,
        type: "fact",
        importance: 4,
        expiry: "permanent",
        recall_count: 0,
        created_at: daysAgoIso(180),
        updated_at: daysAgoIso(120),
      });
    }

    const reviewTargets = ["review-candidate-a", "review-candidate-b", "review-candidate-c"];
    let sliceCalls = 0;
    runAgentLoopMock.mockImplementation(
      async (
        prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        emit: (event: AgentEvent) => void,
        signal?: AbortSignal,
      ): Promise<AgentMessage[]> => {
        sliceCalls += 1;

        const actionableQueryArgs = {
          limit: 20,
          offset: 0,
        };
        const actionableQueryAssistantMessage = createAssistantToolMessage({
          id: `tool-query-reviewed-actionable-${sliceCalls}`,
          name: "query_candidates",
          arguments: actionableQueryArgs,
          reasoning: "Load the actionable pool again before reviewing the next entry.",
          usage: TEST_USAGE,
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: actionableQueryAssistantMessage,
          args: actionableQueryArgs,
        });

        const allScopeQueryArgs = {
          scope: "all",
          limit: 20,
          offset: 0,
        };
        const allScopeQueryAssistantMessage = createAssistantToolMessage({
          id: `tool-query-reviewed-all-${sliceCalls}`,
          name: "query_candidates",
          arguments: allScopeQueryArgs,
          reasoning: "Confirm the broader pool before deciding what to do next.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: allScopeQueryAssistantMessage,
          args: allScopeQueryArgs,
        });

        if (sliceCalls <= reviewTargets.length) {
          const inspectArgs = {
            entry_id: reviewTargets[sliceCalls - 1] ?? reviewTargets[0],
          };
          const inspectAssistantMessage = createAssistantToolMessage({
            id: `tool-inspect-reviewed-${sliceCalls}`,
            name: "inspect_entry",
            arguments: inspectArgs,
            reasoning: "Review one more candidate before deciding whether the pass is complete.",
          });
          await executeToolCall({
            context,
            config,
            emit,
            signal,
            assistantMessage: inspectAssistantMessage,
            args: inspectArgs,
          });
          return [...prompts, actionableQueryAssistantMessage, allScopeQueryAssistantMessage, inspectAssistantMessage];
        }

        const completeArgs = {
          actions_taken: 0,
          entries_skipped: reviewTargets.map((entryId) => ({
            entry_id: entryId,
            reason: "Reviewed during the bounded slice and kept active.",
          })),
          observations: ["Reviewed all same-page retirement candidates without finding a safe mutation."],
          recommendations: [],
        };
        const completeAssistantMessage = createAssistantToolMessage({
          id: "tool-complete-reviewed-retirement",
          name: "complete_pass",
          arguments: completeArgs,
          reasoning: "All reviewed candidates were intentionally kept.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: completeAssistantMessage,
          args: completeArgs,
        });
        return [...prompts, actionableQueryAssistantMessage, allScopeQueryAssistantMessage, completeAssistantMessage];
      },
    );

    const result = await runSurgeon(createRunOptions(), {
      port: createSurgeonPort(db),
      config: null,
      model: TEST_MODEL,
      now: () => TEST_NOW,
    });

    expect(result).toMatchObject({
      status: "completed",
      passType: "retirement",
    });
    expect(result.actionsSkipped).toBe(3);
    expect(result.reviewedEntries).toBe(3);
    expect(sliceCalls).toBe(4);
    expect(await getLastSurgeonRun(db)).toMatchObject({
      status: "completed",
      actionsSkipped: 3,
    });
  });

  it("reports when a stalled pass already persisted meaningful work", async () => {
    const db = await createTestDatabase(databases);
    await insertEntry(db, {
      id: "stall-after-retire",
      subject: "Retire before stall",
      type: "fact",
      importance: 2,
      expiry: "temporary",
      recall_count: 0,
      created_at: daysAgoIso(180),
      updated_at: daysAgoIso(90),
    });
    let sliceCalls = 0;
    runAgentLoopMock.mockImplementation(
      async (
        prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        emit: (event: AgentEvent) => void,
        signal?: AbortSignal,
      ): Promise<AgentMessage[]> => {
        sliceCalls += 1;

        if (sliceCalls === 1) {
          const queryArgs = {
            limit: 20,
            offset: 0,
          };
          const queryAssistantMessage = createAssistantToolMessage({
            id: "tool-query-stall-after-work",
            name: "query_candidates",
            arguments: queryArgs,
            reasoning: "Inspect the actionable retirement pool first.",
            usage: TEST_USAGE,
          });
          await executeToolCall({
            context,
            config,
            emit,
            signal,
            assistantMessage: queryAssistantMessage,
            args: queryArgs,
          });

          const retireArgs = {
            entry_id: "stall-after-retire",
            reason: "This temporary artifact is obsolete.",
          };
          const retireAssistantMessage = createAssistantToolMessage({
            id: "tool-retire-before-stall",
            name: "retire_entry",
            arguments: retireArgs,
            reasoning: "There is one clear safe retirement before the run stalls.",
          });
          await executeToolCall({
            context,
            config,
            emit,
            signal,
            assistantMessage: retireAssistantMessage,
            args: retireArgs,
          });

          return [...prompts, queryAssistantMessage, retireAssistantMessage];
        }

        return prompts;
      },
    );

    const result = await runSurgeon(
      createRunOptions({
        apply: true,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "stalled",
      actionsTaken: 1,
      entriesRetired: 1,
      summary: "The retirement pass stalled after persisting 1 non-skip action, including 1 retirement.",
    });
    expect(await getLastSurgeonRun(db)).toMatchObject({
      status: "stalled",
      actionsTaken: 1,
      entriesRetired: 1,
    });
  });

  it("returns no_work for proposal_resolution when no eligible proposal backlog exists", async () => {
    const db = await createTestDatabase(databases);

    const result = await runSurgeon(
      createRunOptions({
        pass: "proposal_resolution",
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "no_work",
      passType: "proposal_resolution",
      summary: "No eligible surgeon proposals were available for autonomous resolution.",
    });
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("applies eligible proposals during the proposal_resolution pass", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "proposal-entry",
      subject: "Pager owner",
      type: "fact",
      importance: 8,
      expiry: "permanent",
      created_at: daysAgoIso(40),
      updated_at: daysAgoIso(40),
    });
    const proposalRunId = await createSurgeonRun(db, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(2),
    });
    await logSurgeonProposal(db, {
      id: "proposal-eligible-1",
      runId: proposalRunId,
      groupId: "group-eligible-1",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["proposal-entry"],
      currentClaimKeys: [],
      proposedClaimKeys: ["ops/pager_owner"],
      rationale: "The subject clearly identifies the pager owner slot.",
      confidence: 0.93,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: daysAgoIso(2),
    });

    const result = await runSurgeon(
      createRunOptions({
        pass: "proposal_resolution",
        apply: true,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      passType: "proposal_resolution",
      actionsTaken: 1,
    });
    await expect(readClaimKey(db, "proposal-entry")).resolves.toBe("ops/pager_owner");

    const proposals = await db.execute({
      sql: "SELECT review_status, applied_action_count FROM surgeon_run_proposals WHERE id = ?",
      args: ["proposal-eligible-1"],
    });
    expect(proposals.rows[0]).toEqual({
      review_status: "applied",
      applied_action_count: 1,
    });
  });

  it("emits operator-visible proposal resolution progress", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    const progress: SurgeonProgressEvent[] = [];
    await insertEntry(db, {
      id: "proposal-entry",
      subject: "Pager owner",
      type: "fact",
      importance: 8,
      expiry: "permanent",
      created_at: daysAgoIso(40),
      updated_at: daysAgoIso(40),
    });
    const proposalRunId = await createSurgeonRun(db, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(2),
    });
    await logSurgeonProposal(db, {
      id: "proposal-eligible-progress-1",
      runId: proposalRunId,
      groupId: "group-eligible-progress-1",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["proposal-entry"],
      currentClaimKeys: [],
      proposedClaimKeys: ["ops/pager_owner"],
      rationale: "The subject clearly identifies the pager owner slot.",
      confidence: 0.93,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: daysAgoIso(2),
    });

    const result = await runSurgeon(
      createRunOptions({
        pass: "proposal_resolution",
        apply: true,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
        reportProgress: (event) => progress.push(event),
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      passType: "proposal_resolution",
      actionsTaken: 1,
    });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal_resolution_progress",
          status: "started",
          totalProposals: 1,
          processedProposals: 0,
          rejectedInvalidCount: 0,
        }),
        expect.objectContaining({
          kind: "proposal_resolution_progress",
          status: "proposal_processed",
          processedProposals: 1,
          appliedCount: 1,
          rejectedInvalidCount: 0,
          outcome: "applied",
          targetedEntryCount: 1,
        }),
        expect.objectContaining({
          kind: "proposal_resolution_progress",
          status: "completed",
          processedProposals: 1,
          appliedCount: 1,
          rejectedInvalidCount: 0,
          targetedEntryCount: 1,
        }),
      ]),
    );
  });

  it("rejects malformed eligible proposals and continues resolving the remaining backlog", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    const progress: SurgeonProgressEvent[] = [];
    await insertEntry(db, {
      id: "proposal-valid-entry",
      subject: "Pager owner",
      type: "fact",
      importance: 8,
      expiry: "permanent",
      created_at: daysAgoIso(40),
      updated_at: daysAgoIso(40),
    });
    const proposalRunId = await createSurgeonRun(db, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(2),
    });
    await logSurgeonProposal(db, {
      id: "proposal-malformed-eligible-1",
      runId: proposalRunId,
      groupId: "group-malformed-eligible-1",
      issueKind: "entity_family_convergence",
      scope: "cluster",
      entryIds: ["proposal-valid-entry"],
      currentClaimKeys: [],
      proposedClaimKeys: ["ops/pager_owner", "ops/oncall_owner"],
      rationale: "Ambiguous family convergence target.",
      confidence: 0.93,
      source: "entity_family_canonical_candidate",
      eligibleForApply: true,
      createdAt: daysAgoIso(2),
    });
    await logSurgeonProposal(db, {
      id: "proposal-valid-eligible-1",
      runId: proposalRunId,
      groupId: "group-valid-eligible-1",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["proposal-valid-entry"],
      currentClaimKeys: [],
      proposedClaimKeys: ["ops/pager_owner"],
      rationale: "The subject clearly identifies the pager owner slot.",
      confidence: 0.93,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: daysAgoIso(2),
    });

    const result = await runSurgeon(
      createRunOptions({
        pass: "proposal_resolution",
        apply: true,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
        reportProgress: (event) => progress.push(event),
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      passType: "proposal_resolution",
      actionsTaken: 1,
    });
    await expect(readClaimKey(db, "proposal-valid-entry")).resolves.toBe("ops/pager_owner");

    const malformedProposal = await db.execute({
      sql: "SELECT review_status, review_reason, applied_action_count FROM surgeon_run_proposals WHERE id = ?",
      args: ["proposal-malformed-eligible-1"],
    });
    expect(malformedProposal.rows[0]).toEqual({
      review_status: "rejected",
      review_reason: "Proposal proposal-malformed-eligible-1 cannot be applied automatically because it does not resolve to exactly one proposed claim key.",
      applied_action_count: 0,
    });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal_resolution_progress",
          status: "proposal_processed",
          processedProposals: 1,
          appliedCount: 0,
          rejectedInvalidCount: 1,
          outcome: "rejected_invalid",
        }),
        expect.objectContaining({
          kind: "proposal_resolution_progress",
          status: "completed",
          processedProposals: 2,
          appliedCount: 1,
          rejectedInvalidCount: 1,
          targetedEntryCount: 1,
        }),
      ]),
    );
  });

  it("rejects stale eligible proposals when all target entries are already inactive", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "proposal-stale-entry",
      subject: "Deprecated pager owner",
      type: "fact",
      importance: 6,
      expiry: "permanent",
      created_at: daysAgoIso(40),
      updated_at: daysAgoIso(40),
    });
    await db.execute({
      sql: `
        UPDATE entries
        SET retired = 1,
            retired_at = ?,
            retired_reason = ?
        WHERE id = ?
      `,
      args: [TEST_NOW.toISOString(), "No longer active.", "proposal-stale-entry"],
    });

    const proposalRunId = await createSurgeonRun(db, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(2),
    });
    await logSurgeonProposal(db, {
      id: "proposal-stale-eligible-1",
      runId: proposalRunId,
      groupId: "group-stale-eligible-1",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["proposal-stale-entry"],
      currentClaimKeys: [],
      proposedClaimKeys: ["ops/pager_owner"],
      rationale: "The subject still maps to the pager owner slot.",
      confidence: 0.93,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: daysAgoIso(2),
    });

    const result = await runSurgeon(
      createRunOptions({
        pass: "proposal_resolution",
        apply: true,
      }),
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      passType: "proposal_resolution",
      actionsTaken: 0,
    });

    const proposals = await db.execute({
      sql: "SELECT review_status, review_reason, applied_action_count FROM surgeon_run_proposals WHERE id = ?",
      args: ["proposal-stale-eligible-1"],
    });
    expect(proposals.rows[0]).toEqual({
      review_status: "rejected",
      review_reason: "Autonomous eligible proposal could not be applied because all target entries are inactive or retired.",
      applied_action_count: 0,
    });
  });

  it("refreshes autonomous work after claim_key_quality before deciding whether proposal_resolution should run", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "claim-noncanonical-refresh",
      subject: "Jim editor preference",
      type: "preference",
      importance: 9,
      claim_key: " Jim / Editor ",
      created_at: daysAgoIso(80),
      updated_at: daysAgoIso(80),
    });
    await insertEntry(db, {
      id: "proposal-refresh-entry",
      subject: "Pager owner",
      type: "fact",
      importance: 8,
      expiry: "permanent",
      created_at: daysAgoIso(40),
      updated_at: daysAgoIso(40),
    });
    const proposalRunId = await createSurgeonRun(db, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(2),
    });
    await logSurgeonProposal(db, {
      id: "proposal-refresh-eligible-1",
      runId: proposalRunId,
      groupId: "group-refresh-eligible-1",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["proposal-refresh-entry"],
      currentClaimKeys: [],
      proposedClaimKeys: ["ops/pager_owner"],
      rationale: "The subject clearly identifies the pager owner slot.",
      confidence: 0.93,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: daysAgoIso(2),
    });

    const basePort = createSurgeonPort(db);
    let healthCalls = 0;
    const port = {
      ...basePort,
      async getHealthStats(input: Parameters<typeof basePort.getHealthStats>[0]) {
        const health = await basePort.getHealthStats(input);
        healthCalls += 1;
        if (healthCalls === 1) {
          return {
            ...health,
            eligibleProposalBacklogCount: 0,
          };
        }
        return health;
      },
    };

    const result = await runAutonomousSurgeon(
      {
        budget: 0.2,
        apply: true,
        contextLimit: 4_096,
        verbose: false,
        json: false,
      },
      {
        port,
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      cyclesCompleted: 1,
      status: "completed",
    });
    expect(result.passes.map((pass) => pass.passType)).toEqual(["claim_key_quality", "proposal_resolution"]);
    await expect(readClaimKey(db, "proposal-refresh-entry")).resolves.toBe("ops/pager_owner");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("stalls autonomous dry-run mode when eligible proposal work repeats without direct progress", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "proposal-dry-run-entry",
      subject: "Pager owner",
      type: "fact",
      importance: 8,
      expiry: "permanent",
      claim_key: "ops/pager_owner",
      created_at: daysAgoIso(40),
      updated_at: daysAgoIso(40),
    });
    const proposalRunId = await createSurgeonRun(db, {
      passType: "claim_key_quality",
      dryRun: true,
      startedAt: daysAgoIso(2),
    });
    await logSurgeonProposal(db, {
      id: "proposal-dry-run-eligible-1",
      runId: proposalRunId,
      groupId: "group-dry-run-eligible-1",
      issueKind: "missing_claim_key",
      scope: "single_entry",
      entryIds: ["proposal-dry-run-entry"],
      currentClaimKeys: ["ops/pager_owner"],
      proposedClaimKeys: ["ops/pager_owner"],
      rationale: "The slot is already clear and eligible for autonomous application.",
      confidence: 0.93,
      source: "mixed_group_consensus",
      eligibleForApply: true,
      createdAt: daysAgoIso(2),
    });

    const result = await runAutonomousSurgeon(
      {
        budget: 0.2,
        apply: false,
        contextLimit: 4_096,
        verbose: false,
        json: false,
      },
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      cyclesCompleted: 1,
      status: "stalled",
      summary: "Autonomous surgeon cycle stopped making direct progress.",
    });
    expect(result.passes.map((pass) => pass.passType)).toEqual(["claim_key_quality", "proposal_resolution"]);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("stops the autonomous run at the low-yield retirement tail before another generic no-op cycle", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "retirement-tail-fact",
      subject: "Retirement tail fact",
      type: "fact",
      importance: 4,
      expiry: "permanent",
      recall_count: 0,
      created_at: daysAgoIso(120),
      updated_at: daysAgoIso(90),
    });
    runAgentLoopMock.mockImplementation(
      async (
        prompts: AgentMessage[],
        context: AgentContext,
        config: AgentLoopConfig,
        emit: (event: AgentEvent) => void,
        signal?: AbortSignal,
      ): Promise<AgentMessage[]> => {
        const actionableQueryArgs = {
          limit: 20,
          offset: 0,
        };
        const actionableQueryAssistantMessage = createAssistantToolMessage({
          id: "tool-query-retirement-tail-actionable",
          name: "query_candidates",
          arguments: actionableQueryArgs,
          reasoning: "Check the actionable retirement pool first.",
          usage: TEST_USAGE,
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: actionableQueryAssistantMessage,
          args: actionableQueryArgs,
        });

        const allScopeQueryArgs = {
          scope: "all",
          limit: 20,
          offset: 0,
        };
        const allScopeQueryAssistantMessage = createAssistantToolMessage({
          id: "tool-query-retirement-tail-all",
          name: "query_candidates",
          arguments: allScopeQueryArgs,
          reasoning: "Widen the retirement sweep before deciding to stop.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: allScopeQueryAssistantMessage,
          args: allScopeQueryArgs,
        });

        const completeArgs = {
          actions_taken: 0,
          entries_skipped: [],
          observations: ["No safe retirement action was confirmed."],
          recommendations: ["Stop once the broader retirement surface stops changing."],
        };
        const completeAssistantMessage = createAssistantToolMessage({
          id: "tool-complete-retirement-tail",
          name: "complete_pass",
          arguments: completeArgs,
          reasoning: "The current retirement slice did not surface a safe mutation.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: completeAssistantMessage,
          args: completeArgs,
        });

        return [...prompts, actionableQueryAssistantMessage, allScopeQueryAssistantMessage, completeAssistantMessage];
      },
    );

    const result = await runAutonomousSurgeon(
      {
        budget: 0.2,
        apply: true,
        contextLimit: 4_096,
        verbose: false,
        json: false,
      },
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      cyclesCompleted: 1,
      status: "stalled",
      summary: "Autonomous retirement tail stopped making direct progress.",
    });
    expect(result.passes.map((pass) => pass.passType)).toEqual(["claim_key_quality", "retirement"]);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

  it("completes autonomous supersession when the remaining cluster is reviewed but intentionally unlinked", async () => {
    const db = await createDatabase(":memory:");
    databases.push(db);
    await insertEntry(db, {
      id: "mixed-type-lesson",
      subject: "memory strategy rationale",
      type: "lesson",
      importance: 8,
      expiry: "permanent",
      claim_key: "agenr/memory_strategy",
      created_at: daysAgoIso(60),
      updated_at: daysAgoIso(60),
    });
    await insertEntry(db, {
      id: "mixed-type-decision",
      subject: "memory strategy decision",
      type: "decision",
      importance: 9,
      expiry: "permanent",
      claim_key: "agenr/memory_strategy",
      created_at: daysAgoIso(10),
      updated_at: daysAgoIso(10),
    });
    mockNoOpSupersessionRunAgentLoop();

    const result = await runAutonomousSurgeon(
      {
        budget: 0.2,
        apply: false,
        contextLimit: 4_096,
        verbose: false,
        json: false,
      },
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      cyclesCompleted: 1,
      status: "completed",
    });
    expect(result.passes.map((pass) => pass.passType)).toEqual(["claim_key_quality", "supersession"]);
    expect(runAgentLoopMock).toHaveBeenCalled();
  });

  it("repeats the autonomous sequence until direct work is exhausted", async () => {
    const db = await createTestDatabase(databases);
    await insertEntry(db, {
      id: "claim-noncanonical-autonomous",
      subject: "Jim editor preference",
      type: "preference",
      importance: 9,
      claim_key: " Jim / Editor ",
      created_at: daysAgoIso(80),
      updated_at: daysAgoIso(80),
    });
    await insertEntry(db, {
      id: "slot-old",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(50),
      updated_at: daysAgoIso(50),
    });
    await insertEntry(db, {
      id: "slot-new",
      subject: "Mac mini update policy clarified",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(10),
      updated_at: daysAgoIso(10),
    });
    mockAutonomousCompletionRunAgentLoop();

    const result = await runAutonomousSurgeon(
      {
        budget: 0.2,
        apply: true,
        contextLimit: 4_096,
        verbose: false,
        json: false,
      },
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      cyclesCompleted: 2,
      status: "completed",
    });
    expect(result.passes.map((pass) => pass.passType)).toEqual(["claim_key_quality", "supersession", "retirement", "retirement"]);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(3);
    await expect(readClaimKey(db, "claim-noncanonical-autonomous")).resolves.toBe("jim/editor");
    await expect(readRetiredFlag(db, "stale-temp")).resolves.toBe(true);
    await expect(readRetiredFlag(db, "stale-milestone")).resolves.toBe(false);
    await expect(readImportance(db, "stale-milestone")).resolves.toBe(4);
    await expect(readSupersededBy(db, "slot-old")).resolves.toBe("slot-new");
  });

  it("creates one backup for an autonomous apply run even when multiple passes execute", async () => {
    const db = await createTestDatabase(databases);
    await insertEntry(db, {
      id: "claim-noncanonical-autonomous",
      subject: "Jim editor preference",
      type: "preference",
      importance: 9,
      claim_key: " Jim / Editor ",
      created_at: daysAgoIso(80),
      updated_at: daysAgoIso(80),
    });
    await insertEntry(db, {
      id: "slot-old",
      subject: "Mac mini update policy",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(50),
      updated_at: daysAgoIso(50),
    });
    await insertEntry(db, {
      id: "slot-new",
      subject: "Mac mini update policy clarified",
      type: "preference",
      claim_key: "mac_mini/manual_update_policy",
      created_at: daysAgoIso(10),
      updated_at: daysAgoIso(10),
    });
    const backupDb = vi.fn(async () => "/tmp/knowledge.db.surgeon-backup");
    mockAutonomousCompletionRunAgentLoop();

    const result = await runAutonomousSurgeon(
      {
        budget: 0.2,
        apply: true,
        contextLimit: 4_096,
        verbose: false,
        json: false,
      },
      {
        port: createSurgeonPort(db),
        dbPath: "/tmp/knowledge.db",
        backupDb,
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      cyclesCompleted: 2,
      status: "completed",
    });
    expect(backupDb).toHaveBeenCalledTimes(1);
    expect(backupDb).toHaveBeenCalledWith("/tmp/knowledge.db");
  });

  it("stops the autonomous sequence when a pass hits the cost cap", async () => {
    const db = await createTestDatabase(databases);
    mockSuccessfulRunAgentLoop();

    const result = await runAutonomousSurgeon(
      {
        budget: 0.01,
        apply: false,
        contextLimit: 4_096,
        verbose: false,
        json: false,
      },
      {
        port: createSurgeonPort(db),
        config: null,
        model: TEST_MODEL,
        now: () => TEST_NOW,
      },
    );

    expect(result).toMatchObject({
      cyclesCompleted: 1,
      status: "cost_capped",
    });
    expect(result.passes.map((pass) => pass.passType)).toEqual(["claim_key_quality", "retirement"]);
  });
});

function createRunOptions(overrides: Partial<SurgeonRunOptions> = {}): SurgeonRunOptions {
  return {
    pass: "retirement",
    budget: 1,
    contextLimit: 4_096,
    apply: false,
    verbose: false,
    json: false,
    ...overrides,
  };
}

async function createTempDirectory(tempPaths: string[], prefix: string): Promise<string> {
  const tempPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}

async function createTestDatabase(databases: SqlDatabase[]): Promise<SqlDatabase> {
  const db = await createDatabase(":memory:");
  databases.push(db);

  await insertEntry(db, {
    id: "stale-temp",
    subject: "Session handoff for surgeon cleanup",
    type: "fact",
    importance: 2,
    expiry: "temporary",
    recall_count: 0,
    quality_score: 0.3,
    tags: ["alpha"],
    source_file: "/tmp/session-1.jsonl",
    created_at: daysAgoIso(120),
    updated_at: daysAgoIso(90),
  });
  await insertEntry(db, {
    id: "stale-milestone",
    subject: "retired rollout checklist completion",
    type: "milestone",
    importance: 5,
    expiry: "permanent",
    recall_count: 0,
    quality_score: 0.4,
    tags: ["alpha"],
    source_file: "/tmp/session-2.jsonl",
    created_at: daysAgoIso(100),
    updated_at: daysAgoIso(70),
  });
  await insertEntry(db, {
    id: "recent-recall",
    subject: "Recently recalled implementation note",
    type: "fact",
    importance: 4,
    expiry: "temporary",
    recall_count: 1,
    last_recalled_at: daysAgoIso(3),
    quality_score: 0.6,
    created_at: daysAgoIso(30),
    updated_at: daysAgoIso(3),
  });
  await insertEntry(db, {
    id: "durable-decision",
    subject: "Use libsql for the v1 corpus store",
    type: "decision",
    importance: 9,
    expiry: "permanent",
    recall_count: 2,
    quality_score: 0.9,
    created_at: daysAgoIso(180),
    updated_at: daysAgoIso(10),
  });

  return db;
}

async function insertEntry(db: SqlDatabase, overrides: Partial<Entry> & Pick<Entry, "id" | "subject">): Promise<void> {
  const entry = buildEntry(overrides);
  await db.execute({
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
        valid_from,
        valid_to,
        claim_key,
        supersession_kind,
        supersession_reason,
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      entry.id,
      entry.type,
      entry.subject,
      entry.content,
      entry.importance,
      entry.expiry,
      JSON.stringify(entry.tags),
      entry.source_file ?? null,
      entry.source_context ?? null,
      null,
      entry.content_hash ?? null,
      entry.norm_content_hash ?? null,
      null,
      entry.quality_score,
      entry.recall_count,
      entry.last_recalled_at ?? null,
      entry.superseded_by ?? null,
      entry.valid_from ?? null,
      entry.valid_to ?? null,
      entry.claim_key ?? null,
      entry.supersession_kind ?? null,
      entry.supersession_reason ?? null,
      entry.cluster_id ?? null,
      entry.retired ? 1 : 0,
      entry.retired_at ?? null,
      entry.retired_reason ?? null,
      entry.created_at,
      entry.updated_at,
    ],
  });
}

function buildEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "subject">): Entry {
  return {
    id: overrides.id,
    type: overrides.type ?? "fact",
    subject: overrides.subject,
    content: overrides.content ?? `content for ${overrides.id}`,
    importance: overrides.importance ?? 3,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash ?? `${overrides.id}-hash`,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? daysAgoIso(30),
    updated_at: overrides.updated_at ?? overrides.created_at ?? daysAgoIso(30),
  };
}

function mockSuccessfulRunAgentLoop(): void {
  runAgentLoopMock.mockImplementation(
    async (
      prompts: AgentMessage[],
      context: AgentContext,
      config: AgentLoopConfig,
      emit: (event: AgentEvent) => void,
      signal?: AbortSignal,
    ): Promise<AgentMessage[]> => {
      const actionableQueryArgs = {
        limit: 20,
        offset: 0,
      };
      const actionableQueryAssistantMessage = createAssistantToolMessage({
        id: "tool-query-actionable",
        name: "query_candidates",
        arguments: actionableQueryArgs,
        reasoning: "Checking the actionable cleanup pool first.",
        usage: TEST_USAGE,
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: actionableQueryAssistantMessage,
        args: actionableQueryArgs,
      });

      const allScopeQueryArgs = {
        scope: "all",
        limit: 20,
        offset: 0,
      };
      const allScopeQueryAssistantMessage = createAssistantToolMessage({
        id: "tool-query-all",
        name: "query_candidates",
        arguments: allScopeQueryArgs,
        reasoning: "The actionable scope is exhausted, so widen to the broader candidate pool.",
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: allScopeQueryAssistantMessage,
        args: allScopeQueryArgs,
      });

      const completeArgs = {
        actions_taken: 0,
        entries_skipped: [{ entry_id: "stale-milestone", reason: "Needs another pass." }],
        observations: ["Dry-run sweep complete."],
        recommendations: ["Broaden to all scope if budget remains."],
      };
      const completeAssistantMessage = createAssistantToolMessage({
        id: "tool-complete",
        name: "complete_pass",
        arguments: completeArgs,
        reasoning: "The actionable scope is exhausted for this dry run.",
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: completeAssistantMessage,
        args: completeArgs,
      });

      return [...prompts, actionableQueryAssistantMessage, allScopeQueryAssistantMessage, completeAssistantMessage];
    },
  );
}

function mockSuccessfulSupersessionRunAgentLoop(): void {
  runAgentLoopMock.mockImplementation(
    async (
      prompts: AgentMessage[],
      context: AgentContext,
      config: AgentLoopConfig,
      emit: (event: AgentEvent) => void,
      signal?: AbortSignal,
    ): Promise<AgentMessage[]> => {
      const queryArgs = {
        scope: "claim_key",
        limit: 20,
        offset: 0,
      };
      const queryAssistantMessage = createAssistantToolMessage({
        id: "tool-query-supersession",
        name: "query_supersession_candidates",
        arguments: queryArgs,
        reasoning: "Start with the claim_key sweep before widening the review.",
        usage: TEST_USAGE,
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: queryAssistantMessage,
        args: queryArgs,
      });

      const linkArgs = {
        old_entry_id: "policy-old",
        new_entry_id: "policy-new",
        kind: "duplicate",
        reason: "These preferences say the same thing. Keep the newer wording as the survivor.",
      };
      const linkAssistantMessage = createAssistantToolMessage({
        id: "tool-link-supersession",
        name: "link_supersession",
        arguments: linkArgs,
        reasoning: "This is a clear duplicate pair in the same claim_key slot.",
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: linkAssistantMessage,
        args: linkArgs,
      });

      const completeArgs = {
        actions_taken: 1,
        entries_skipped: [],
        observations: ["Resolved one duplicate supersession pair."],
        recommendations: ["Run the subject sweep later if more budget is available."],
      };
      const completeAssistantMessage = createAssistantToolMessage({
        id: "tool-complete-supersession",
        name: "complete_pass",
        arguments: completeArgs,
        reasoning: "The claim_key sweep is complete for this focused run.",
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: completeAssistantMessage,
        args: completeArgs,
      });

      return [...prompts, queryAssistantMessage, linkAssistantMessage, completeAssistantMessage];
    },
  );
}

function mockAutonomousCompletionRunAgentLoop(): void {
  let retirementRuns = 0;

  runAgentLoopMock.mockImplementation(
    async (
      prompts: AgentMessage[],
      context: AgentContext,
      config: AgentLoopConfig,
      emit: (event: AgentEvent) => void,
      signal?: AbortSignal,
    ): Promise<AgentMessage[]> => {
      const toolNames = new Set((context.tools ?? []).map((tool) => tool.name));

      if (toolNames.has("query_supersession_candidates")) {
        const queryArgs = {
          scope: "claim_key",
          limit: 20,
          offset: 0,
        };
        const queryAssistantMessage = createAssistantToolMessage({
          id: "tool-query-supersession",
          name: "query_supersession_candidates",
          arguments: queryArgs,
          reasoning: "Start with the claim_key sweep before widening the review.",
          usage: TEST_USAGE,
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: queryAssistantMessage,
          args: queryArgs,
        });

        const linkArgs = {
          old_entry_id: "slot-old",
          new_entry_id: "slot-new",
          kind: "duplicate",
          reason: "These preferences say the same thing. Keep the newer wording as the survivor.",
        };
        const linkAssistantMessage = createAssistantToolMessage({
          id: "tool-link-supersession",
          name: "link_supersession",
          arguments: linkArgs,
          reasoning: "This is a clear duplicate pair in the same claim_key slot.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: linkAssistantMessage,
          args: linkArgs,
        });

        const completeArgs = {
          actions_taken: 1,
          entries_skipped: [],
          observations: ["Resolved one duplicate supersession pair."],
          recommendations: ["Continue the autonomous cleanup sweep."],
        };
        const completeAssistantMessage = createAssistantToolMessage({
          id: "tool-complete-supersession",
          name: "complete_pass",
          arguments: completeArgs,
          reasoning: "The claim_key sweep is complete for this autonomous cycle.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: completeAssistantMessage,
          args: completeArgs,
        });

        return [...prompts, queryAssistantMessage, linkAssistantMessage, completeAssistantMessage];
      }

      if (toolNames.has("retire_entry")) {
        const targetEntryId = retirementRuns === 0 ? "stale-temp" : "stale-milestone";
        retirementRuns += 1;

        const actionableQueryArgs = {
          limit: 20,
          offset: 0,
        };
        const actionableQueryAssistantMessage = createAssistantToolMessage({
          id: `tool-query-retirement-actionable-${retirementRuns}`,
          name: "query_candidates",
          arguments: actionableQueryArgs,
          reasoning: "Load the next retirement candidates.",
          usage: TEST_USAGE,
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: actionableQueryAssistantMessage,
          args: actionableQueryArgs,
        });

        const allScopeQueryArgs = {
          scope: "all",
          limit: 20,
          offset: 0,
        };
        const allScopeQueryAssistantMessage = createAssistantToolMessage({
          id: `tool-query-retirement-all-${retirementRuns}`,
          name: "query_candidates",
          arguments: allScopeQueryArgs,
          reasoning: "Widen the retirement sweep before completing the slice.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: allScopeQueryAssistantMessage,
          args: allScopeQueryArgs,
        });

        if (targetEntryId === "stale-temp") {
          const retireArgs = {
            entry_id: targetEntryId,
            reason: "This stale entry is safe to retire in the autonomous cleanup run.",
          };
          const retireAssistantMessage = createAssistantToolMessage({
            id: `tool-retire-${retirementRuns}`,
            name: "retire_entry",
            arguments: retireArgs,
            reasoning: "Retire the oldest safe candidate first.",
          });
          await executeToolCall({
            context,
            config,
            emit,
            signal,
            assistantMessage: retireAssistantMessage,
            args: retireArgs,
          });

          const completeArgs = {
            actions_taken: 1,
            entries_skipped: [],
            observations: [`Retired ${targetEntryId}.`],
            recommendations: ["Continue the autonomous cleanup sweep."],
          };
          const completeAssistantMessage = createAssistantToolMessage({
            id: `tool-complete-retirement-${retirementRuns}`,
            name: "complete_pass",
            arguments: completeArgs,
            reasoning: "The current retirement slice is complete.",
          });
          await executeToolCall({
            context,
            config,
            emit,
            signal,
            assistantMessage: completeAssistantMessage,
            args: completeArgs,
          });

          return [...prompts, actionableQueryAssistantMessage, allScopeQueryAssistantMessage, retireAssistantMessage, completeAssistantMessage];
        }

        const updateArgs = {
          entry_id: targetEntryId,
          importance: 4,
          reasoning: "The milestone remains historically true, but it should be slightly less prominent than top-tier durable recall.",
        };
        const updateAssistantMessage = createAssistantToolMessage({
          id: `tool-update-${retirementRuns}`,
          name: "update_entry",
          arguments: updateArgs,
          reasoning: "Permanent milestones should be demoted instead of retired.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: updateAssistantMessage,
          args: updateArgs,
        });

        const completeArgs = {
          actions_taken: 1,
          entries_skipped: [],
          observations: [`Demoted ${targetEntryId}.`],
          recommendations: ["Continue the autonomous cleanup sweep."],
        };
        const completeAssistantMessage = createAssistantToolMessage({
          id: `tool-complete-retirement-${retirementRuns}`,
          name: "complete_pass",
          arguments: completeArgs,
          reasoning: "The current retirement slice is complete.",
        });
        await executeToolCall({
          context,
          config,
          emit,
          signal,
          assistantMessage: completeAssistantMessage,
          args: completeArgs,
        });

        return [...prompts, actionableQueryAssistantMessage, allScopeQueryAssistantMessage, updateAssistantMessage, completeAssistantMessage];
      }

      throw new Error("Unexpected tool set for autonomous surgeon test.");
    },
  );
}

function mockNoOpSupersessionRunAgentLoop(): void {
  runAgentLoopMock.mockImplementation(
    async (
      prompts: AgentMessage[],
      context: AgentContext,
      config: AgentLoopConfig,
      emit: (event: AgentEvent) => void,
      signal?: AbortSignal,
    ): Promise<AgentMessage[]> => {
      const toolNames = new Set((context.tools ?? []).map((tool) => tool.name));
      if (!toolNames.has("query_supersession_candidates")) {
        throw new Error("Unexpected tool set for no-op supersession test.");
      }

      const queryArgs = {
        scope: "claim_key",
        limit: 20,
        offset: 0,
      };
      const queryAssistantMessage = createAssistantToolMessage({
        id: "tool-query-noop-supersession",
        name: "query_supersession_candidates",
        arguments: queryArgs,
        reasoning: "Inspect the claim_key sweep before deciding whether any lineage is warranted.",
        usage: TEST_USAGE,
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: queryAssistantMessage,
        args: queryArgs,
      });

      const completeArgs = {
        actions_taken: 0,
        entries_skipped: [
          {
            entry_id: "mixed-type-lesson",
            reason: "The lesson and decision share a claim key but occupy different semantic slots.",
          },
          {
            entry_id: "mixed-type-decision",
            reason: "The decision is the canonical durable statement for the cluster.",
          },
        ],
        observations: ["Claim-key sweep is exhausted and no safe supersession link exists."],
        recommendations: ["Leave the mixed-type cluster unlinked."],
      };
      const completeAssistantMessage = createAssistantToolMessage({
        id: "tool-complete-noop-supersession",
        name: "complete_pass",
        arguments: completeArgs,
        reasoning: "The claim_key sweep is exhausted and there is nothing safe to link.",
      });
      await executeToolCall({
        context,
        config,
        emit,
        signal,
        assistantMessage: completeAssistantMessage,
        args: completeArgs,
      });

      return [...prompts, queryAssistantMessage, completeAssistantMessage];
    },
  );
}

async function executeToolCall(input: {
  context: AgentContext;
  config: AgentLoopConfig;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  assistantMessage: AssistantMessage;
  args: Record<string, unknown>;
}): Promise<void> {
  const toolCall = getToolCall(input.assistantMessage);
  const beforeResult = await input.config.beforeToolCall?.(
    {
      assistantMessage: input.assistantMessage,
      toolCall,
      args: input.args,
      context: input.context,
    },
    input.signal,
  );
  if (beforeResult?.block) {
    throw new Error(beforeResult.reason ?? `${toolCall.name} was blocked.`);
  }

  const tool = getTool(input.context.tools, toolCall.name);
  const result = await tool.execute(toolCall.id, input.args, input.signal);
  await input.config.afterToolCall?.(
    {
      assistantMessage: input.assistantMessage,
      toolCall,
      args: input.args,
      result,
      isError: false,
      context: input.context,
    },
    input.signal,
  );

  if (input.assistantMessage.usage) {
    input.emit({
      type: "message_end",
      message: input.assistantMessage,
    });
  }
}

function createAssistantToolMessage(input: {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  reasoning: string;
  usage?: Usage;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: input.reasoning,
      },
      {
        type: "toolCall",
        id: input.id,
        name: input.name,
        arguments: input.arguments,
      },
    ],
    timestamp: Date.now(),
    usage: input.usage,
  };
}

function getTool(tools: AgentTool[] | undefined, name: string): AgentTool {
  const tool = tools?.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing test tool: ${name}.`);
  }

  return tool;
}

function getToolCall(message: AssistantMessage): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  if (!toolCall) {
    throw new Error("Expected assistant message to contain a tool call.");
  }

  return toolCall;
}

function getUserMessageText(message: AgentMessage): string {
  if (!("role" in message) || message.role !== "user") {
    throw new Error("Expected a user message.");
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function readClaimKey(db: SqlDatabase, entryId: string): Promise<string | null> {
  const rows = await db.execute({
    sql: "SELECT claim_key FROM entries WHERE id = ?",
    args: [entryId],
  });

  return (rows.rows[0]?.claim_key as string | null | undefined) ?? null;
}

async function readRetiredFlag(db: SqlDatabase, entryId: string): Promise<boolean> {
  const rows = await db.execute({
    sql: "SELECT retired FROM entries WHERE id = ?",
    args: [entryId],
  });

  return rows.rows[0]?.retired === 1;
}

async function readImportance(db: SqlDatabase, entryId: string): Promise<number | null> {
  const rows = await db.execute({
    sql: "SELECT importance FROM entries WHERE id = ?",
    args: [entryId],
  });

  return (rows.rows[0]?.importance as number | null | undefined) ?? null;
}

async function readSupersededBy(db: SqlDatabase, entryId: string): Promise<string | null> {
  const rows = await db.execute({
    sql: "SELECT superseded_by FROM entries WHERE id = ?",
    args: [entryId],
  });

  return (rows.rows[0]?.superseded_by as string | null | undefined) ?? null;
}

function daysAgoIso(days: number): string {
  return new Date(TEST_NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
