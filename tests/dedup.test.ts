import { describe, expect, it } from "vitest";
import { deduplicateEntries } from "../src/dedup.js";
import type { KnowledgeEntry } from "../src/types.js";

function entry(overrides: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    type: "fact",
    content: "Jim prefers pnpm over npm",
    subject: "Jim",
    confidence: "medium",
    expiry: "permanent",
    tags: ["tooling"],
    source: { file: "a.jsonl", context: "line 1" },
    ...overrides,
  };
}

describe("deduplicateEntries", () => {
  it("deduplicates exact matches and keeps highest confidence", () => {
    const input = [
      entry({ confidence: "low", tags: ["js"] }),
      entry({ confidence: "high", tags: ["pnpm"] }),
    ];

    const output = deduplicateEntries(input);
    expect(output).toHaveLength(1);
    expect(output[0]?.confidence).toBe("high");
    expect(output[0]?.tags).toEqual(["js", "pnpm"]);
  });

  it("deduplicates near-duplicates within same type+subject", () => {
    const input = [
      entry({ content: "Jim prefers pnpm over npm and yarn for JavaScript monorepo package management" }),
      entry({
        content:
          "Jim prefers pnpm over npm and yarn for JavaScript monorepo package management today",
      }),
    ];

    const output = deduplicateEntries(input);
    expect(output).toHaveLength(1);
  });
});
