import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSemanticSeed,
  extractLastExchangeText,
  extractRecentTurns,
  findPreviousSessionFile,
  stripPromptMetadata,
} from "./session-query.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenr-session-query-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonlFile(
  filePath: string,
  entries: unknown[],
  mtimeMs?: number,
): Promise<void> {
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(filePath, content, "utf8");
  if (typeof mtimeMs === "number") {
    const mtime = new Date(mtimeMs);
    await utimes(filePath, mtime, mtime);
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("stripPromptMetadata", () => {
  it("returns just the user text for a full metadata envelope with timestamp", () => {
    const input = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "08f2ed82-1111-2222-3333-444455556666",
  "sender_id": "gateway-client",
  "sender": "gateway-client"
}
\`\`\`

[Sun 2026-02-22 21:08 CST] hey`;

    expect(stripPromptMetadata(input)).toBe("hey");
  });

  it("returns trimmed input when there is no envelope", () => {
    expect(stripPromptMetadata("  what should we work on next?  ")).toBe(
      "what should we work on next?",
    );
  });
});

describe("extractLastExchangeText", () => {
  it("formats last user and assistant turns with U:/A: prefixes", () => {
    const result = extractLastExchangeText([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what is the status?" },
    ]);

    expect(result).toBe("U: hello | A: hi there | U: what is the status?");
  });

  it("truncates individual messages to 200 chars", () => {
    const longUserText = "x".repeat(250);
    const result = extractLastExchangeText([{ role: "user", content: longUserText }]);
    const expected = `U: ${"x".repeat(200)}`;

    expect(result).toBe(expected);
    expect(result).not.toContain("x".repeat(201));
  });
});

describe("findPreviousSessionFile", () => {
  it("returns most recent *.jsonl file by mtime (not deleted, not current session)", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    await writeJsonlFile(path.join(dir, "older.jsonl"), [], now - 10_000);
    await writeJsonlFile(path.join(dir, "latest.reset.jsonl"), [], now - 100);

    await expect(findPreviousSessionFile(dir, "current-session-id")).resolves.toBe(
      path.join(dir, "latest.reset.jsonl"),
    );
  });

  it("skips files containing .deleted. in name", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    await writeJsonlFile(path.join(dir, "new.deleted.session.jsonl"), [], now - 10);
    await writeJsonlFile(path.join(dir, "active.jsonl"), [], now - 100);

    await expect(findPreviousSessionFile(dir, "current-session-id")).resolves.toBe(
      path.join(dir, "active.jsonl"),
    );
  });

  it("skips file whose name equals currentSessionId + .jsonl", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    await writeJsonlFile(path.join(dir, "current-session.jsonl"), [], now - 10);
    await writeJsonlFile(path.join(dir, "previous-session.jsonl"), [], now - 100);

    await expect(findPreviousSessionFile(dir, "current-session")).resolves.toBe(
      path.join(dir, "previous-session.jsonl"),
    );
  });

  it("returns null when directory is empty", async () => {
    const dir = await createTempDir();
    await expect(findPreviousSessionFile(dir, "current")).resolves.toBeNull();
  });

  it("returns null when only deleted files exist", async () => {
    const dir = await createTempDir();
    await writeJsonlFile(path.join(dir, "one.deleted.two.jsonl"), []);

    await expect(findPreviousSessionFile(dir, "current")).resolves.toBeNull();
  });

  it("returns null when only current session file exists", async () => {
    const dir = await createTempDir();
    await writeJsonlFile(path.join(dir, "current.jsonl"), []);

    await expect(findPreviousSessionFile(dir, "current")).resolves.toBeNull();
  });

  it("does not skip current-like file when currentSessionId is undefined", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    await writeJsonlFile(path.join(dir, "current.jsonl"), [], now - 10);
    await writeJsonlFile(path.join(dir, "older.jsonl"), [], now - 1000);

    await expect(findPreviousSessionFile(dir, undefined)).resolves.toBe(
      path.join(dir, "current.jsonl"),
    );
  });
});

describe("extractRecentTurns", () => {
  it("returns last 7 turns formatted as U: text | A: text", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "session.jsonl");
    const entries = [
      { type: "message", message: { role: "user", content: "u1" } },
      { type: "message", message: { role: "assistant", content: "a1" } },
      { type: "message", message: { role: "user", content: "u2" } },
      { type: "message", message: { role: "assistant", content: "a2" } },
      { type: "message", message: { role: "user", content: "u3" } },
      { type: "message", message: { role: "assistant", content: "a3" } },
      { type: "message", message: { role: "user", content: "u4" } },
      { type: "message", message: { role: "assistant", content: "a4" } },
    ];
    await writeJsonlFile(filePath, entries);

    await expect(extractRecentTurns(filePath)).resolves.toBe(
      "A: a1 | U: u2 | A: a2 | U: u3 | A: a3 | U: u4 | A: a4",
    );
  });

  it("truncates each turn to 150 chars", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "session.jsonl");
    const longText = "x".repeat(200);
    await writeJsonlFile(filePath, [
      { type: "message", message: { role: "user", content: longText } },
    ]);

    const result = await extractRecentTurns(filePath);
    expect(result).toBe(`U: ${"x".repeat(150)}`);
  });

  it("skips non-message JSONL records", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "session.jsonl");
    await writeJsonlFile(filePath, [
      { type: "event", detail: "ignored" },
      { type: "message", message: { role: "user", content: "kept" } },
    ]);

    await expect(extractRecentTurns(filePath)).resolves.toBe("U: kept");
  });

  it("returns empty string when file not found", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "missing.jsonl");

    await expect(extractRecentTurns(filePath)).resolves.toBe("");
  });

  it("returns empty string for empty file", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "empty.jsonl");
    await writeFile(filePath, "", "utf8");

    await expect(extractRecentTurns(filePath)).resolves.toBe("");
  });

  it("skips assistant turns with empty text (tool-only turns)", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "session.jsonl");
    await writeJsonlFile(filePath, [
      { type: "message", message: { role: "user", content: "keep this" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "search" }],
        },
      },
      { type: "message", message: { role: "assistant", content: "assistant text" } },
    ]);

    await expect(extractRecentTurns(filePath)).resolves.toBe("U: keep this | A: assistant text");
  });
});

describe("buildSemanticSeed", () => {
  it("returns previous turns plus message when message has >= 5 words", () => {
    const result = buildSemanticSeed("U: previous context", "fix the session recall bug now");
    expect(result).toBe("U: previous context fix the session recall bug now");
  });

  it("returns previous turns only when message has < 5 words", () => {
    const result = buildSemanticSeed("U: previous context", "hey");
    expect(result).toBe("U: previous context");

    expect(buildSemanticSeed("U: previous context", "fix it")).toBe("U: previous context");
    expect(buildSemanticSeed("U: previous context", "on the other side")).toBe("U: previous context");
  });

  it("returns combined seed when message has exactly 5 words", () => {
    const result = buildSemanticSeed("U: previous context", "fix the session recall bug");
    expect(result).toBe("U: previous context fix the session recall bug");
  });

  it("returns previous turns only when message has exactly 4 words", () => {
    const result = buildSemanticSeed("U: previous context", "how does recall work");
    expect(result).toBe("U: previous context");
  });

  it("returns message only when previous turns are empty and message has >= 5 words", () => {
    const result = buildSemanticSeed("", "fix the session recall bug");
    expect(result).toBe("fix the session recall bug");
  });

  it("returns undefined when previous turns are empty and message has < 5 words", () => {
    expect(buildSemanticSeed("", "hey")).toBeUndefined();
    expect(buildSemanticSeed("", "fix it")).toBeUndefined();
    expect(buildSemanticSeed("", "how does recall work")).toBeUndefined();
  });

  it("returns previous turns when message is missing", () => {
    const result = buildSemanticSeed("U: previous context", "");
    expect(result).toBe("U: previous context");
  });

  it("returns truncated previous turns when message is missing", () => {
    const previousTurns = "x".repeat(450);
    const result = buildSemanticSeed(previousTurns, "");
    expect(result).toBe("x".repeat(400));
  });

  it("truncates previous turns to 400 chars in seed", () => {
    const previousTurns = "x".repeat(450);
    const result = buildSemanticSeed(previousTurns, "hello");
    expect(result).toBe("x".repeat(400));
  });
});
