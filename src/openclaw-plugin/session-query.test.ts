import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLatestArchivedUserMessages, stripPromptMetadata } from "./session-query.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenr-session-query-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonlFile(
  filePath: string,
  entries: unknown[],
  mtimeMs: number,
): Promise<void> {
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(filePath, content, "utf8");
  const mtime = new Date(mtimeMs);
  await utimes(filePath, mtime, mtime);
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

  it("returns empty string for empty input", () => {
    expect(stripPromptMetadata("")).toBe("");
  });

  it("strips at the last timestamp-like pattern", () => {
    const input =
      "I said [Mon 2026-01-01 09:00 CST] something\n[Tue 2026-01-02 10:00 CST] actual message";

    expect(stripPromptMetadata(input)).toBe("actual message");
  });

  it("returns empty string when timestamp has no trailing content", () => {
    expect(stripPromptMetadata("[Sun 2026-02-22 21:08 CST] ")).toBe("");
  });
});

describe("readLatestArchivedUserMessages", () => {
  it("returns [] when dir does not exist", async () => {
    const missingDir = path.join(os.tmpdir(), `agenr-missing-${Date.now()}`);
    await expect(readLatestArchivedUserMessages(missingDir)).resolves.toEqual([]);
  });

  it("returns [] when no .reset.* files exist", async () => {
    const dir = await createTempDir();
    await writeFile(path.join(dir, "active-session.jsonl"), "", "utf8");

    await expect(readLatestArchivedUserMessages(dir)).resolves.toEqual([]);
  });

  it("returns [] when only old .reset.* files are outside maxAgeMs", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    await writeJsonlFile(
      path.join(dir, "a.jsonl.reset.2026-02-23T01:00:00.000Z"),
      [
        {
          type: "message",
          message: { role: "user", content: "keep this out due to age" },
        },
      ],
      now - 10_000,
    );

    await expect(readLatestArchivedUserMessages(dir, 1_000)).resolves.toEqual([]);
  });

  it("returns last 3 user messages from the most recent .reset.* file", async () => {
    const dir = await createTempDir();
    const now = Date.now();

    await writeJsonlFile(
      path.join(dir, "older.jsonl.reset.2026-02-23T00:00:00.000Z"),
      [
        {
          type: "message",
          message: { role: "user", content: "older session text that should not be read" },
        },
      ],
      now - 2_000,
    );

    await writeJsonlFile(
      path.join(dir, "newer.jsonl.reset.2026-02-23T00:10:00.000Z"),
      [
        { type: "message", message: { role: "user", content: "first user message" } },
        { type: "message", message: { role: "user", content: "second user message" } },
        { type: "message", message: { role: "user", content: "third user message" } },
        { type: "message", message: { role: "user", content: "fourth user message" } },
      ],
      now - 200,
    );

    await expect(readLatestArchivedUserMessages(dir, 60_000)).resolves.toEqual([
      "second user message",
      "third user message",
      "fourth user message",
    ]);
  });

  it("skips non-user messages and tool results", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    await writeJsonlFile(
      path.join(dir, "mixed.jsonl.reset.2026-02-23T00:20:00.000Z"),
      [
        { type: "tool_result", content: "ignore tool result lines" },
        { type: "message", message: { role: "assistant", content: "assistant text" } },
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "first user text chunk" },
              { type: "image", url: "ignore image parts" },
              { type: "text", text: "second chunk" },
            ],
          },
        },
        { type: "message", message: { role: "user", content: "plain user text" } },
      ],
      now - 100,
    );

    await expect(readLatestArchivedUserMessages(dir, 60_000)).resolves.toEqual([
      "first user text chunk second chunk",
      "plain user text",
    ]);
  });

  it("returns [] when newest archived file has no user messages", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    await writeJsonlFile(
      path.join(dir, "no-user.jsonl.reset.2026-02-23T00:25:00.000Z"),
      [
        { type: "tool_result", content: "tool output" },
        { type: "message", message: { role: "assistant", content: "assistant-only content" } },
      ],
      now - 100,
    );

    await expect(readLatestArchivedUserMessages(dir, 60_000)).resolves.toEqual([]);
  });

  it("falls back to second-most-recent file when newest has no user messages", async () => {
    const dir = await createTempDir();
    const now = Date.now();

    await writeJsonlFile(
      path.join(dir, "older-with-user.jsonl.reset.2026-02-23T00:20:00.000Z"),
      [
        { type: "message", message: { role: "user", content: "older user one" } },
        { type: "message", message: { role: "user", content: "older user two" } },
      ],
      now - 2_000,
    );

    await writeJsonlFile(
      path.join(dir, "newer-no-user.jsonl.reset.2026-02-23T00:30:00.000Z"),
      [
        { type: "tool_result", content: "tool output only" },
        { type: "message", message: { role: "assistant", content: "assistant only" } },
      ],
      now - 100,
    );

    await expect(readLatestArchivedUserMessages(dir, 60_000)).resolves.toEqual([
      "older user one",
      "older user two",
    ]);
  });

  it("skips malformed json lines and keeps valid user messages", async () => {
    const dir = await createTempDir();
    const now = Date.now();
    const filePath = path.join(dir, "mixed-valid-malformed.jsonl.reset.2026-02-23T00:30:00.000Z");
    const raw = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "first valid user message" },
      }),
      "{ this is not valid json",
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "assistant message to ignore" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "second valid user message" },
      }),
    ].join("\n");
    await writeFile(filePath, raw, "utf8");
    const mtime = new Date(now - 50);
    await utimes(filePath, mtime, mtime);

    await expect(readLatestArchivedUserMessages(dir, 60_000)).resolves.toEqual([
      "first valid user message",
      "second valid user message",
    ]);
  });
});
