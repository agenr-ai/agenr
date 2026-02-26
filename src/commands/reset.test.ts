import path from "node:path";
import type { Client } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { REVIEW_QUEUE_PATH } from "../consolidate/verify.js";
import { resolveConfigDir } from "../watch/state.js";
import { runResetCommand, type ResetCommandDeps } from "./reset.js";

function makeErrnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createDeps(overrides?: Partial<ResetCommandDeps>): { deps: ResetCommandDeps; db: Client } {
  const db = {} as Client;
  const deps: ResetCommandDeps = {
    resolveDbPathFn: vi.fn(() => "/tmp/knowledge.db"),
    backupDbFn: vi.fn(async () => "/tmp/knowledge.db.backup-pre-reset-2026-02-19T10-00-00-000Z"),
    resetDbFn: vi.fn(async () => undefined),
    vacuumDbFn: vi.fn(async () => undefined),
    getDbFn: vi.fn(() => db),
    closeDbFn: vi.fn(() => undefined),
    listContextFilesFn: vi.fn(async () => []),
    deleteFileFn: vi.fn(async () => undefined),
    stdoutLine: vi.fn(() => undefined),
    stderrLine: vi.fn(() => undefined),
    ...overrides,
  };

  return { deps, db };
}

describe("runResetCommand", () => {
  const configDir = resolveConfigDir();
  const watchStatePath = path.join(resolveConfigDir(), "watch-state.json");

  it("prints dry-run summary and exits 0 when --confirm-reset is missing", async () => {
    const { deps } = createDeps();

    const result = await runResetCommand({ db: "/tmp/knowledge.db", confirmReset: false }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.backupDbFn).not.toHaveBeenCalled();
    expect(deps.resetDbFn).not.toHaveBeenCalled();
    expect(deps.deleteFileFn).not.toHaveBeenCalled();

    const stdoutLines = (deps.stdoutLine as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(stdoutLines[0]).toBe("[dry run] agenr db reset --full would perform the following actions:");
    expect(stdoutLines[1]).toMatch(/^  - Backup database to: \/tmp\/knowledge\.db\.backup-pre-reset-.+Z$/);
    expect(stdoutLines).toContain("  - Drop and recreate DB schema (all data erased, file retained)");
    expect(stdoutLines).toContain("  - VACUUM database (reclaim freed pages)");
    expect(stdoutLines).toContain(`  - Delete: ${watchStatePath}`);
    expect(stdoutLines).toContain(`  - Delete: ${REVIEW_QUEUE_PATH}`);
    expect(stdoutLines).toContain(`  - Delete: ${path.join(configDir, "context*.md")} (any matching files)`);
    expect(stdoutLines.at(-1)).toBe("Run with --confirm-reset to execute.");
  });

  it("runs full reset successfully and closes DB exactly once", async () => {
    const { deps, db } = createDeps();

    const result = await runResetCommand({ db: "/tmp/knowledge.db", confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.backupDbFn).toHaveBeenCalledWith("/tmp/knowledge.db");
    expect(deps.getDbFn).toHaveBeenCalledWith("/tmp/knowledge.db");
    expect(deps.resetDbFn).toHaveBeenCalledWith(db);
    expect(deps.vacuumDbFn).toHaveBeenCalledWith(db);
    expect(deps.closeDbFn).toHaveBeenCalledTimes(1);
    expect(deps.listContextFilesFn).toHaveBeenCalledTimes(1);
    expect(deps.deleteFileFn).toHaveBeenCalledTimes(2);
    expect(deps.deleteFileFn).toHaveBeenNthCalledWith(1, watchStatePath);
    expect(deps.deleteFileFn).toHaveBeenNthCalledWith(2, REVIEW_QUEUE_PATH);

    const stdoutLines = (deps.stdoutLine as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(stdoutLines).toContain(
      "WARNING: If the agenr watcher is running, stop it before proceeding. Reset will not abort if the watcher is running.",
    );
    expect(stdoutLines).toContain("Backup created: /tmp/knowledge.db.backup-pre-reset-2026-02-19T10-00-00-000Z");
    expect(stdoutLines).toContain("Reset complete.");
    expect(stdoutLines).toContain("  DB schema dropped and recreated: /tmp/knowledge.db");
    expect(stdoutLines).toContain("  VACUUM complete (freed pages reclaimed)");
    expect(stdoutLines).toContain("  watch-state.json deleted (or was not present)");
    expect(stdoutLines).toContain("  review-queue.json deleted (or was not present)");
    expect(stdoutLines).toContain("  context*.md: none found");
  });

  it("treats missing watch-state.json (ENOENT) as success", async () => {
    const { deps } = createDeps({
      deleteFileFn: vi.fn(async (filePath: string) => {
        if (filePath === watchStatePath) {
          throw makeErrnoError("ENOENT", "missing watch-state");
        }
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.stderrLine).not.toHaveBeenCalled();
    expect(deps.stdoutLine).toHaveBeenCalledWith("Reset complete.");
  });

  it("treats missing review-queue.json (ENOENT) as success", async () => {
    const { deps } = createDeps({
      deleteFileFn: vi.fn(async (filePath: string) => {
        if (filePath === REVIEW_QUEUE_PATH) {
          throw makeErrnoError("ENOENT", "missing review queue");
        }
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.stderrLine).not.toHaveBeenCalled();
    expect(deps.stdoutLine).toHaveBeenCalledWith("Reset complete.");
  });

  it("returns exit 1 on backup failure without resetting DB or deleting files", async () => {
    const { deps } = createDeps({
      backupDbFn: vi.fn(async () => {
        throw new Error("backup failed");
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLine).toHaveBeenCalledWith("backup failed");
    expect(deps.resetDbFn).not.toHaveBeenCalled();
    expect(deps.deleteFileFn).not.toHaveBeenCalled();
  });

  it("returns exit 1 on DB reset failure, still closes DB, and skips side file deletes", async () => {
    const { deps, db } = createDeps({
      resetDbFn: vi.fn(async () => {
        throw new Error("reset failed");
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLine).toHaveBeenCalledWith("reset failed");
    expect(deps.getDbFn).toHaveBeenCalled();
    expect(deps.resetDbFn).toHaveBeenCalledWith(db);
    expect(deps.vacuumDbFn).not.toHaveBeenCalled();
    expect(deps.closeDbFn).toHaveBeenCalledTimes(1);
    expect(deps.deleteFileFn).not.toHaveBeenCalled();
  });

  it("calls vacuumDbFn after resetDbFn on successful reset", async () => {
    const { deps } = createDeps();

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.resetDbFn).toHaveBeenCalledTimes(1);
    expect(deps.vacuumDbFn).toHaveBeenCalledTimes(1);
    const resetCallOrder = (deps.resetDbFn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const vacuumCallOrder =
      (deps.vacuumDbFn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Number.MIN_SAFE_INTEGER;
    expect(vacuumCallOrder).toBeGreaterThan(resetCallOrder);
  });

  it("returns exit 1 when vacuumDbFn throws", async () => {
    const { deps } = createDeps({
      vacuumDbFn: vi.fn(async () => {
        throw new Error("vacuum failed");
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLine).toHaveBeenCalledWith("vacuum failed");
    expect(deps.closeDbFn).toHaveBeenCalledTimes(1);
  });

  it("warns on non-ENOENT side-file deletion errors and still exits 0", async () => {
    const { deps } = createDeps({
      deleteFileFn: vi.fn(async (filePath: string) => {
        if (filePath === watchStatePath) {
          throw makeErrnoError("EPERM", "permission denied");
        }
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.deleteFileFn).toHaveBeenCalledTimes(2);
    expect(deps.stderrLine).toHaveBeenCalledWith(
      expect.stringContaining(`Warning: failed to delete ${watchStatePath}: permission denied`),
    );
    expect(deps.stdoutLine).toHaveBeenCalledWith("Reset complete.");
  });

  it("deletes context files during full reset and reports each file", async () => {
    const contextMiniPath = path.join(configDir, "context-mini.md");
    const contextHotPath = path.join(configDir, "context-hot.md");
    const { deps } = createDeps({
      listContextFilesFn: vi.fn(async () => [contextMiniPath, contextHotPath]),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.deleteFileFn).toHaveBeenCalledTimes(4);
    expect(deps.deleteFileFn).toHaveBeenNthCalledWith(3, contextMiniPath);
    expect(deps.deleteFileFn).toHaveBeenNthCalledWith(4, contextHotPath);

    const stdoutLines = (deps.stdoutLine as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(stdoutLines).toContain("  context-mini.md deleted");
    expect(stdoutLines).toContain("  context-hot.md deleted");
  });

  it("prints context*.md none found when no context files exist", async () => {
    const { deps } = createDeps({
      listContextFilesFn: vi.fn(async () => []),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.deleteFileFn).toHaveBeenCalledTimes(2);
    const deletedPaths = (deps.deleteFileFn as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(deletedPaths).not.toContain(path.join(configDir, "context-mini.md"));
    expect(deletedPaths).not.toContain(path.join(configDir, "context-hot.md"));
    expect(deps.stdoutLine).toHaveBeenCalledWith("  context*.md: none found");
  });

  it("treats missing context file (ENOENT) as success", async () => {
    const contextMiniPath = path.join(configDir, "context-mini.md");
    const { deps } = createDeps({
      listContextFilesFn: vi.fn(async () => [contextMiniPath]),
      deleteFileFn: vi.fn(async (filePath: string) => {
        if (filePath === contextMiniPath) {
          throw makeErrnoError("ENOENT", "missing context file");
        }
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.stderrLine).not.toHaveBeenCalled();
    expect(deps.stdoutLine).toHaveBeenCalledWith("Reset complete.");
  });

  it("warns on non-ENOENT context deletion errors and still exits 0", async () => {
    const contextMiniPath = path.join(configDir, "context-mini.md");
    const { deps } = createDeps({
      listContextFilesFn: vi.fn(async () => [contextMiniPath]),
      deleteFileFn: vi.fn(async (filePath: string) => {
        if (filePath === contextMiniPath) {
          throw makeErrnoError("EPERM", "permission denied");
        }
      }),
    });

    const result = await runResetCommand({ confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.stderrLine).toHaveBeenCalledWith(
      expect.stringContaining(`Warning: failed to delete ${contextMiniPath}: permission denied`),
    );
    expect(deps.stdoutLine).toHaveBeenCalledWith("Reset complete.");
  });
});
