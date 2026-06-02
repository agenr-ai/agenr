import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Converts a plain filesystem path into an absolute `file:` URL.
 *
 * @param filePath - Plain local filesystem path.
 * @returns Absolute URL string suitable for local database clients.
 */
export function toAbsoluteFileUrl(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

/**
 * Resolves plain paths and local `file:` URLs into absolute filesystem paths.
 *
 * Relative `file:` URLs are supported because libSQL accepts them. The helper
 * resolves them against the current process directory for filesystem tasks such
 * as creating parent directories or deleting sidecar files.
 *
 * @param targetPath - Plain path, local `file:` URL, or `:memory:` database id.
 * @returns Absolute local filesystem path, or null for non-file targets.
 */
export function resolveLocalFilesystemPath(targetPath: string): string | null {
  const trimmedPath = targetPath.trim();
  if (trimmedPath.length === 0 || trimmedPath === ":memory:" || isInMemoryFileUrl(trimmedPath)) {
    return null;
  }

  if (trimmedPath.startsWith("file:")) {
    if (isAbsoluteFileUrl(trimmedPath)) {
      try {
        return fileURLToPath(trimmedPath);
      } catch {
        return null;
      }
    }

    const relativePath = decodeRelativeFileUrlPath(trimmedPath);
    return relativePath ? path.resolve(relativePath) : null;
  }

  return path.resolve(trimmedPath);
}

/**
 * Converts filesystem-style or `file:` URL config paths into usable disk paths.
 *
 * @param targetPath - Config path supplied by env, user input, or plugin config.
 * @returns Local filesystem path when resolvable, otherwise the original value.
 */
export function resolveConfigFilesystemPath(targetPath: string): string {
  return resolveLocalFilesystemPath(targetPath) ?? targetPath;
}

/** Checks whether a `file:` URL points at an absolute local path. */
function isAbsoluteFileUrl(targetPath: string): boolean {
  return /^file:(?:\/|[A-Za-z]:[\\/])/u.test(targetPath);
}

/** Checks whether a `file:` URL addresses an in-memory SQLite database. */
function isInMemoryFileUrl(targetPath: string): boolean {
  return targetPath === "file::memory:" || targetPath.startsWith("file::memory:?");
}

/** Extracts and decodes the path part of a relative `file:` URL. */
function decodeRelativeFileUrlPath(targetPath: string): string | null {
  const rawPath = targetPath.slice("file:".length).split(/[?#]/u, 1)[0]?.trim();
  if (!rawPath) {
    return null;
  }

  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}
