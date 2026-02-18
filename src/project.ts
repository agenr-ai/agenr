import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export type StatLike = { isFile(): boolean; isDirectory(): boolean };

/**
 * Derive a project name from a working directory path.
 * Walks up from cwd looking for a .git/ directory (file or dir - works with worktrees/submodules).
 * Returns the git root's basename (lowercase).
 * Returns null if cwd is a home directory or root.
 */
export function detectProjectFromCwd(
  cwd: string,
  statFn: (p: string) => StatLike | null = (p) => {
    try {
      return fs.statSync(p);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      return null;
    }
  },
): string | null {
  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());

  if (resolved === path.parse(resolved).root) {
    return null;
  }
  if (resolved === home) {
    return null;
  }

  let current = resolved;
  while (true) {
    const gitPath = path.join(current, ".git");
    const stat = statFn(gitPath);
    if (stat && (stat.isDirectory() || stat.isFile())) {
      return path.basename(current).toLowerCase();
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

export function normalizeProject(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function parseProjectList(input: string | string[] | undefined): string[] {
  const rawItems = Array.isArray(input) ? input : input ? [input] : [];
  const parts = rawItems.flatMap((value) =>
    String(value)
      .split(",")
      .map((item) => item.trim()),
  );

  const normalized = parts
    .map((value) => normalizeProject(value))
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(normalized));
}

export function parseProjectItems(input: string | string[] | undefined): string[] {
  return parseProjectList(input);
}
