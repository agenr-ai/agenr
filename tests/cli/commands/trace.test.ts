import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadDurableTraceRuntimeMock } = vi.hoisted(() => ({
  loadDurableTraceRuntimeMock: vi.fn(),
}));

vi.mock("../../../src/app/memory/inspect.js", () => ({
  loadDurableTraceRuntime: loadDurableTraceRuntimeMock,
}));

import { registerTraceCommand } from "../../../src/cli/commands/trace.js";

describe("registerTraceCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    loadDurableTraceRuntimeMock.mockReset();
    process.exitCode = undefined;
  });

  it("registers the trace command on the program", () => {
    const program = new Command();
    registerTraceCommand(program);

    expect(program.commands.some((command) => command.name() === "trace")).toBe(true);
  });

  it("renders claim-family lineage and timeline sections for one traced entry", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    loadDurableTraceRuntimeMock.mockResolvedValue(createTrace());

    await program.parseAsync(["trace", "--id", "entry-1"], { from: "user" });

    expect(loadDurableTraceRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-1",
        env: process.env,
      }),
    );
    expect(stdout.join("")).toContain("Trace for entry-1 | Jim home city");
    expect(stdout.join("")).toContain("[lineage]");
    expect(stdout.join("")).toContain("claim_family=jim/home_city");
    expect(stdout.join("")).toContain("[timeline]");
    expect(stdout.join("")).toContain("Dream stale");
  });

  it("renders structured JSON trace output when requested", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    loadDurableTraceRuntimeMock.mockResolvedValue(createTrace());

    await program.parseAsync(["trace", "--id", "entry-1", "--json"], { from: "user" });

    expect(JSON.parse(stdout.join(""))).toEqual(
      expect.objectContaining({
        durable: expect.objectContaining({
          id: "entry-1",
          memoryState: "superseded",
        }),
        claimFamily: expect.objectContaining({
          claimKey: "jim/home_city",
          transition: "entry-1 -> entry-2",
        }),
        recall: expect.objectContaining({
          totalCount: 1,
          recentEvents: [{ recalledAt: "2026-03-22T00:00:00.000Z", query: "Jim home city" }],
        }),
        dreamActions: [
          expect.objectContaining({
            actionType: "stale",
            runId: "run-1",
          }),
        ],
        timeline: expect.arrayContaining([
          expect.objectContaining({
            kind: "dream",
          }),
        ]),
      }),
    );
  });
});

function createTrace() {
  return {
    durable: {
      id: "entry-1",
      type: "fact",
      subject: "Jim home city",
      content: "Jim lives in Austin.",
      importance: 7,
      expiry: "permanent",
      tags: [],
      quality_score: 0.5,
      recall_count: 0,
      claim_key: "jim/home_city",
      claim_key_status: "trusted",
      superseded_by: "entry-2",
      created_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-03-01T00:00:00.000Z",
    },
    supersededBy: {
      id: "entry-2",
      type: "fact",
      subject: "Jim home city",
      content: "Jim lives in Denver.",
      importance: 8,
      expiry: "permanent",
      tags: [],
      quality_score: 0.5,
      recall_count: 0,
      claim_key: "jim/home_city",
      claim_key_status: "trusted",
      created_at: "2026-03-20T00:00:00.000Z",
      updated_at: "2026-03-20T00:00:00.000Z",
    },
    supersedes: [],
    claimFamily: {
      claimKey: "jim/home_city",
      slotPolicy: "exclusive",
      slotPolicyReason: 'Attribute head "home" defaults to exclusive current-state shaping.',
      durables: [
        {
          id: "entry-1",
          type: "fact",
          subject: "Jim home city",
          content: "Jim lives in Austin.",
          importance: 7,
          expiry: "permanent",
          tags: [],
          quality_score: 0.5,
          recall_count: 0,
          claim_key: "jim/home_city",
          claim_key_status: "trusted",
          superseded_by: "entry-2",
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-01T00:00:00.000Z",
        },
        {
          id: "entry-2",
          type: "fact",
          subject: "Jim home city",
          content: "Jim lives in Denver.",
          importance: 8,
          expiry: "permanent",
          tags: [],
          quality_score: 0.5,
          recall_count: 0,
          claim_key: "jim/home_city",
          claim_key_status: "trusted",
          created_at: "2026-03-20T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z",
        },
      ],
    },
    recall: {
      totalCount: 1,
      recentEvents: [{ recalledAt: "2026-03-22T00:00:00.000Z", query: "Jim home city" }],
    },
    provenance: {
      sourceFile: "episode:abc",
    },
    dreamActions: [
      {
        id: "action-1",
        runId: "run-1",
        actionType: "stale",
        reasoning: "Dream prune staled a low-signal durable after synthesis.",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    ],
    profileSnapshots: [],
    timeline: [
      {
        at: "2026-03-01T00:00:00.000Z",
        kind: "created",
        label: "Durable created",
      },
      {
        at: "2026-03-21T00:00:00.000Z",
        kind: "dream",
        label: "Dream stale",
        runId: "run-1",
        actionType: "stale",
      },
    ],
  };
}

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
  registerTraceCommand(program);
  return { program, stdout, stderr };
}
