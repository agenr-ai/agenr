import fs from "node:fs/promises";
import path from "node:path";

import type { ProcedureFilePort } from "../../app/procedures/sync/index.js";

const PROCEDURE_FILE_PATTERN = /^.+\.ya?ml$/iu;

/**
 * Discovers procedure YAML files from a target file or directory path.
 *
 * @param targetPath - File or directory to inspect for procedure files.
 * @param options - Optional discovery flags.
 * @returns Sorted absolute procedure file paths.
 */
export async function discoverProcedureFiles(targetPath: string, options: { recursive?: boolean } = {}): Promise<string[]> {
  const resolvedTargetPath = path.resolve(targetPath);
  const stat = await fs.stat(resolvedTargetPath);

  if (stat.isFile()) {
    return matchesProcedureFileName(path.basename(resolvedTargetPath)) ? [resolvedTargetPath] : [];
  }

  const recursive = options.recursive ?? true;
  const entries = recursive
    ? await fs.readdir(resolvedTargetPath, { recursive: true, withFileTypes: true })
    : await fs.readdir(resolvedTargetPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && matchesProcedureFileName(entry.name))
    .map((entry) => path.resolve(entry.parentPath ?? resolvedTargetPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Reads one raw procedure YAML file from disk.
 *
 * @param filePath - Absolute procedure file path.
 * @returns Raw UTF-8 procedure source text.
 */
export async function readProcedureFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

/**
 * Shared local filesystem adapter for procedure discovery and reads.
 */
class LocalProcedureFiles implements ProcedureFilePort {
  /**
   * Discovers procedure YAML files from a target file or directory path.
   *
   * @param targetPath - File or directory to inspect for procedure files.
   * @param options - Optional discovery flags.
   * @returns Sorted absolute procedure file paths.
   */
  public async discoverFiles(targetPath: string, options?: { recursive?: boolean }): Promise<string[]> {
    return discoverProcedureFiles(targetPath, options);
  }

  /**
   * Reads one raw procedure YAML file from disk.
   *
   * @param filePath - Absolute procedure file path.
   * @returns Raw UTF-8 procedure source text.
   */
  public async readFile(filePath: string): Promise<string> {
    return readProcedureFile(filePath);
  }
}

const localProcedureFiles: ProcedureFilePort = new LocalProcedureFiles();

export { localProcedureFiles };

/**
 * Checks whether a basename matches one supported procedure file extension.
 *
 * @param fileName - Basename to inspect.
 * @returns `true` when the file name is a YAML procedure file.
 */
function matchesProcedureFileName(fileName: string): boolean {
  return PROCEDURE_FILE_PATTERN.test(fileName.trim());
}
