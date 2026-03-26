import fs from "node:fs/promises";
import path from "node:path";

/**
 * Discovers transcript files from a target file or directory path.
 *
 * @param targetPath - File or directory to inspect for transcript files.
 * @param options - Optional discovery flags.
 * @returns Sorted absolute transcript file paths.
 */
export async function discoverFiles(targetPath: string, options: { recursive?: boolean } = {}): Promise<string[]> {
  const resolvedTargetPath = path.resolve(targetPath);
  const stat = await fs.stat(resolvedTargetPath);

  if (stat.isFile()) {
    return [resolvedTargetPath];
  }

  const recursive = options.recursive ?? true;
  const entries = recursive
    ? await fs.readdir(resolvedTargetPath, { recursive: true, withFileTypes: true })
    : await fs.readdir(resolvedTargetPath, { withFileTypes: true });

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.includes(".jsonl"))
    .map((entry) => path.resolve(entry.parentPath ?? resolvedTargetPath, entry.name))
    .sort((left, right) => left.localeCompare(right));

  return files;
}
