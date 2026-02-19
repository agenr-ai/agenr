import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSpawnArgs,
  formatRecallAsMarkdown,
  formatRecallAsSummary,
  resolveAgenrPath,
  writeAgenrMd,
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

describe("formatRecallAsSummary", () => {
  it("returns empty string when results array is empty", () => {
    const result = formatRecallAsSummary({ query: "", results: [] });
    expect(result).toBe("");
  });

  it("includes timestamp in header when provided", () => {
    const result = formatRecallAsSummary(
      makeResult([{ type: "fact", subject: "x", content: "y" }]),
      "2026-02-19 13:51"
    );
    expect(result.split("\n")[0]).toBe("## agenr Memory -- 2026-02-19 13:51");
  });

  it("omits timestamp from header when not provided", () => {
    const result = formatRecallAsSummary(makeResult([{ type: "fact", subject: "x", content: "y" }]));
    expect(result.split("\n")[0]).toBe("## agenr Memory");
  });

  it("shows total entry count after filtering invalid entries", () => {
    const result = formatRecallAsSummary({
      query: "",
      results: [
        { entry: { type: "todo", subject: "a", content: "aa" }, score: 0.9 },
        { entry: { type: "fact", subject: "b", content: "bb" }, score: 0.9 },
        { entry: { type: "fact" } as never, score: 0.1 },
      ],
    });
    expect(result).toContain("2 entries recalled. Full context injected into this session automatically.");
  });

  it("shows only subjects and excludes content bodies", () => {
    const result = formatRecallAsSummary(
      makeResult([
        { type: "todo", subject: "fix parser", content: "Do not show this todo content" },
        { type: "decision", subject: "use pnpm", content: "Do not show this decision content" },
        { type: "fact", subject: "repo path", content: "Do not show this fact content" },
      ])
    );
    expect(result).toContain("- fix parser");
    expect(result).toContain("- use pnpm");
    expect(result).toContain("- repo path");
    expect(result).not.toContain("Do not show this todo content");
    expect(result).not.toContain("Do not show this decision content");
    expect(result).not.toContain("Do not show this fact content");
  });

  it("includes per-section counts in section headers", () => {
    const result = formatRecallAsSummary(
      makeResult([
        { type: "todo", subject: "a", content: "ca" },
        { type: "todo", subject: "b", content: "cb" },
        { type: "decision", subject: "c", content: "cc" },
      ])
    );
    expect(result).toContain("### Active Todos (2)");
    expect(result).toContain("### Preferences and Decisions (1)");
  });

  it("omits sections with zero entries", () => {
    const result = formatRecallAsSummary(
      makeResult([{ type: "todo", subject: "only todo", content: "x" }])
    );
    expect(result).toContain("### Active Todos (1)");
    expect(result).not.toContain("### Preferences and Decisions");
    expect(result).not.toContain("### Facts and Events");
  });

  it("always includes the instruction block", () => {
    const result = formatRecallAsSummary(
      makeResult([{ type: "fact", subject: "subject", content: "content" }])
    );
    expect(result).toContain('mcporter call agenr.agenr_recall query="your topic" limit=5');
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

describe("writeAgenrMd", () => {
  it("writes markdown content to workspaceDir/AGENR.md", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-"));
    try {
      await writeAgenrMd("## agenr Memory Context", tempDir);
      const outputPath = path.join(tempDir, "AGENR.md");
      const content = await fsPromises.readFile(outputPath, "utf8");
      expect(content).toBe("## agenr Memory Context");
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("silently discards filesystem write errors", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-"));
    const filePath = path.join(tempDir, "not-a-directory.txt");
    try {
      await fsPromises.writeFile(filePath, "block", "utf8");
      await expect(writeAgenrMd("text", filePath)).resolves.toBeUndefined();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
