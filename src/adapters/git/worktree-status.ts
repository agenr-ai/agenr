import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Maximum buffer captured from a git invocation before it is treated as an error. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * One changed path reported by `git status --porcelain`.
 */
export interface GitChangedFile {
  /** Two-character porcelain status code, for example `" M"` or `"??"`. */
  status: string;
  /** Repository-relative path of the changed file. */
  path: string;
}

/**
 * Worktree status snapshot used to warn operators before procedure edits.
 */
export interface GitWorktreeStatus {
  /** True when the path resolves inside a git working tree. */
  isRepository: boolean;
  /** True when tracked or untracked changes are present. */
  isDirty: boolean;
  /** Current branch name, or `null` in detached-HEAD state. */
  branch: string | null;
  /** Changed paths reported by the porcelain status. */
  changedFiles: GitChangedFile[];
}

/**
 * Reads the git worktree status for a directory.
 *
 * The procedure editor writes repo files but never stages or commits, so the
 * console surfaces this status as a guardrail: operators see uncommitted work
 * before a sync mutates the same tree. A non-repository path returns a
 * well-typed "not a repository" result rather than throwing so the caller can
 * render a neutral state.
 *
 * @param directory - Absolute directory to inspect.
 * @returns Structured worktree status snapshot.
 */
export async function readGitWorktreeStatus(directory: string): Promise<GitWorktreeStatus> {
  const insideTree = await isInsideWorkTree(directory);
  if (!insideTree) {
    return { isRepository: false, isDirty: false, branch: null, changedFiles: [] };
  }

  const [branch, changedFiles] = await Promise.all([readBranch(directory), readChangedFiles(directory)]);

  return {
    isRepository: true,
    isDirty: changedFiles.length > 0,
    branch,
    changedFiles,
  };
}

/** Returns true when the directory is inside a git working tree. */
async function isInsideWorkTree(directory: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(["rev-parse", "--is-inside-work-tree"], directory);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Reads the current branch name, or null in detached-HEAD state. */
async function readBranch(directory: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], directory);
    const branch = stdout.trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/** Reads the porcelain changed-file list for the worktree. */
async function readChangedFiles(directory: string): Promise<GitChangedFile[]> {
  try {
    const { stdout } = await runGit(["status", "--porcelain"], directory);
    return stdout
      .split("\n")
      .map((line) => line.replace(/\r$/u, ""))
      .filter((line) => line.length > 0)
      .map((line) => ({
        status: line.slice(0, 2),
        path: line.slice(3).trim(),
      }));
  } catch {
    return [];
  }
}

/** Runs one git subcommand inside the requested directory. */
async function runGit(args: string[], directory: string): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: "utf-8",
  });
  return { stdout };
}
