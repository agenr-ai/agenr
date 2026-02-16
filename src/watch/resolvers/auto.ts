import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WatchPlatform } from "./index.js";
import { getResolver } from "./index.js";

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

function resolveUserPath(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function findMostRecentSubdirectory(dirPath: string): Promise<string | null> {
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: { dirPath: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { dirPath: fullPath, mtimeMs: stat.mtimeMs };
    }
  }

  return best?.dirPath ?? null;
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
  const openclawDir = path.resolve(resolveUserPath("~/.openclaw/agents/main/sessions"));
  const claudeProjectsDir = path.resolve(resolveUserPath("~/.claude/projects"));
  const codexDir = path.resolve(resolveUserPath("~/.codex/sessions"));

  const discoveredRoots: AutoWatchTarget[] = [];
  const watchTargets: AutoWatchTarget[] = [];

  if (await isDirectory(openclawDir)) {
    discoveredRoots.push({ dir: openclawDir, platform: "openclaw" });
    watchTargets.push({ dir: openclawDir, platform: "openclaw" });
  }

  if (await isDirectory(claudeProjectsDir)) {
    watchTargets.push({ dir: claudeProjectsDir, platform: "claude-code" });
    const recentProject = await findMostRecentSubdirectory(claudeProjectsDir);
    if (recentProject) {
      discoveredRoots.push({ dir: recentProject, platform: "claude-code" });
      watchTargets.push({ dir: recentProject, platform: "claude-code", recursive: true });
    }
  }

  if (await isDirectory(codexDir)) {
    discoveredRoots.push({ dir: codexDir, platform: "codex" });
    watchTargets.push({ dir: codexDir, platform: "codex", recursive: true });
  }

  const candidates: AutoSessionCandidate[] = [];
  for (const root of discoveredRoots) {
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
  }

  const winningCandidate = candidates
    .filter((candidate) => candidate.activeFile && candidate.mtimeMs !== null)
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0];

  return {
    activeFile: winningCandidate?.activeFile ?? null,
    platform: winningCandidate?.platform ?? null,
    mtimeMs: winningCandidate?.mtimeMs ?? null,
    candidates,
    discoveredRoots,
    watchTargets,
  };
}
