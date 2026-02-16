import fs from "node:fs/promises";
import path from "node:path";
import type { SessionResolver } from "../session-resolver.js";
import { createMtimeResolver } from "./mtime.js";

interface OpenClawSessionRecord {
  sessionFile?: unknown;
  updatedAt?: unknown;
  spawnedBy?: unknown;
}

function parseUpdatedAt(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return 0;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  return parsed.getTime();
}

function isMainSession(record: OpenClawSessionRecord): boolean {
  return record.spawnedBy === undefined || record.spawnedBy === null || String(record.spawnedBy).trim().length === 0;
}

function toManifestEntries(payload: unknown): OpenClawSessionRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter((value): value is OpenClawSessionRecord => Boolean(value) && typeof value === "object");
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.sessions)) {
      return record.sessions.filter((value): value is OpenClawSessionRecord => Boolean(value) && typeof value === "object");
    }
  }

  return [];
}

async function hasReadableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

const fallbackResolver = createMtimeResolver("*.jsonl", {
  includeFile: (filePath) => filePath.toLowerCase().endsWith(".jsonl"),
});

export const openClawSessionResolver: SessionResolver = {
  filePattern: "*.jsonl",

  async resolveActiveSession(dir: string): Promise<string | null> {
    const resolvedDir = path.resolve(dir);
    const manifestPath = path.join(resolvedDir, "sessions.json");

    let rawManifest: string;
    try {
      rawManifest = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return fallbackResolver.resolveActiveSession(resolvedDir);
      }
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        throw new Error(`OpenClaw manifest is temporarily unavailable: ${manifestPath}`);
      }
      return fallbackResolver.resolveActiveSession(resolvedDir);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawManifest);
    } catch {
      return fallbackResolver.resolveActiveSession(resolvedDir);
    }

    const entries = toManifestEntries(parsed)
      .filter((entry) => isMainSession(entry) && typeof entry.sessionFile === "string" && entry.sessionFile.trim().length > 0)
      .sort((a, b) => parseUpdatedAt(b.updatedAt) - parseUpdatedAt(a.updatedAt));

    for (const entry of entries) {
      const sessionFile = entry.sessionFile as string;
      const candidatePath = path.isAbsolute(sessionFile)
        ? path.resolve(sessionFile)
        : path.resolve(resolvedDir, sessionFile);

      if (await hasReadableFile(candidatePath)) {
        return candidatePath;
      }
    }

    return fallbackResolver.resolveActiveSession(resolvedDir);
  },
};
