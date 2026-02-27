import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSpawnArgs,
  formatRecallAsMarkdown,
  resolveAgenrPath,
} from "../../src/openclaw-plugin/recall.js";
import type { RecallResult } from "../../src/openclaw-plugin/recall.js";

function makeResult(entries: Array<{ type: string; subject: string; content: string }>): RecallResult {
  return {
    query: "",
    results: entries.map((entry) => ({
      entry: { ...entry, importance: 6 },
      score: 0.9,
    })),
  };
}

describe("formatRecallAsMarkdown", () => {
  it("returns empty string when results array is empty", () => {
    const result = formatRecallAsMarkdown({ query: "", results: [] });
    expect(result).toBe("");
  });

  it("returns empty string when all entries are invalid (missing required fields)", () => {
    const result = formatRecallAsMarkdown({
      query: "",
      results: [{ entry: { type: "fact" } as never, score: 0.9 }],
    });
    expect(result).toBe("");
  });

  it("groups todo entries under Active Todos section", () => {
    const result = formatRecallAsMarkdown(
      makeResult([{ type: "todo", subject: "fix bug", content: "Fix the null crash" }])
    );
    expect(result).toContain("### Active Todos");
    expect(result).toContain("[fix bug] Fix the null crash");
  });

  it("groups decision entries under Preferences and Decisions section", () => {
    const result = formatRecallAsMarkdown(
      makeResult([{ type: "decision", subject: "use vitest", content: "Use vitest for all tests" }])
    );
    expect(result).toContain("### Preferences and Decisions");
    expect(result).toContain("[use vitest] Use vitest for all tests");
  });

  it("groups preference entries under Preferences and Decisions section", () => {
    const result = formatRecallAsMarkdown(
      makeResult([{ type: "preference", subject: "dark mode", content: "Prefers dark mode in all UIs" }])
    );
    expect(result).toContain("### Preferences and Decisions");
    expect(result).toContain("[dark mode] Prefers dark mode in all UIs");
  });

  it("groups fact and event entries under Facts and Events section", () => {
    const result = formatRecallAsMarkdown(
      makeResult([
        { type: "fact", subject: "home dir", content: "Home directory is /Users/jmartin" },
        { type: "event", subject: "launch", content: "Launched agenr v0.6.4" },
      ])
    );
    expect(result).toContain("### Facts and Events");
    expect(result).toContain("[home dir] Home directory is /Users/jmartin");
    expect(result).toContain("[launch] Launched agenr v0.6.4");
  });

  it("renders all three sections when mixed types are present", () => {
    const result = formatRecallAsMarkdown(
      makeResult([
        { type: "todo", subject: "a", content: "do a" },
        { type: "decision", subject: "b", content: "chose b" },
        { type: "fact", subject: "c", content: "fact c" },
      ])
    );
    expect(result).toContain("### Active Todos");
    expect(result).toContain("### Preferences and Decisions");
    expect(result).toContain("### Facts and Events");
  });

  it("includes the top-level agenr Memory Context header", () => {
    const result = formatRecallAsMarkdown(makeResult([{ type: "fact", subject: "x", content: "y" }]));
    expect(result).toContain("## agenr Memory Context");
  });

  it("gracefully skips entries with missing required fields", () => {
    const result = formatRecallAsMarkdown({
      query: "",
      results: [
        { entry: { type: "fact", subject: "good", content: "valid entry" }, score: 1 },
        { entry: { type: "fact" } as never, score: 0.5 },
        { entry: { subject: "no type" } as never, score: 0.3 },
        { entry: null as never, score: 0.1 },
      ],
    });
    expect(result).toContain("[good] valid entry");
    const lines = result.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(1);
  });
});

describe("resolveAgenrPath", () => {
  it("returns config.agenrPath when provided", () => {
    const resolved = resolveAgenrPath({ agenrPath: "/custom/path/cli.js" });
    expect(resolved).toBe("/custom/path/cli.js");
  });

  it("falls back to AGENR_BIN env var when config is empty", () => {
    const original = process.env["AGENR_BIN"];
    process.env["AGENR_BIN"] = "/env/agenr/cli.js";
    try {
      const resolved = resolveAgenrPath({});
      expect(resolved).toBe("/env/agenr/cli.js");
    } finally {
      if (original === undefined) {
        delete process.env["AGENR_BIN"];
      } else {
        process.env["AGENR_BIN"] = original;
      }
    }
  });

  it("falls back to package-relative dist/cli.js when nothing is configured", () => {
    const original = process.env["AGENR_BIN"];
    delete process.env["AGENR_BIN"];
    try {
      const resolved = resolveAgenrPath(undefined);
      const expectedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      const expectedPath = path.join(expectedRoot, "dist", "cli.js");
      expect(resolved).toBe(expectedPath);
    } finally {
      if (original !== undefined) {
        process.env["AGENR_BIN"] = original;
      }
    }
  });
});

describe("buildSpawnArgs", () => {
  it("uses node when agenrPath points to a .js file", () => {
    const args = buildSpawnArgs("/tmp/agenr/dist/cli.js");
    expect(args).toEqual({ cmd: process.execPath, args: ["/tmp/agenr/dist/cli.js"] });
  });

  it("spawns executable directly when agenrPath is a binary path", () => {
    const args = buildSpawnArgs("/usr/local/bin/agenr");
    expect(args).toEqual({ cmd: "/usr/local/bin/agenr", args: [] });
  });
});

describe("runRecallTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function invokeRecallTool(params: Record<string, unknown>): Promise<string[]> {
    const spawnMock = vi.fn(() => {
      const child = new EventEmitter() as unknown as {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: (input: string) => void; end: () => void };
        on: (event: string, handler: (...args: unknown[]) => void) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: () => undefined,
        end: () => undefined,
      };
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from('{"query":"q","results":[]}'));
        (child as unknown as EventEmitter).emit("close", 0);
      });
      return child;
    });

    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    const { runRecallTool } = await import("../../src/openclaw-plugin/tools.js");
    await runRecallTool("/usr/local/bin/agenr", params);

    const firstCall = (spawnMock.mock.calls as unknown[][])[0];
    return (firstCall?.[1] as string[]) ?? [];
  }

  it("passes --around to the recall CLI", async () => {
    const args = await invokeRecallTool({ query: "work", around: "2026-02-15T00:00:00.000Z" });
    expect(args).toContain("--around");
    const aroundIndex = args.indexOf("--around");
    expect(args[aroundIndex + 1]).toBe("2026-02-15T00:00:00.000Z");
  });

  it("passes --around-radius to the recall CLI", async () => {
    const args = await invokeRecallTool({ query: "work", aroundRadius: 21 });
    expect(args).toContain("--around-radius");
    const radiusIndex = args.indexOf("--around-radius");
    expect(args[radiusIndex + 1]).toBe("21");
  });
});
