import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reconstructOpenClawSessionMeta } from "../../../../src/adapters/openclaw/session/surface-reconstruct.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("reconstructOpenClawSessionMeta", () => {
  it("extracts a sender-metadata surface", async () => {
    const filePath = await writeSessionFile([
      {
        type: "message",
        message: {
          role: "human",
          content: [createMetadataBlock("Sender (untrusted metadata):", { label: "telegram:alice" }), "Ping"],
        },
      },
    ]);

    await expect(reconstructOpenClawSessionMeta(filePath)).resolves.toEqual({
      surface: "telegram",
      metadataSource: "reconstructed",
    });
  });

  it("infers webchat from conversation-info metadata", async () => {
    const filePath = await writeSessionFile([
      {
        type: "message",
        message: {
          role: "human",
          content: [createMetadataBlock("Conversation info (untrusted metadata):", { sender_id: "gateway-client" }), "Ping"],
        },
      },
    ]);

    await expect(reconstructOpenClawSessionMeta(filePath)).resolves.toEqual({
      surface: "webchat",
      metadataSource: "reconstructed",
    });
  });

  it("falls back to content heuristics for subagent and heartbeat sessions", async () => {
    const subagentFile = await writeSessionFile([
      {
        type: "message",
        message: {
          role: "human",
          content: "[Subagent Context] Please continue the delegated task.",
        },
      },
    ]);
    const heartbeatFile = await writeSessionFile([
      {
        type: "message",
        message: {
          role: "human",
          content: "Read HEARTBEAT.md and summarize today.",
        },
      },
    ]);

    await expect(reconstructOpenClawSessionMeta(subagentFile)).resolves.toEqual({
      surface: "subagent",
      metadataSource: "reconstructed",
    });
    await expect(reconstructOpenClawSessionMeta(heartbeatFile)).resolves.toEqual({
      surface: "heartbeat",
      metadataSource: "reconstructed",
    });
  });

  it("returns none when no trustworthy surface signal exists", async () => {
    const filePath = await writeSessionFile([
      {
        type: "message",
        message: {
          role: "human",
          content: "Just a plain message with no surface metadata.",
        },
      },
    ]);

    await expect(reconstructOpenClawSessionMeta(filePath)).resolves.toEqual({
      surface: null,
      metadataSource: "none",
    });
  });
});

async function writeSessionFile(lines: object[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-openclaw-surface-"));
  tempDirectories.push(directory);
  const filePath = path.join(directory, "session.jsonl");
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

function createMetadataBlock(sentinel: string, payload: object): string {
  return [sentinel, "```json", JSON.stringify(payload), "```"].join("\n");
}
