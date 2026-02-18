import fs from "node:fs/promises";
import path from "node:path";
import type { WatchPlatform } from "./index.js";
import { getResolver } from "./index.js";
import { getDefaultPlatformDir } from "../platform-defaults.js";

export interface AutoWatchTarget {
  dir: string;
  platform: WatchPlatform;
  recursive?: boolean;
}

export interface AutoSessionCandidate {
  platform: WatchPlatform;
  rootDir: string;
  activeFile: string | null;
  mtimeMs: number | null;
}

export interface AutoSessionResult {
  activeFile: string | null;
  platform: WatchPlatform | null;
  mtimeMs: number | null;
  candidates: AutoSessionCandidate[];
  discoveredRoots: AutoWatchTarget[];
  watchTargets: AutoWatchTarget[];
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function statMtime(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

export async function resolveAutoSession(): Promise<AutoSessionResult> {
  // Legacy helper retained for backwards compatibility. Multi-platform scanning is deprecated.
  const openclawDir = path.resolve(getDefaultPlatformDir("openclaw"));

  const discoveredRoots: AutoWatchTarget[] = [];
  const watchTargets: AutoWatchTarget[] = [];
  const candidates: AutoSessionCandidate[] = [];

  if (!(await isDirectory(openclawDir))) {
    return {
      activeFile: null,
      platform: null,
      mtimeMs: null,
      candidates,
      discoveredRoots,
      watchTargets,
    };
  }

  const root: AutoWatchTarget = { dir: openclawDir, platform: "openclaw" };
  discoveredRoots.push(root);
  watchTargets.push(root);

  const resolver = getResolver(root.platform, root.dir);
  const activeFile = await resolver.resolveActiveSession(root.dir);
  const resolvedActive = activeFile ? path.resolve(activeFile) : null;
  const mtimeMs = resolvedActive ? await statMtime(resolvedActive) : null;
  candidates.push({
    platform: root.platform,
    rootDir: root.dir,
    activeFile: resolvedActive,
    mtimeMs,
  });

  return {
    activeFile: resolvedActive,
    platform: "openclaw" as WatchPlatform,
    mtimeMs,
    candidates,
    discoveredRoots,
    watchTargets,
  };
}
