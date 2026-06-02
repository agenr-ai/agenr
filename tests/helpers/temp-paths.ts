import { rm } from "node:fs/promises";
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** Resolves Unix-style fixture paths the same way CLI user-path handling does on Windows. */
export function resolveTestPath(unixStylePath: string): string {
  return path.resolve(unixStylePath);
}

/** Closes one temp database and waits for Windows file-handle release. */
export async function closeTestDatabase(database: { close(): Promise<void> }): Promise<void> {
  await database.close();
  await waitForDatabaseRelease();
}

/** Closes tracked databases, then waits once before temp-path cleanup. */
export async function closeTestDatabases(databases: Array<{ close(): Promise<void> }>): Promise<void> {
  while (databases.length > 0) {
    await databases.pop()!.close();
  }

  await waitForDatabaseRelease();
}

/** Removes temp files/directories while tolerating Windows file-lock cleanup races. */
export async function removeTestPath(targetPath: string): Promise<void> {
  if (!targetPath) {
    return;
  }

  const maxAttempts = IS_WIN ? 20 : 5;
  const retryDelayMs = IS_WIN ? 100 : 50;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(targetPath, { force: true, recursive: true, maxRetries: 0 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }

      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw error;
      }

      lastError = error;
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError;
}

/** Waits briefly on Windows so libSQL can release file handles before cleanup. */
export async function waitForDatabaseRelease(): Promise<void> {
  if (IS_WIN) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
