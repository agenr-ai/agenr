import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

/**
 * Maps file extensions to response content types for SPA assets.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serves built single-page-application assets from a directory.
 *
 * Resolves requested paths inside the SPA root, guards against path traversal,
 * and falls back to `index.html` for client-side routes so deep links load.
 */
export class StaticAssetServer {
  /**
   * Creates a static asset server rooted at a built SPA directory.
   *
   * @param rootDir - Absolute path to the built SPA assets.
   */
  public constructor(private readonly rootDir: string) {}

  /**
   * Serves a static asset or the SPA shell for a request path.
   *
   * @param pathname - Request path to resolve.
   * @param response - HTTP response to write to.
   * @returns True when a response was written, false when the root is missing.
   */
  public async serve(pathname: string, response: ServerResponse): Promise<boolean> {
    const resolved = this.resolve(pathname);
    if (resolved && (await isFile(resolved))) {
      this.streamFile(resolved, response);
      return true;
    }

    const shell = path.join(this.rootDir, "index.html");
    if (await isFile(shell)) {
      this.streamFile(shell, response);
      return true;
    }

    return false;
  }

  /**
   * Resolves a request path to a contained absolute file path.
   *
   * @param pathname - Request path to resolve.
   * @returns Absolute path inside the root, or null when traversal is detected.
   */
  private resolve(pathname: string): string | null {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = path.resolve(this.rootDir, relative);
    const rootWithSep = this.rootDir.endsWith(path.sep) ? this.rootDir : `${this.rootDir}${path.sep}`;
    if (candidate !== this.rootDir && !candidate.startsWith(rootWithSep)) {
      return null;
    }

    return candidate;
  }

  /** Streams a file with a derived content type and long-lived cache hints. */
  private streamFile(filePath: string, response: ServerResponse): void {
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const isHashedAsset = /\.[0-9a-f]{8,}\./i.test(path.basename(filePath));
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(filePath).pipe(response);
  }
}

/** Returns true when a path exists and is a regular file. */
async function isFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}
