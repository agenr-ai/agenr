import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveOpenClawCurrentSessionTarget } from "../../../../src/adapters/openclaw/session/continuity/current-session-resolver.js";

describe("resolveOpenClawCurrentSessionTarget", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      await rm(tempRoots.pop() ?? "", { force: true, recursive: true });
    }
  });

  async function createStateDir(agentId: string, sessionId: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenr-current-session-"));
    tempRoots.push(root);
    const sessionsDir = path.join(root, "agents", agentId, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), '{"type":"session"}\n', "utf8");
    return root;
  }

  it("resolves the current session transcript using the agent id from the session key", async () => {
    const root = await createStateDir("main", "session-123");

    const target = await resolveOpenClawCurrentSessionTarget(
      { sessionId: "session-123", sessionKey: "agent:main:tui-current" },
      { resolveStateDir: () => root },
    );

    expect(target).toEqual({
      sessionId: "session-123",
      sessionFile: path.join(root, "agents", "main", "sessions", "session-123.jsonl"),
    });
  });

  it("returns undefined when the transcript file does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agenr-current-session-missing-"));
    tempRoots.push(root);

    const target = await resolveOpenClawCurrentSessionTarget(
      { sessionId: "missing-session", sessionKey: "agent:main:tui-current" },
      { resolveStateDir: () => root },
    );

    expect(target).toBeUndefined();
  });

  it("returns undefined when no agent id can be derived", async () => {
    const target = await resolveOpenClawCurrentSessionTarget({ sessionId: "session-123", sessionKey: "" }, { resolveStateDir: () => os.tmpdir() });

    expect(target).toBeUndefined();
  });
});
