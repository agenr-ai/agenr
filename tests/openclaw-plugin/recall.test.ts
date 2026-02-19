import { describe, expect, it } from "vitest";
import { formatRecallAsMarkdown, resolveAgenrPath } from "../../src/openclaw-plugin/recall.js";
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

  it("falls back to default path when nothing is configured", () => {
    const original = process.env["AGENR_BIN"];
    delete process.env["AGENR_BIN"];
    try {
      const resolved = resolveAgenrPath(undefined);
      expect(resolved).toContain("agenr-local");
      expect(resolved).toContain("cli.js");
    } finally {
      if (original !== undefined) {
        process.env["AGENR_BIN"] = original;
      }
    }
  });
});
