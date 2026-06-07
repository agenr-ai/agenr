import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readLatestOpenClawCompactionEntry, readOpenClawCompactionEntries } from "../../../../src/adapters/openclaw/session/compaction-transcript.js";

describe("readOpenClawCompactionEntries", () => {
  it("reads compaction summaries from OpenClaw JSONL transcripts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-compaction-"));
    const sessionFile = path.join(root, "session.jsonl");
    await writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-06-06T00:00:00.000Z" }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          summary: "We decided to ship the OpenClaw compaction intake path.",
          tokensBefore: 120000,
          tokensAfter: 42000,
          firstKeptEntryId: "entry-9",
          timestamp: "2026-06-06T00:05:00.000Z",
        }),
      ].join("\n"),
      "utf8",
    );

    await expect(readOpenClawCompactionEntries(sessionFile)).resolves.toEqual([
      {
        id: "compact-1",
        summary: "We decided to ship the OpenClaw compaction intake path.",
        tokensBefore: 120000,
        tokensAfter: 42000,
        firstKeptEntryId: "entry-9",
        timestamp: "2026-06-06T00:05:00.000Z",
      },
    ]);
    await expect(readLatestOpenClawCompactionEntry(sessionFile)).resolves.toMatchObject({
      id: "compact-1",
    });

    await rm(root, { recursive: true, force: true });
  });
});
