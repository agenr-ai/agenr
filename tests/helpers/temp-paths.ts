import { rm } from "node:fs/promises";
import path from "node:path";

/** Resolves Unix-style fixture paths the same way CLI user-path handling does on Windows. */
export function resolveTestPath(unixStylePath: string): string {
  return path.resolve(unixStylePath);
}

/** Removes temp files/directories while tolerating Windows file-lock cleanup races. */
export async function removeTestPath(targetPath: string): Promise<void> {
  await rm(targetPath, {
    force: true,
    recursive: true,
    maxRetries: process.platform === "win32" ? 10 : 3,
    retryDelay: process.platform === "win32" ? 200 : 50,
  });
}

/** Waits briefly on Windows so libSQL can release file handles before cleanup. */
export async function waitForDatabaseRelease(): Promise<void> {
  if (process.platform === "win32") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
