import fs from "node:fs/promises";
import path from "node:path";
import type { SessionResolver } from "../session-resolver.js";

export interface MtimeCandidate {
  filePath: string;
  mtimeMs: number;
}

export interface FindMostRecentFileOptions {
  recursive?: boolean;
  includeFile?: (filePath: string) => boolean;
  includeDirectory?: (dirPath: string) => boolean;
}

async function walkFiles(
  rootDir: string,
  options: FindMostRecentFileOptions,
): Promise<string[]> {
  const out: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!options.recursive) {
          continue;
        }
        if (options.includeDirectory && !options.includeDirectory(fullPath)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (options.includeFile && !options.includeFile(fullPath)) {
        continue;
      }

      out.push(fullPath);
    }
  }

  return out;
}

export async function findMostRecentByMtime(
  dir: string,
  options: FindMostRecentFileOptions,
): Promise<MtimeCandidate | null> {
  const resolvedDir = path.resolve(dir);
  const files = await walkFiles(resolvedDir, options);

  let best: MtimeCandidate | null = null;
  for (const filePath of files) {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }

    const candidate: MtimeCandidate = {
      filePath: path.resolve(filePath),
      mtimeMs: stat.mtimeMs,
    };

    if (!best || candidate.mtimeMs > best.mtimeMs) {
      best = candidate;
    }
  }

  return best;
}

export interface MtimeResolverOptions {
  recursive?: boolean;
  includeFile?: (filePath: string) => boolean;
}

export function createMtimeResolver(filePattern = "*.jsonl", options?: MtimeResolverOptions): SessionResolver {
  return {
    filePattern,
    async resolveActiveSession(dir: string): Promise<string | null> {
      const result = await findMostRecentByMtime(dir, {
        recursive: options?.recursive ?? filePattern.includes("**/"),
        includeFile:
          options?.includeFile ??
          ((filePath: string) => {
            return filePath.toLowerCase().endsWith(".jsonl");
          }),
      });
      return result?.filePath ?? null;
    },
  };
}

export const mtimeResolver: SessionResolver = createMtimeResolver("*.jsonl");
