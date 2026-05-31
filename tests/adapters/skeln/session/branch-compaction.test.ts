import { describe, expect, it } from "vitest";

import { extractSkelnBeforeTurnBranchMessages } from "../../../../src/adapters/skeln/session/branch-compaction.js";

describe("extractSkelnBeforeTurnBranchMessages", () => {
  it("excludes archived messages before the latest compaction boundary", () => {
    const messages = extractSkelnBeforeTurnBranchMessages([
      {
        type: "message",
        id: "entry-1",
        message: { role: "user", content: "archived before compaction" },
      },
      {
        type: "message",
        id: "entry-2",
        message: { role: "assistant", content: "kept before compaction" },
      },
      {
        type: "compaction",
        id: "compact-1",
        firstKeptEntryId: "entry-2",
      },
      {
        type: "message",
        id: "entry-3",
        message: { role: "user", content: "current after compaction" },
      },
    ]);

    expect(messages.map(extractText)).toEqual(["kept before compaction", "current after compaction"]);
  });

  it("falls back to the full branch when the compaction boundary is unavailable", () => {
    const messages = extractSkelnBeforeTurnBranchMessages([
      {
        type: "message",
        id: "entry-1",
        message: { role: "user", content: "still visible" },
      },
      {
        type: "compaction",
        id: "compact-1",
        firstKeptEntryId: "missing-entry",
      },
    ]);

    expect(messages.map(extractText)).toEqual(["still visible"]);
  });
});

function extractText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const first = content[0];
  return first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
}
