import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { skelnTranscriptParser } from "../../../../src/adapters/skeln/transcript/parser.js";

describe("skelnTranscriptParser", () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
    }
  });

  it("parses Skeln session JSONL exports into shared transcript shape", async () => {
    const sessionFile = await writeSessionFile(tempPaths, [
      {
        type: "session",
        version: 1,
        id: "skeln-session-1",
        timestamp: Date.parse("2026-05-30T10:00:00.000Z"),
        cwd: "/tmp/agenr",
      },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: Date.parse("2026-05-30T10:01:00.000Z"),
        message: {
          role: "user",
          timestamp: Date.parse("2026-05-30T10:01:00.000Z"),
          content: "Implement shutdown episodes.",
        },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: Date.parse("2026-05-30T10:02:00.000Z"),
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-05-30T10:02:00.000Z"),
          content: [{ type: "text", text: "Shutdown episodes use the shared episode writer." }],
        },
      },
      {
        type: "message",
        id: "tool-1",
        parentId: "m2",
        timestamp: Date.parse("2026-05-30T10:03:00.000Z"),
        message: {
          role: "toolResult",
          timestamp: Date.parse("2026-05-30T10:03:00.000Z"),
          content: "Tool payload should not become episode dialogue.",
        },
      },
    ]);

    const transcript = await skelnTranscriptParser.parseFile(sessionFile);

    expect(transcript.messages).toEqual([
      {
        index: 0,
        role: "user",
        text: "Implement shutdown episodes.",
        timestamp: "2026-05-30T10:01:00.000Z",
      },
      {
        index: 1,
        role: "assistant",
        text: "Shutdown episodes use the shared episode writer.",
        timestamp: "2026-05-30T10:02:00.000Z",
      },
    ]);
    expect(transcript.metadata).toEqual(
      expect.objectContaining({
        sessionId: "skeln-session-1",
        startedAt: "2026-05-30T10:01:00.000Z",
        endedAt: "2026-05-30T10:02:00.000Z",
        messageCount: 2,
        reconstructedSurface: "skeln",
        sourceIdentity: sessionFile,
        workingDirectory: "/tmp/agenr",
        project: "agenr",
      }),
    );
    expect(transcript.metadata.transcriptHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("treats the first non-empty JSONL record as the session header", async () => {
    const sessionFile = await writeRawSessionFile(
      tempPaths,
      [
        "",
        JSON.stringify({
          type: "session",
          id: "skeln-session-leading-blank",
          timestamp: Date.parse("2026-05-30T11:00:00.000Z"),
          cwd: "/tmp/agenr",
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: Date.parse("2026-05-30T11:01:00.000Z"),
            content: "Use the first non-empty line as the header.",
          },
        }),
      ].join("\n"),
    );

    const transcript = await skelnTranscriptParser.parseFile(sessionFile);

    expect(transcript.metadata).toEqual(
      expect.objectContaining({
        sessionId: "skeln-session-leading-blank",
        workingDirectory: "/tmp/agenr",
        project: "agenr",
      }),
    );
    expect(transcript.warnings).not.toContain(`Skeln transcript ${sessionFile} is missing a session header.`);
  });
});

async function writeSessionFile(tempPaths: string[], records: Record<string, unknown>[]): Promise<string> {
  return writeRawSessionFile(tempPaths, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function writeRawSessionFile(tempPaths: string[], content: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-skeln-transcript-test-"));
  tempPaths.push(directory);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "skeln-session-1.jsonl");
  await writeFile(filePath, content, "utf8");
  return filePath;
}
