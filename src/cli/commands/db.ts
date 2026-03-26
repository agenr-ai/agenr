import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as clack from "@clack/prompts";
import type { Command } from "commander";

import { createDatabase } from "../../adapters/db/client.js";
import { readConfig, resolveDbPath } from "../../config.js";
import { banner, ui } from "../../ui.js";

interface ResetCommandOptions {
  yes?: boolean;
}

/**
 * Registers the `agenr db` command group and available subcommands.
 *
 * @param program - Root Commander program to extend.
 */
export function registerDbCommand(program: Command): void {
  const dbCommand = program.command("db").description("Database utilities");

  dbCommand
    .command("reset")
    .description("Delete and recreate the knowledge database")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: ResetCommandOptions) => {
      clack.intro(banner());

      try {
        const config = readConfig();
        const dbPath = resolveDbPath(config);
        const resolvedPath = resolveResetPath(dbPath);

        const confirmed =
          options.yes === true
            ? true
            : await clack.confirm({
                message: `⚠ This will delete all entries in ${resolvedPath.displayPath}. Continue?`,
              });

        if (clack.isCancel(confirmed) || confirmed !== true) {
          clack.outro("Cancelled.");
          return;
        }

        if (resolvedPath.deletePath) {
          await deleteDatabaseFile(resolvedPath.deletePath);
        }

        const database = await createDatabase(dbPath);
        await database.close();

        clack.outro(`Database reset. Fresh schema created at ${resolvedPath.displayPath}`);
      } catch (error) {
        process.exitCode = 1;
        clack.log.error(formatUnknownError(error));
        clack.outro(ui.error("Database reset failed"));
      }
    });
}

function resolveResetPath(dbPath: string): { deletePath?: string; displayPath: string } {
  if (dbPath === ":memory:") {
    return { displayPath: dbPath };
  }

  if (dbPath.startsWith("file:")) {
    try {
      const filePath = fileURLToPath(dbPath);
      return {
        deletePath: filePath,
        displayPath: filePath,
      };
    } catch {
      const resolvedPath = path.resolve(dbPath.slice("file:".length));
      return {
        deletePath: resolvedPath,
        displayPath: resolvedPath,
      };
    }
  }

  const resolvedPath = path.resolve(dbPath);
  return {
    deletePath: resolvedPath,
    displayPath: resolvedPath,
  };
}

async function deleteDatabaseFile(dbPath: string): Promise<void> {
  const filesToDelete = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
  for (const file of filesToDelete) {
    try {
      await fs.unlink(file);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
