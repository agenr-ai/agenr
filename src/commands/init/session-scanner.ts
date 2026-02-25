import fs from "node:fs/promises";
import path from "node:path";

export interface SessionScanResult {
  totalFiles: number;
  recentFiles: string[];
  allFiles: string[];
  totalSizeBytes: number;
  recentSizeBytes: number;
}

type RecursiveDirent = Awaited<ReturnType<typeof fs.readdir>>[number] & {
  parentPath?: string;
  path?: string;
};

function resolveParentPath(entry: RecursiveDirent, fallback: string): string {
  if (typeof entry.parentPath === "string") {
    return entry.parentPath;
  }
  if (typeof entry.path === "string") {
    return entry.path;
  }
  return fallback;
}

export async function scanSessionFiles(
  sessionsDir: string,
  recentDays: number = 7,
): Promise<SessionScanResult> {
  const result: SessionScanResult = {
    totalFiles: 0,
    recentFiles: [],
    allFiles: [],
    totalSizeBytes: 0,
    recentSizeBytes: 0,
  };

  try {
    const entries = (await fs.readdir(sessionsDir, {
      withFileTypes: true,
      recursive: true,
    })) as RecursiveDirent[];
    const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".jsonl.gz")) {
        continue;
      }

      const parentPath = resolveParentPath(entry, sessionsDir);
      const filePath = path.join(parentPath, entry.name);
      const stat = await fs.stat(filePath);

      result.allFiles.push(filePath);
      result.totalFiles += 1;
      result.totalSizeBytes += stat.size;

      if (stat.mtimeMs >= cutoff) {
        result.recentFiles.push(filePath);
        result.recentSizeBytes += stat.size;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  return result;
}
