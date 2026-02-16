import { describe, expect, it } from "vitest";
import { deduplicateEntries } from "../src/dedup.js";
import type { KnowledgeEntry } from "../src/types.js";

function entry(overrides: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    type: "fact",
    content: "Jim prefers pnpm over npm",
    subject: "Jim",
    importance: 6,
    expiry: "permanent",
    tags: ["tooling"],
    source: { file: "a.jsonl", context: "line 1" },
    ...overrides,
  };
}

describe("deduplicateEntries", () => {
  it("deduplicates exact matches and keeps highest importance", () => {
    const input = [
      entry({ importance: 4, tags: ["js"] }),
      entry({ importance: 8, tags: ["pnpm"] }),
    ];

    const output = deduplicateEntries(input);
    expect(output).toHaveLength(1);
    expect(output[0]?.importance).toBe(8);
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

  it("preserves original extraction order after deduplication", () => {
    const input = [
      entry({ subject: "Jim", content: "Jim uses pnpm for monorepos" }),
      entry({ subject: "Acme", content: "Acme deploys on AWS" }),
      entry({ subject: "Jim", content: "Jim uses zsh with oh-my-zsh" }),
    ];

    const output = deduplicateEntries(input);
    expect(output).toHaveLength(3);
    expect(output.map((item) => `${item.subject}:${item.content}`)).toEqual([
      "Jim:Jim uses pnpm for monorepos",
      "Acme:Acme deploys on AWS",
      "Jim:Jim uses zsh with oh-my-zsh",
    ]);
  });
});
