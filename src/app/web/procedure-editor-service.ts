import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDatabase } from "../../adapters/db/client.js";
import { discoverProcedureFiles, localProcedureFiles, readProcedureFile } from "../../adapters/files/procedure-files.js";
import { readGitWorktreeStatus, type GitWorktreeStatus } from "../../adapters/git/worktree-status.js";
import type { EmbeddingPort } from "../../core/ports.js";
import { parseAndNormalizeProcedureYaml } from "../../core/procedures/normalization.js";
import { executeProcedureSync, prepareProcedureSync } from "../procedures/sync/index.js";
import type { ProcedureSyncExecutionResult, ProcedureSyncPlan } from "../procedures/sync/types.js";

/**
 * One discovered procedure YAML file relative to the procedures directory.
 */
export interface ProcedureFileEntry {
  /** Absolute file path. */
  absolutePath: string;
  /** Path relative to the configured procedures directory. */
  relativePath: string;
}

/**
 * Procedure workspace listing with worktree status for the editor.
 */
export interface ProcedureWorkspace {
  /** Resolved absolute procedures directory. */
  directory: string;
  /** Discovered procedure YAML files. */
  files: ProcedureFileEntry[];
  /** Git worktree status for the directory's repository. */
  git: GitWorktreeStatus;
}

/**
 * Result of validating one procedure YAML document.
 */
export interface ProcedureValidationResult {
  /** True when the document parses and normalizes cleanly. */
  valid: boolean;
  /** Failure message when invalid. */
  error?: string;
  /** Procedure key parsed from a valid document. */
  procedureKey?: string;
  /** Title parsed from a valid document. */
  title?: string;
}

/**
 * One procedure document's content plus its validation status.
 */
export interface ProcedureDocument {
  /** Absolute file path. */
  absolutePath: string;
  /** Path relative to the procedures directory. */
  relativePath: string;
  /** Raw YAML content. */
  content: string;
  /** Validation status of the current content. */
  validation: ProcedureValidationResult;
}

/**
 * Result of a save-and-sync operation.
 */
export interface ProcedureSaveResult {
  /** Validation status of the saved content. */
  validation: ProcedureValidationResult;
  /** Plan computed after the file was written. */
  plan: ProcedureSyncPlan;
  /** Execution result, present only when the plan had no invalid files. */
  execution: ProcedureSyncExecutionResult | null;
  /** Git worktree status after the write. */
  git: GitWorktreeStatus;
}

/**
 * Lists procedure YAML files and worktree status for the editor.
 *
 * @param input - Procedures directory to inspect.
 * @returns Discovered files plus the repository's worktree status.
 */
export async function loadProcedureWorkspace(input: { proceduresDir: string }): Promise<ProcedureWorkspace> {
  const directory = path.resolve(input.proceduresDir);
  const [absolutePaths, git] = await Promise.all([discoverProcedureFiles(directory, { recursive: true }), readGitWorktreeStatus(directory)]);

  const files = absolutePaths.map((absolutePath) => ({
    absolutePath,
    relativePath: path.relative(directory, absolutePath) || path.basename(absolutePath),
  }));

  return { directory, files, git };
}

/**
 * Reads and validates one procedure document.
 *
 * @param input - Procedures directory and a contained relative file path.
 * @returns Document content plus its validation status.
 * @throws Error When the path escapes the procedures directory.
 */
export async function readProcedureDocument(input: { proceduresDir: string; relativePath: string }): Promise<ProcedureDocument> {
  const { directory, absolutePath } = resolveContainedPath(input.proceduresDir, input.relativePath);
  const content = await readProcedureFile(absolutePath);

  return {
    absolutePath,
    relativePath: path.relative(directory, absolutePath),
    content,
    validation: validateProcedureContent(content, absolutePath),
  };
}

/**
 * Validates a procedure YAML string without touching disk.
 *
 * @param input - YAML content and a label used in error messages.
 * @returns Validation result.
 */
export function validateProcedureContent(content: string, filePath: string): ProcedureValidationResult {
  try {
    const procedure = parseAndNormalizeProcedureYaml(content, filePath);
    return { valid: true, procedureKey: procedure.procedure_key, title: procedure.title };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Computes a dry-run procedure sync plan for the directory.
 *
 * @param input - Procedures directory and instance database path.
 * @returns The plan plus current worktree status.
 */
export async function previewProcedureSync(input: { proceduresDir: string; dbPath: string }): Promise<{ plan: ProcedureSyncPlan; git: GitWorktreeStatus }> {
  const directory = path.resolve(input.proceduresDir);
  const database = await createDatabase(input.dbPath);
  try {
    const [plan, git] = await Promise.all([
      prepareProcedureSync(directory, { files: localProcedureFiles, db: database }),
      readGitWorktreeStatus(directory),
    ]);
    return { plan, git };
  } finally {
    await database.close();
  }
}

/**
 * Writes a procedure document and synchronizes the directory into the database.
 *
 * Validation runs before the write; an invalid document throws without
 * touching disk. After writing, the full directory is planned. Execution only
 * runs when the plan contains no invalid files, mirroring CLI sync safety.
 *
 * @param input - Directory, contained relative path, YAML content, db path, and embedding port.
 * @returns Validation, plan, optional execution result, and worktree status.
 * @throws Error When the path escapes the directory or the content is invalid.
 */
export async function saveProcedureDocument(input: {
  proceduresDir: string;
  relativePath: string;
  content: string;
  dbPath: string;
  embedding: EmbeddingPort;
}): Promise<ProcedureSaveResult> {
  const { directory, absolutePath } = resolveContainedPath(input.proceduresDir, input.relativePath);
  const validation = validateProcedureContent(input.content, absolutePath);
  if (!validation.valid) {
    throw new Error(`Refusing to save invalid procedure: ${validation.error ?? "unknown validation error"}`);
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, ensureTrailingNewline(input.content), "utf-8");

  const database = await createDatabase(input.dbPath);
  try {
    const plan = await prepareProcedureSync(directory, { files: localProcedureFiles, db: database });
    const execution = plan.totals.invalid > 0 ? null : await executeProcedureSync(plan, { db: database, embedding: input.embedding });
    const git = await readGitWorktreeStatus(directory);
    return { validation, plan, execution, git };
  } finally {
    await database.close();
  }
}

/** Resolves a relative path inside the procedures directory and rejects traversal. */
function resolveContainedPath(proceduresDir: string, relativePath: string): { directory: string; absolutePath: string } {
  const directory = path.resolve(proceduresDir);
  const absolutePath = path.resolve(directory, relativePath);
  if (absolutePath !== directory && !absolutePath.startsWith(`${directory}${path.sep}`)) {
    throw new Error("Procedure path must stay within the configured procedures directory.");
  }

  if (!/\.ya?ml$/iu.test(absolutePath)) {
    throw new Error("Procedure files must use a .yaml or .yml extension.");
  }

  return { directory, absolutePath };
}

/** Ensures the written YAML ends with a single trailing newline. */
function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
