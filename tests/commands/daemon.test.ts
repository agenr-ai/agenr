import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runDaemonInstallCommand,
  runDaemonLogsCommand,
  runDaemonStatusCommand,
  runDaemonUninstallCommand,
} from "../../src/commands/daemon.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-daemon-command-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe("daemon commands", () => {
  it("generates launchd plist and runs bootstrap on install", async () => {
    const home = await makeTempDir();
    const launchctlCalls: string[][] = [];

    const result = await runDaemonInstallCommand(
      { force: true },
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        argvFn: () => ["node", "/tmp/dist/cli.js"],
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          launchctlCalls.push(args);
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);

    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    const plist = await fs.readFile(plistPath, "utf8");
    expect(plist).toContain("com.agenr.watch");
    expect(plist).toContain("watch");
    expect(plist).toContain("--auto");
    expect(plist).toContain("--interval");
    expect(plist).toContain("120");

    expect(launchctlCalls).toEqual([
      ["bootout", "gui/501/com.agenr.watch"],
      ["bootstrap", "gui/501", plistPath],
    ]);
  });

  it("passes --context through to launchd watch arguments", async () => {
    const home = await makeTempDir();

    const result = await runDaemonInstallCommand(
      { force: true, context: "/tmp/CONTEXT.md" },
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        argvFn: () => ["node", "/tmp/dist/cli.js"],
        execFileFn: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      },
    );

    expect(result.exitCode).toBe(0);

    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    const plist = await fs.readFile(plistPath, "utf8");
    expect(plist).toContain("--context");
    expect(plist).toContain("/tmp/CONTEXT.md");
  });

  it("uninstalls daemon by bootout + plist removal", async () => {
    const home = await makeTempDir();
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "test", "utf8");

    const execCalls: string[][] = [];
    const result = await runDaemonUninstallCommand(
      { yes: true },
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          execCalls.push(args);
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    await expect(fs.stat(plistPath)).rejects.toThrow();
    expect(execCalls).toEqual([["bootout", "gui/501/com.agenr.watch"]]);
  });

  it("reports launchd status and current watched file", async () => {
    const home = await makeTempDir();
    const logDir = path.join(home, ".agenr", "logs");
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, "watch.log"), "one\ntwo\nthree\n", "utf8");

    const result = await runDaemonStatusCommand(
      { lines: 2 },
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        execFileFn: vi.fn(async () => ({
          stdout: "state = running\npid = 123\n",
          stderr: "",
          exitCode: 0,
        })),
        loadWatchStateFn: vi.fn(async () => ({
          version: 1 as const,
          files: {
            "/tmp/a.jsonl": {
              filePath: "/tmp/a.jsonl",
              byteOffset: 10,
              lastRunAt: "2026-02-15T00:00:00.000Z",
              totalEntriesStored: 1,
              totalRunCount: 1,
            },
            "/tmp/b.jsonl": {
              filePath: "/tmp/b.jsonl",
              byteOffset: 20,
              lastRunAt: "2026-02-16T00:00:00.000Z",
              totalEntriesStored: 2,
              totalRunCount: 2,
            },
          },
        })),
      },
    );

    expect(result.loaded).toBe(true);
    expect(result.running).toBe(true);
    expect(result.currentFile).toBe("/tmp/b.jsonl");
    expect(result.logTail).toEqual(["two", "three"]);
  });

  it("supports non-follow log output with --lines", async () => {
    const home = await makeTempDir();
    const logDir = path.join(home, ".agenr", "logs");
    const logPath = path.join(logDir, "watch.log");
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logPath, "a\nb\nc\n", "utf8");

    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });

    const result = await runDaemonLogsCommand(
      { lines: 2, follow: false },
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
      },
    );

    writeSpy.mockRestore();

    expect(result.exitCode).toBe(0);
    const output = writes.join("");
    expect(output).toContain("b\n");
    expect(output).toContain("c\n");
    expect(output).not.toContain("a\n");
  });

  it("returns an unsupported-platform error on non-macOS", async () => {
    await expect(runDaemonInstallCommand({}, { platformFn: () => "linux" })).rejects.toThrow(
      "macOS only",
    );
  });
});
