import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO_ROOT_SEGMENTS = ["tests", "scenarios", "claim-keys"] as const;

/**
 * Returns the default repo-local claim-key scenario root.
 *
 * @param options - Optional cwd and module URL overrides used by tests.
 * @returns Absolute path to the default scenario directory.
 */
export function getDefaultClaimKeyScenarioRoot(
  options: {
    cwd?: string;
    moduleUrl?: string;
  } = {},
): string {
  const moduleDirectory = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const startDirectories = Array.from(new Set([path.resolve(options.cwd ?? process.cwd()), moduleDirectory]));

  for (const startDirectory of startDirectories) {
    const discovered = findScenarioRootFrom(startDirectory);
    if (discovered) {
      return discovered;
    }
  }

  throw new Error(`Unable to locate ${SCENARIO_ROOT_SEGMENTS.join("/")} from cwd "${options.cwd ?? process.cwd()}" or module "${moduleDirectory}".`);
}

/**
 * Resolves one required relative fixture path and keeps it inside the scenario root.
 *
 * @param value - Raw fixture-path field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for path normalization.
 * @returns Root-relative normalized fixture path.
 */
export function readRelativeFixturePath(value: unknown, label: string, filePath: string, rootDir: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be a non-empty string.`);
  }

  return normalizeFixturePath(value.trim(), rootDir, filePath, label);
}

/**
 * Resolves one optional relative fixture path and keeps it inside the scenario root.
 *
 * @param value - Raw fixture-path field value.
 * @param label - Human-readable field label.
 * @param filePath - Source scenario path for error messages.
 * @param rootDir - Scenario root used for path normalization.
 * @returns Root-relative normalized fixture path when present.
 */
export function readOptionalRelativeFixturePath(value: unknown, label: string, filePath: string, rootDir: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRelativeFixturePath(value, label, filePath, rootDir);
}

/**
 * Normalizes one relative fixture path and rejects traversal outside the scenario root.
 *
 * @param relativePath - Raw relative path from the scenario file.
 * @param rootDir - Scenario root used for normalization.
 * @param filePath - Source scenario path for error messages.
 * @param label - Human-readable field label.
 * @returns Root-relative normalized path with forward slashes.
 */
export function normalizeFixturePath(relativePath: string, rootDir: string, filePath: string, label: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must be relative to the scenario root.`);
  }

  const resolved = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid scenario ${filePath}: ${label} must stay inside the scenario root.`);
  }

  return relative.split(path.sep).join("/");
}

/**
 * Walks upward from one start directory and returns the first repo-local scenario root that exists.
 *
 * @param startDirectory - Directory to begin searching from.
 * @returns Absolute scenario root path when found.
 */
function findScenarioRootFrom(startDirectory: string): string | undefined {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(currentDirectory, ...SCENARIO_ROOT_SEGMENTS);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}
