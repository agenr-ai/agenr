import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOpenClawSessionRegistry } from "../../../../src/adapters/openclaw/session/session-registry.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("loadOpenClawSessionRegistry", () => {
  it("normalizes session metadata from sessions.json", async () => {
    const sessionsDir = await createSessionsDir();
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(
        {
          "agent:main:tui-123e4567-e89b-12d3-a456-426614174000": {
            sessionId: "123e4567-e89b-12d3-a456-426614174000",
            sessionFile: "123e4567-e89b-12d3-a456-426614174000.jsonl",
            origin: {
              surface: "webchat",
              provider: "webchat",
            },
            chatType: "direct",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const registry = await loadOpenClawSessionRegistry(sessionsDir);
    const session = await registry.getSessionMeta("123e4567-e89b-12d3-a456-426614174000");

    expect(session).toEqual({
      sessionId: "123e4567-e89b-12d3-a456-426614174000",
      sourceRef: path.join(sessionsDir, "123e4567-e89b-12d3-a456-426614174000.jsonl"),
      sessionKey: "agent:main:tui-123e4567-e89b-12d3-a456-426614174000",
      agentId: "main",
      surface: "webchat",
      provider: "webchat",
      chatType: "direct",
      metadataSource: "registry",
    });
  });

  it("derives a missing session id from the session file and handles null surface fields", async () => {
    const sessionsDir = await createSessionsDir();
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(
        {
          "agent:worker:main": {
            sessionFile: "123e4567-e89b-12d3-a456-426614174001.jsonl",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const registry = await loadOpenClawSessionRegistry(sessionsDir);
    const sessions = await registry.listSessions();

    expect(sessions).toEqual([
      {
        sessionId: "123e4567-e89b-12d3-a456-426614174001",
        sourceRef: path.join(sessionsDir, "123e4567-e89b-12d3-a456-426614174001.jsonl"),
        sessionKey: "agent:worker:main",
        agentId: "worker",
        surface: null,
        provider: null,
        chatType: null,
        metadataSource: "registry",
      },
    ]);
  });
});

async function createSessionsDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-openclaw-registry-"));
  tempDirectories.push(directory);
  const sessionsDir = path.join(directory, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}
