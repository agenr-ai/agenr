import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { runExtractTool, runRecallTool, runRetireTool, runStoreTool } from "./tools.js";
import type { PluginApi } from "./types.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: (chunk: string) => void;
    end: () => void;
  };
  kill: (signal?: NodeJS.Signals | number) => void;
};

function createMockChild(params?: {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: Error;
}): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn();

  process.nextTick(() => {
    if (params?.error) {
      child.emit("error", params.error);
      return;
    }
    if (params?.stdout) {
      child.stdout.emit("data", Buffer.from(params.stdout));
    }
    if (params?.stderr) {
      child.stderr.emit("data", Buffer.from(params.stderr));
    }
    child.emit("close", params?.code ?? 0);
  });

  return child;
}

function createTimeoutChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn(() => {
    process.nextTick(() => {
      child.emit("close", null);
    });
  });
  return child;
}

function makeApi(overrides?: Partial<PluginApi>): PluginApi {
  return {
    id: "agenr",
    name: "agenr memory context",
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn() as unknown as PluginApi["on"],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("openclaw plugin tool registration", () => {
  it("registers all four tools when registerTool is present", () => {
    const registerTool = vi.fn();
    const api = makeApi({ registerTool });

    plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(4);
    const names = registerTool.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(names).toEqual([
      "agenr_recall",
      "agenr_store",
      "agenr_extract",
      "agenr_retire",
    ]);
  });

  it("skips tool registration when registerTool is absent", () => {
    const api = makeApi();
    expect(() => plugin.register(api)).not.toThrow();
  });
});

describe("openclaw plugin tool runners", () => {
  it("runRecallTool returns text content on success", async () => {
    spawnMock.mockReturnValueOnce(
      createMockChild({
        stdout: JSON.stringify({
          query: "test",
          results: [],
        }),
      }),
    );

    const result = await runRecallTool("/path/to/agenr", { query: "test" });
    expect(result.content[0]?.type).toBe("text");
  });

  it("runStoreTool returns stored count on success", async () => {
    spawnMock.mockReturnValueOnce(createMockChild({ code: 0 }));

    const result = await runStoreTool("/path/to/agenr", {
      entries: [{ content: "test", type: "fact" }],
    });

    expect(result.content[0]?.text).toContain("Stored");
  });

  it("runExtractTool returns parseable json text on success", async () => {
    spawnMock.mockReturnValueOnce(
      createMockChild({
        stdout: JSON.stringify({
          entries: [{ content: "some text", type: "fact" }],
        }),
      }),
    );

    const result = await runExtractTool("/path/to/agenr", { text: "some text" });
    expect(result.content[0]?.type).toBe("text");
    expect(() => JSON.parse(result.content[0]?.text ?? "")).not.toThrow();
  });

  it("runRetireTool returns success message on exit code 0", async () => {
    spawnMock.mockReturnValueOnce(createMockChild({ code: 0 }));

    const result = await runRetireTool("/path/to/agenr", { entry_id: "test-id-123" });

    expect(result.content[0]?.text).toContain("Retired entry test-id-123");
  });

  it("returns timeout message when command exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      spawnMock.mockReturnValueOnce(createTimeoutChild());

      const resultPromise = runRecallTool("/path/to/agenr", { query: "test" });
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      expect(result.content[0]?.text).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns stderr message when command exits non-zero", async () => {
    spawnMock.mockReturnValueOnce(
      createMockChild({
        code: 1,
        stderr: "something went wrong",
      }),
    );

    const result = await runRecallTool("/path/to/agenr", { query: "test" });
    expect(result.content[0]?.text).toContain("something went wrong");
  });
});
