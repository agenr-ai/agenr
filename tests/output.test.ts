import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatJson, formatMarkdown, writeOutput } from "../src/output.js";
import type { ExtractionReport } from "../src/types.js";

const tempDirs: string[] = [];

function makeReport(): ExtractionReport {
  return {
    version: "0.1.0",
    extracted_at: "2026-02-14T00:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-4-6",
    files: {
      "a/session.jsonl": {
        entries: [
          {
            type: "fact",
            content: "Jim prefers pnpm.",
            subject: "Jim",
            importance: 8,
            expiry: "permanent",
            tags: ["tooling"],
            source: { file: "a/session.jsonl", context: "m00001" },
          },
        ],
        stats: {
          chunks: 2,
          successful_chunks: 2,
          failed_chunks: 0,
          raw_entries: 1,
          deduped_entries: 1,
          warnings: [],
        },
      },
      "b/session.jsonl": {
        entries: [],
        stats: {
          chunks: 1,
          successful_chunks: 0,
          failed_chunks: 1,
          raw_entries: 0,
          deduped_entries: 0,
          warnings: ["chunk failed"],
        },
      },
    },
    summary: {
      files: 2,
      chunks: 3,
      successful_chunks: 2,
      failed_chunks: 1,
      raw_entries: 1,
      deduped_entries: 1,
      warnings: 1,
    },
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("output", () => {
  it("formats json and markdown envelopes", () => {
    const report = makeReport();
    const json = formatJson(report);
    const markdown = formatMarkdown(report);
    const parsedJson = JSON.parse(json) as Array<{ type: string; subject: string }>;

    expect(Array.isArray(parsedJson)).toBe(true);
    expect(parsedJson).toHaveLength(1);
    expect(parsedJson[0]).toMatchObject({ type: "fact", subject: "Jim" });
    expect(markdown).toContain("## a/session.jsonl");
    expect(markdown).toContain("_Stats: chunks=2/2 successful | failed=0 | raw=1 | entries=1 | dupes_removed=0 | warnings=0_");
    expect(markdown).toContain("- Entries: 1 entries (0 duplicates removed)");
    expect(markdown).toContain("## Summary");
  });

  it("writes split outputs and applies collision suffixes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-output-test-"));
    tempDirs.push(dir);

    const report: ExtractionReport = {
      ...makeReport(),
      files: {
        "folder-a/session.jsonl": makeReport().files["a/session.jsonl"]!,
        "folder-b/session.jsonl": makeReport().files["b/session.jsonl"]!,
      },
    };

    const written = await writeOutput({
      report,
      format: "json",
      output: dir,
      split: true,
    });

    expect(written).toHaveLength(2);
    expect(path.basename(written[0] ?? "")).toMatch(/session\.jsonl\.knowledge\.json$/);
    expect(path.basename(written[1] ?? "")).toMatch(/session\.jsonl\.knowledge-2\.json$/);
  });
});
