import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runDaemonInstallCommand,
  runDaemonLogsCommand,
  runDaemonRestartCommand,
  runDaemonStartCommand,
  runDaemonStatusCommand,
  runDaemonStopCommand,
  runDaemonUninstallCommand,
  resolveStableNodePath,
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
    const sessionsDir = path.join(home, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const launchctlCalls: string[][] = [];

    const result = await runDaemonInstallCommand(
      { force: true, dir: sessionsDir, platform: "openclaw" },
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
    expect(plist).toContain("--dir");
    expect(plist).toContain(sessionsDir);
    expect(plist).toContain("--platform");
    expect(plist).toContain("openclaw");
    expect(plist).toContain("--interval");
    expect(plist).toContain("120");

    expect(launchctlCalls).toEqual([
      ["bootout", "gui/501/com.agenr.watch"],
      ["bootstrap", "gui/501", plistPath],
    ]);
  });

  it("passes --context through to launchd watch arguments", async () => {
    const home = await makeTempDir();
    const sessionsDir = path.join(home, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const result = await runDaemonInstallCommand(
      { force: true, context: "/tmp/CONTEXT.md", dir: sessionsDir, platform: "openclaw" },
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

describe("daemon start", () => {
  it("errors when plist not found", async () => {
    const home = await makeTempDir();
    await expect(
      runDaemonStartCommand({}, { platformFn: () => "darwin", homedirFn: () => home, uidFn: () => 501 }),
    ).rejects.toThrow("Daemon not installed. Run `agenr daemon install` first.");
  });

  it("no-ops when already running", async () => {
    const home = await makeTempDir();
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "test", "utf8");

    const calls: string[][] = [];
    const result = await runDaemonStartCommand(
      {},
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "print") {
            return { stdout: "state = running\npid = 123\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["print", "gui/501/com.agenr.watch"]]);
  });

  it("starts via bootstrap when installed but not loaded", async () => {
    const home = await makeTempDir();
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "test", "utf8");

    const calls: string[][] = [];
    const result = await runDaemonStartCommand(
      {},
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "print") {
            return { stdout: "", stderr: "Could not find service", exitCode: 113 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      ["print", "gui/501/com.agenr.watch"],
      ["bootstrap", "gui/501", plistPath],
    ]);
  });

  it("handles loaded-but-not-running by bootout then bootstrap", async () => {
    const home = await makeTempDir();
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "test", "utf8");

    const calls: string[][] = [];
    const result = await runDaemonStartCommand(
      {},
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "print") {
            return { stdout: "state = stopped\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      ["print", "gui/501/com.agenr.watch"],
      ["bootout", "gui/501/com.agenr.watch"],
      ["bootstrap", "gui/501", plistPath],
    ]);
  });
});

describe("daemon stop", () => {
  it("errors when plist not found", async () => {
    const home = await makeTempDir();
    await expect(
      runDaemonStopCommand({}, { platformFn: () => "darwin", homedirFn: () => home, uidFn: () => 501 }),
    ).rejects.toThrow("Daemon not installed. Run `agenr daemon install` first.");
  });

  it("no-ops when not running", async () => {
    const home = await makeTempDir();
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "test", "utf8");

    const calls: string[][] = [];
    const result = await runDaemonStopCommand(
      {},
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "print") {
            return { stdout: "", stderr: "Could not find service", exitCode: 113 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["print", "gui/501/com.agenr.watch"]]);
  });

  it("stops via bootout when running", async () => {
    const home = await makeTempDir();
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "test", "utf8");

    const calls: string[][] = [];
    const result = await runDaemonStopCommand(
      {},
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "print") {
            return { stdout: "state = running\npid = 321\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      ["print", "gui/501/com.agenr.watch"],
      ["bootout", "gui/501/com.agenr.watch"],
    ]);
  });
});

describe("daemon restart", () => {
  it("errors when not installed", async () => {
    const home = await makeTempDir();
    await expect(
      runDaemonRestartCommand({}, { platformFn: () => "darwin", homedirFn: () => home, uidFn: () => 501 }),
    ).rejects.toThrow("Daemon not installed.");
  });

  it("restarts successfully (bootout + sleep + bootstrap)", async () => {
    const home = await makeTempDir();
    const plistPath = path.join(home, "Library", "LaunchAgents", "com.agenr.watch.plist");
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "test", "utf8");

    const calls: string[][] = [];
    const sleeps: number[] = [];

    const result = await runDaemonRestartCommand(
      {},
      {
        platformFn: () => "darwin",
        homedirFn: () => home,
        uidFn: () => 501,
        sleepFn: async (ms: number) => {
          sleeps.push(ms);
        },
        execFileFn: vi.fn(async (_file: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "bootout") {
            return { stdout: "", stderr: "not loaded", exitCode: 5 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(sleeps).toEqual([500]);
    expect(calls).toEqual([
      ["bootout", "gui/501/com.agenr.watch"],
      ["bootstrap", "gui/501", plistPath],
    ]);
  });
});

describe("resolveStableNodePath", () => {
  it("returns original path when no version-specific segment detected", async () => {
    const statFn = vi.fn(async () => {
      throw new Error("should not be called");
    });

    await expect(resolveStableNodePath("/usr/local/bin/node", statFn as any)).resolves.toBe("/usr/local/bin/node");
    expect(statFn).not.toHaveBeenCalled();
  });

  it("returns stable Homebrew path when available and executable", async () => {
    const statFn = vi.fn(async (filePath: string) => {
      if (filePath === "/opt/homebrew/bin/node") {
        return {
          isFile: () => true,
          isDirectory: () => false,
          mode: 0o755,
        } as any;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await expect(
      resolveStableNodePath("/opt/homebrew/Cellar/node/25.5.0/bin/node", statFn as any),
    ).resolves.toBe("/opt/homebrew/bin/node");
  });

  it("falls back to original when stable path doesn't exist", async () => {
    const statFn = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await expect(
      resolveStableNodePath("/opt/homebrew/Cellar/node/25.5.0/bin/node", statFn as any),
    ).resolves.toBe("/opt/homebrew/Cellar/node/25.5.0/bin/node");
  });

  it("--node-path overrides auto-resolution in daemon install", async () => {
    const home = await makeTempDir();
    const sessionsDir = path.join(home, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const result = await runDaemonInstallCommand(
      { force: true, dir: sessionsDir, platform: "openclaw", nodePath: "/custom/node" },
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
    expect(plist).toContain("<string>/custom/node</string>");
  });
});

describe("daemon install smart defaults", () => {
  it("detects OpenClaw sessions dir and generates correct ProgramArguments", async () => {
    const home = await makeTempDir();
    const openclawDir = path.join(home, ".openclaw", "agents", "main", "sessions");
    await fs.mkdir(openclawDir, { recursive: true });

    const result = await runDaemonInstallCommand(
      { force: true },
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
    expect(plist).toContain("--dir");
    expect(plist).toContain(openclawDir);
    expect(plist).toContain("--platform");
    expect(plist).toContain("openclaw");
  });

  it("falls back to Codex if OpenClaw not found", async () => {
    const home = await makeTempDir();
    const codexDir = path.join(home, ".codex", "sessions");
    await fs.mkdir(codexDir, { recursive: true });

    const result = await runDaemonInstallCommand(
      { force: true },
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
    expect(plist).toContain(codexDir);
    expect(plist).toContain("codex");
  });

  it("falls back to Claude Code if OpenClaw and Codex not found", async () => {
    const home = await makeTempDir();
    const claudeDir = path.join(home, ".claude", "projects");
    await fs.mkdir(claudeDir, { recursive: true });

    const result = await runDaemonInstallCommand(
      { force: true },
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
    expect(plist).toContain(claudeDir);
    expect(plist).toContain("claude-code");
  });

  it("errors when no platform detected", async () => {
    const home = await makeTempDir();
    await expect(
      runDaemonInstallCommand(
        { force: true },
        {
          platformFn: () => "darwin",
          homedirFn: () => home,
          uidFn: () => 501,
          argvFn: () => ["node", "/tmp/dist/cli.js"],
          execFileFn: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
        },
      ),
    ).rejects.toThrow(
      "No supported platform detected. Use --dir <path> --platform <name> to specify manually.",
    );
  });

  it("--platform without --dir resolves default directory", async () => {
    const home = await makeTempDir();
    const codexDir = path.join(home, ".codex", "sessions");
    await fs.mkdir(codexDir, { recursive: true });

    const result = await runDaemonInstallCommand(
      { force: true, platform: "codex" },
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
    expect(plist).toContain(codexDir);
    expect(plist).toContain("codex");
  });

  it("--dir and --platform passed through to ProgramArguments", async () => {
    const home = await makeTempDir();
    const sessionsDir = path.join(home, "my-sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const result = await runDaemonInstallCommand(
      { force: true, dir: sessionsDir, platform: "claude-code" },
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
    expect(plist).toContain(sessionsDir);
    expect(plist).toContain("claude-code");
  });
});
