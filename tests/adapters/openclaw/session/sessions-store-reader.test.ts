import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readOpenClawSessionsStoreWithDiagnostics } from "../../../../src/adapters/openclaw/session/sessions-store-reader.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("readOpenClawSessionsStoreWithDiagnostics", () => {
  it("returns entries without diagnostics for a valid sessions.json file", async () => {
    const sessionsDir = await createSessionsDir();
    await writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "123e4567-e89b-12d3-a456-426614174000",
            sessionFile: "123e4567-e89b-12d3-a456-426614174000.jsonl",
            origin: {
              surface: "tui",
            },
            updatedAt: 123,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await readOpenClawSessionsStoreWithDiagnostics(sessionsDir);

    expect(result.diagnostics).toEqual([]);
    expect(result.entries).toEqual([
      {
        sessionKey: "agent:main:main",
        sessionId: "123e4567-e89b-12d3-a456-426614174000",
        sessionFile: path.join(sessionsDir, "123e4567-e89b-12d3-a456-426614174000.jsonl"),
        surface: "tui",
        updatedAt: 123,
      },
    ]);
  });

  it("reports a missing sessions.json file explicitly", async () => {
    const sessionsDir = await createSessionsDir();

    const result = await readOpenClawSessionsStoreWithDiagnostics(sessionsDir);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        kind: "missing_file",
        message: `sessions.json missing at ${path.join(sessionsDir, "sessions.json")}`,
        path: path.join(sessionsDir, "sessions.json"),
      },
    ]);
  });

  it("reports malformed JSON explicitly", async () => {
    const sessionsDir = await createSessionsDir();
    await writeFile(path.join(sessionsDir, "sessions.json"), "{not valid json", "utf8");

    const result = await readOpenClawSessionsStoreWithDiagnostics(sessionsDir);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: "malformed_json",
      path: path.join(sessionsDir, "sessions.json"),
    });
    expect(result.diagnostics[0]?.message).toContain("sessions.json parse failed");
  });

  it("reports structurally invalid JSON explicitly", async () => {
    const sessionsDir = await createSessionsDir();
    await writeFile(path.join(sessionsDir, "sessions.json"), '["not-an-object"]\n', "utf8");

    const result = await readOpenClawSessionsStoreWithDiagnostics(sessionsDir);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        kind: "structurally_invalid_file",
        message: `sessions.json did not contain an object: path=${path.join(sessionsDir, "sessions.json")}`,
        path: path.join(sessionsDir, "sessions.json"),
      },
    ]);
  });

  it("reports unreadable sessions.json paths explicitly", async () => {
    const sessionsDir = await createSessionsDir();
    await mkdir(path.join(sessionsDir, "sessions.json"), { recursive: true });

    const result = await readOpenClawSessionsStoreWithDiagnostics(sessionsDir);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: "unreadable_file",
      path: path.join(sessionsDir, "sessions.json"),
    });
    expect(result.diagnostics[0]?.message).toContain("sessions.json read failed");
  });
});

async function createSessionsDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-openclaw-sessions-store-"));
  tempDirectories.push(directory);
  const sessionsDir = path.join(directory, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}
