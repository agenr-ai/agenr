import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRecall } from "./recall.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  kill: (signal?: NodeJS.Signals | number) => void;
};

function createMockChild(stdout: string): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.kill = vi.fn();

  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close");
  });

  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("runRecall query args", () => {
  it("omits positional query arg when query is undefined", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "session-start", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234);

    expect(capturedArgs).toEqual([
      "recall",
      "--context",
      "session-start",
      "--budget",
      "1234",
      "--json",
    ]);
  });

  it("omits positional query arg when query is blank", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "session-start", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234, undefined, "   ");

    expect(capturedArgs).toEqual([
      "recall",
      "--context",
      "session-start",
      "--budget",
      "1234",
      "--json",
    ]);
  });

  it("appends trimmed query as positional arg when under 500 chars", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "session-start", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234, undefined, "  what is the status now?  ");

    expect(capturedArgs[capturedArgs.length - 1]).toBe("what is the status now?");
  });

  it("appends truncated 500-char query when query exceeds 500 chars", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "session-start", results: [] }));
    });
    const longQuery = "x".repeat(510);

    await runRecall("/path/to/agenr", 1234, undefined, longQuery);

    const positionalQuery = capturedArgs[capturedArgs.length - 1] ?? "";
    expect(positionalQuery.length).toBe(500);
    expect(positionalQuery).toBe("x".repeat(500));
  });

  it("passes --limit for session-start context when provided", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "session-start", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234, undefined, "status update", {
      context: "session-start",
      limit: 8,
    });

    expect(capturedArgs).toEqual([
      "recall",
      "--context",
      "session-start",
      "--budget",
      "1234",
      "--json",
      "--limit",
      "8",
      "status update",
    ]);
  });

  it("passes --limit for non-browse semantic recall used by mid-session recall", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "Tell me about Ava", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234, undefined, "Tell me about Ava", { limit: 8 });

    expect(capturedArgs).toEqual([
      "recall",
      "--context",
      "session-start",
      "--budget",
      "1234",
      "--json",
      "--limit",
      "8",
      "Tell me about Ava",
    ]);
  });
});

describe("runRecall browse mode args", () => {
  it("uses browse flags and omits budget/context/query by default", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "[browse]", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234, undefined, "ignored query", { context: "browse" });

    expect(capturedArgs).toEqual(["recall", "--browse", "--since", "1d", "--json"]);
  });

  it("uses explicit browse since and keeps --project while omitting query", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "[browse]", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234, "proj-x", "ignored query", {
      context: "browse",
      since: "7d",
    });

    expect(capturedArgs).toEqual(["recall", "--browse", "--since", "7d", "--json", "--project", "proj-x"]);
  });

  it("passes --limit when browse limit is provided", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild(JSON.stringify({ query: "[browse]", results: [] }));
    });

    await runRecall("/path/to/agenr", 1234, undefined, undefined, {
      context: "browse",
      limit: 20,
    });

    expect(capturedArgs).toEqual(["recall", "--browse", "--since", "1d", "--json", "--limit", "20"]);
  });
});
