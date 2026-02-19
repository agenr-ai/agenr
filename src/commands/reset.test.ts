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
    getDbFn: vi.fn(() => db),
    closeDbFn: vi.fn(() => undefined),
    deleteFileFn: vi.fn(async () => undefined),
    stdoutLine: vi.fn(() => undefined),
    stderrLine: vi.fn(() => undefined),
    ...overrides,
  };

  return { deps, db };
}

describe("runResetCommand", () => {
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
    expect(stdoutLines).toContain(`  - Delete: ${watchStatePath}`);
    expect(stdoutLines).toContain(`  - Delete: ${REVIEW_QUEUE_PATH}`);
    expect(stdoutLines.at(-1)).toBe("Run with --confirm-reset to execute.");
  });

  it("runs full reset successfully and closes DB exactly once", async () => {
    const { deps, db } = createDeps();

    const result = await runResetCommand({ db: "/tmp/knowledge.db", confirmReset: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.backupDbFn).toHaveBeenCalledWith("/tmp/knowledge.db");
    expect(deps.getDbFn).toHaveBeenCalledWith("/tmp/knowledge.db");
    expect(deps.resetDbFn).toHaveBeenCalledWith(db);
    expect(deps.closeDbFn).toHaveBeenCalledTimes(1);
    expect(deps.deleteFileFn).toHaveBeenCalledTimes(2);
    expect(deps.deleteFileFn).toHaveBeenNthCalledWith(1, watchStatePath);
    expect(deps.deleteFileFn).toHaveBeenNthCalledWith(2, REVIEW_QUEUE_PATH);

    const stdoutLines = (deps.stdoutLine as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(stdoutLines).toContain(
      "WARNING: If the agenr watcher daemon is running, stop it before proceeding. Reset will not abort if the daemon is running.",
    );
    expect(stdoutLines).toContain("Backup created: /tmp/knowledge.db.backup-pre-reset-2026-02-19T10-00-00-000Z");
    expect(stdoutLines).toContain("Reset complete.");
    expect(stdoutLines).toContain("  DB schema dropped and recreated: /tmp/knowledge.db");
    expect(stdoutLines).toContain("  watch-state.json deleted (or was not present)");
    expect(stdoutLines).toContain("  review-queue.json deleted (or was not present)");
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
    expect(deps.closeDbFn).toHaveBeenCalledTimes(1);
    expect(deps.deleteFileFn).not.toHaveBeenCalled();
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
});
