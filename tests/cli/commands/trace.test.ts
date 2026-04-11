import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadOpenClawEntryTraceRuntimeMock } = vi.hoisted(() => ({
  loadOpenClawEntryTraceRuntimeMock: vi.fn(),
}));

vi.mock("../../../src/app/openclaw/inspect.js", () => ({
  loadOpenClawEntryTraceRuntime: loadOpenClawEntryTraceRuntimeMock,
}));

import { registerTraceCommand } from "../../../src/cli/commands/trace.js";

describe("registerTraceCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    loadOpenClawEntryTraceRuntimeMock.mockReset();
    process.exitCode = undefined;
  });

  it("registers the trace command on the program", () => {
    const program = new Command();
    registerTraceCommand(program);

    expect(program.commands.some((command) => command.name() === "trace")).toBe(true);
  });

  it("renders claim-family lineage for one traced entry", async () => {
    const { program, stdout } = createProgramWithCapturedOutput();
    loadOpenClawEntryTraceRuntimeMock.mockResolvedValue({
      entry: {
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
        retired: false,
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
        retired: false,
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      supersedes: [],
      claimFamily: {
        claimKey: "jim/home_city",
        entries: [
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
            retired: false,
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
            retired: false,
            created_at: "2026-03-20T00:00:00.000Z",
            updated_at: "2026-03-20T00:00:00.000Z",
          },
        ],
      },
      recallEvents: [],
    });

    await program.parseAsync(["trace", "--id", "entry-1"], { from: "user" });

    expect(loadOpenClawEntryTraceRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "entry-1",
        env: process.env,
      }),
    );
    expect(stdout.join("")).toContain("Trace for entry-1 | Jim home city");
    expect(stdout.join("")).toContain("claim_family=jim/home_city | slot_policy=exclusive | entry-1:superseded:trusted, entry-2:current:trusted");
    expect(stdout.join("")).toContain("transition=entry-1 -> entry-2");
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
  registerTraceCommand(program);
  return { program, stdout, stderr };
}
