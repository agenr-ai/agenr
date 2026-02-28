import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import {
  DEFAULT_TASK_MODEL,
  describeAuth,
  mergeConfigPatch,
  readConfig,
  resolveConfigPath,
  resolveProjectFromGlobalConfig,
  writeConfig,
} from "../config.js";
import { runConsolidateCommand } from "./consolidate.js";
import { runWatcherInstallCommand, runWatcherStopCommand } from "./watcher.js";
import { runDbResetCommand } from "./db.js";
import { runIngestCommand, type IngestCommandResult } from "./ingest.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { formatExistingConfig, modelChoicesForAuth, modelHintForChoice, runSetupCore } from "../setup.js";
import type { AgenrConfig, AgenrProvider } from "../types.js";
import { banner, formatLabel } from "../ui.js";
import {
  estimateIngestCost,
  formatCostUsd,
  formatTokenCount,
} from "./init/cost-estimator.js";
import {
  detectPlatforms,
  isDefaultOpenClawPath,
  resolveDefaultCodexConfigDir,
  resolveDefaultOpenClawConfigDir,
} from "./init/platform-detector.js";
import { scanSessionFiles } from "./init/session-scanner.js";
import type { DetectedPlatform } from "./init/platform-detector.js";


/**
 * Resolve the OpenClaw config subdirectory.
 * Default OpenClaw installs use ~/.openclaw as OPENCLAW_HOME where the directory itself
 * is the .openclaw dir. Custom OPENCLAW_HOME paths get a .openclaw subdir added by
 * OpenClaw automatically.
 */
function resolveOpenClawConfigSubdir(openclawDir: string): string {
  if (path.basename(openclawDir) === ".openclaw") {
    return openclawDir;
  }
  return path.join(openclawDir, ".openclaw");
}

/** Run a command asynchronously so spinners can animate. Captures all stdio. */
function execAsync(
  cmd: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; env: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      options,
      (error: Error | null, stdout: string | Buffer) => {
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
  });
}


function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function logInitDebug(message: string): void {
  if (process.env.AGENR_DEBUG === "1") {
    console.debug(`[agenr init] ${message}`);
  }
}

export function resolveAgenrCommand(): { command: string; baseArgs: string[] } {
  const agenrShim = findBinaryPath("agenr");
  if (agenrShim) {
    return {
      command: agenrShim,
      baseArgs: [],
    };
  }

  logInitDebug(
    "agenr binary not found on PATH; falling back to process.execPath + process.argv[1], which may pin MCP config to the current installed version.",
  );

  const nodeBin = process.execPath;
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Could not resolve agenr CLI script path from process.argv[1].");
  }
  return {
    command: nodeBin,
    baseArgs: [scriptPath],
  };
}

const AGENR_START_MARKER = "<!-- agenr:start -->";
const AGENR_END_MARKER = "<!-- agenr:end -->";

const PLATFORM_VALUES = ["claude-code", "cursor", "openclaw", "windsurf", "codex", "generic"] as const;
export type InitPlatform = (typeof PLATFORM_VALUES)[number];

export interface InitCommandOptions {
  platform?: string;
  project?: string;
  path?: string;
  dependsOn?: string;
  openclawDbPath?: string;
}

export interface WizardOptions {
  isInteractive: boolean;
  platform?: string;
  project?: string;
  path?: string;
  dependsOn?: string;
}

export interface WizardChanges {
  authChanged: boolean;
  modelChanged: boolean;
  modelsChanged: boolean;
  platformChanged: boolean;
  projectChanged: boolean;
  embeddingsKeyChanged: boolean;
  directoryChanged: boolean;
  dbPathChanged: boolean;
  openclawDbPath?: string;
  previousModel: string | undefined;
  newModel: string | undefined;
}

export interface InitCommandResult {
  platform: InitPlatform;
  project: string;
  projectDir: string;
  dependencies: string[];
  configPath: string;
  instructionsPath: string | null;
  mcpPath: string;
  mcpSkipped: boolean;
  gitignoreUpdated: boolean;
}

interface InitConfigFile {
  project?: string;
  platform?: InitPlatform;
  projectDir?: string;
  dependencies?: string[];
  [key: string]: unknown;
}

interface ExistingProjectSettings {
  platform?: InitPlatform;
  project?: string;
}

interface WizardSummary {
  platform: string;
  directory?: string;
  database?: string;
  configPath: string;
  project: string;
  authLabel: string;
  model: string;
  taskModels?: AgenrConfig["models"];
  pluginStatus?: string;
  ingestStatus?: string;
  consolidateStatus?: string;
  watcherStatus?: string;
}

type JsonRecord = Record<string, unknown>;
type GlobalProjectEntry = {
  project: string;
  platform: string;
  dbPath?: string;
  dependencies?: string[];
};
type TaskModelKey = "extraction" | "claimExtraction" | "contradictionJudge" | "handoffSummary";
type TaskModelRecord = Record<TaskModelKey, string>;

interface TaskModelDefinition {
  key: TaskModelKey;
  name: string;
  description: string;
}

const TASK_MODEL_DEFINITIONS: TaskModelDefinition[] = [
  {
    key: "extraction",
    name: "Extraction",
    description: "Knowledge extraction from text",
  },
  {
    key: "claimExtraction",
    name: "Claim extraction",
    description: "Structured claim extraction (subject/predicate/object)",
  },
  {
    key: "contradictionJudge",
    name: "Contradiction judge",
    description: "Conflict detection between entries",
  },
  {
    key: "handoffSummary",
    name: "Handoff summary",
    description: "Session handoff summarization",
  },
];

interface TaskModelPromptResult {
  cancelled: boolean;
  models: AgenrConfig["models"] | undefined;
  changed: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSlugList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((part) => normalizeSlug(part.trim()))
        .filter((part) => part.length > 0),
    ),
  );
}

function isPlatform(value: string): value is InitPlatform {
  return PLATFORM_VALUES.includes(value as InitPlatform);
}

function buildSystemPromptBlock(_projectSlug: string): string {
  return [
    "You have access to agenr_recall for persistent memory across sessions.",
    "",
    'On session start, call agenr_recall with context="session-start" to load prior knowledge for this project. Mid-session, call agenr_recall with a query when you need context you do not have.',
    "",
    "Do NOT call agenr_store. That tool has been removed. Your session transcript is automatically ingested by the Watcher, which extracts valuable knowledge after the session ends. Focus on your task - the memory system captures insights for you.",
  ].join("\n");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function detectPlatform(projectDir: string): Promise<InitPlatform> {
  if (await isDirectory(path.join(projectDir, ".claude"))) {
    return "claude-code";
  }
  if (await isDirectory(path.join(projectDir, ".cursor"))) {
    return "cursor";
  }
  if (await pathExists(path.join(projectDir, ".windsurfrules"))) {
    return "windsurf";
  }
  return "generic";
}

async function resolveInstructionsPath(projectDir: string, platform: InitPlatform): Promise<string | null> {
  if (platform === "claude-code") {
    return path.join(os.homedir(), ".claude", "CLAUDE.md");
  }
  if (platform === "cursor") {
    const legacyPath = path.join(projectDir, ".cursorrules");
    if (await pathExists(legacyPath)) {
      return legacyPath;
    }
    return path.join(projectDir, ".cursor", "rules", "agenr.mdc");
  }
  if (platform === "windsurf") {
    return path.join(os.homedir(), ".codeium", "windsurf", "memories", "global_rules.md");
  }
  if (platform === "codex") {
    return path.join(os.homedir(), ".codex", "AGENTS.md");
  }
  if (platform === "openclaw") {
    return null;
  }
  return path.join(projectDir, "AGENTS.md");
}

function withMarkers(promptBlock: string): string {
  return `${AGENR_START_MARKER}\n${promptBlock}\n${AGENR_END_MARKER}\n`;
}

async function upsertPromptBlock(filePath: string, promptBlock: string): Promise<void> {
  const marked = withMarkers(promptBlock);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const start = existing.indexOf(AGENR_START_MARKER);
  const end = existing.indexOf(AGENR_END_MARKER);

  let next: string;
  if (start !== -1 && end !== -1 && end >= start) {
    const afterEnd = end + AGENR_END_MARKER.length;
    next = `${existing.slice(0, start)}${marked}${existing.slice(afterEnd).replace(/^\n?/, "\n")}`;
  } else if (existing.trim().length === 0) {
    next = marked;
  } else {
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    next = `${existing}${separator}${marked}`;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next, "utf8");
}

async function readJsonRecord(filePath: string): Promise<JsonRecord | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(`Expected JSON object in ${filePath}`);
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: JsonRecord): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeAgenrConfig(
  projectDir: string,
  project: string,
  platform: InitPlatform,
  dependencies: string[] | undefined,
  dbPath: string | undefined,
): Promise<{ configPath: string; config: InitConfigFile }> {
  if (platform === "openclaw" || platform === "codex") {
    return await writeGlobalProjectEntry(project, platform, projectDir, dependencies, dbPath);
  }

  const configDir = path.join(projectDir, ".agenr");
  const configPath = path.join(configDir, "config.json");
  const existing = (await readJsonRecord(configPath)) ?? {};
  const next: InitConfigFile = { ...existing };

  next.project = project;
  next.platform = platform;
  next.projectDir = projectDir;
  if (dependencies !== undefined) {
    const currentDeps = Array.isArray(next.dependencies)
      ? next.dependencies.filter((value): value is string => typeof value === "string")
      : [];
    const merged = Array.from(new Set([...currentDeps, ...dependencies]));
    next.dependencies = merged;
  }

  await fs.mkdir(configDir, { recursive: true });
  await writeJsonFile(configPath, next as JsonRecord);
  return { configPath, config: next };
}

async function writeGlobalProjectEntry(
  project: string,
  platform: InitPlatform,
  projectDir: string,
  dependencies: string[] | undefined,
  dbPath: string | undefined,
): Promise<{ configPath: string; config: InitConfigFile }> {
  const existingConfig = readConfig(process.env) ?? {};
  const projects: NonNullable<AgenrConfig["projects"]> = {
    ...(existingConfig.projects ?? {}),
  };
  const resolvedDir = path.resolve(projectDir);
  const existingEntry = projects[resolvedDir];

  const currentDependencies = Array.isArray(existingEntry?.dependencies)
    ? existingEntry.dependencies.filter((value): value is string => typeof value === "string")
    : [];

  let nextDependencies: string[] | undefined;
  if (dependencies !== undefined) {
    nextDependencies = Array.from(new Set([...currentDependencies, ...dependencies]));
  } else if (currentDependencies.length > 0) {
    nextDependencies = currentDependencies;
  }

  projects[resolvedDir] = {
    project,
    platform,
    ...(nextDependencies && nextDependencies.length > 0 ? { dependencies: nextDependencies } : {}),
    ...(dbPath ? { dbPath } : {}),
  };

  const nextConfig: AgenrConfig = {
    ...existingConfig,
    projects,
  };
  writeConfig(nextConfig, process.env);

  return {
    configPath: resolveConfigPath(process.env),
    config: {
      project,
      platform,
      projectDir: resolvedDir,
      ...(nextDependencies && nextDependencies.length > 0 ? { dependencies: nextDependencies } : {}),
      ...(dbPath ? { dbPath } : {}),
    },
  };
}

export function buildMcpEntry(
  projectDir: string,
  resolved: { command: string; baseArgs: string[] },
): JsonRecord {
  return {
    command: resolved.command,
    args: [...resolved.baseArgs, "mcp"],
    env: {
      AGENR_PROJECT_DIR: projectDir,
    },
  };
}

function mergeMcpConfig(existing: JsonRecord, entry: JsonRecord): JsonRecord {
  const maybeServers = existing.mcpServers;
  if (isRecord(maybeServers)) {
    return {
      ...existing,
      mcpServers: {
        ...maybeServers,
        agenr: entry,
      },
    };
  }

  const { mcpServers: _ignoredMcpServers, agenr: _ignoredLegacyAgenr, ...rest } = existing;
  return {
    ...rest,
    mcpServers: {
      agenr: entry,
    },
  };
}

async function writeMcpConfig(
  projectDir: string,
  platform: InitPlatform,
): Promise<{ mcpPath: string; skipped: boolean }> {
  const resolved = resolveAgenrCommand();
  if (platform === "codex") {
    const mcpPath = await writeCodexConfig(projectDir, resolved);
    return { mcpPath, skipped: false };
  }

  if (platform === "openclaw") {
    // OpenClaw does not use .mcp.json. The native plugin is installed separately
    // via `openclaw plugins install agenr` and handles MCP registration itself.
    return { mcpPath: "", skipped: true };
  }

  const mcpPath =
    platform === "cursor"
      ? path.join(projectDir, ".cursor", "mcp.json")
      : path.join(projectDir, ".mcp.json");

  const existing = (await readJsonRecord(mcpPath)) ?? {};
  const next = mergeMcpConfig(existing, buildMcpEntry(projectDir, resolved));
  await writeJsonFile(mcpPath, next);
  return { mcpPath, skipped: false };
}

function isPathInsideProject(projectDir: string, targetPath: string): boolean {
  const relative = path.relative(projectDir, targetPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function addGitignoreEntries(projectDir: string, entries: string[]): Promise<boolean> {
  const gitignorePath = path.join(projectDir, ".gitignore");
  const normalizedEntries = Array.from(new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0)));
  if (normalizedEntries.length === 0) {
    return false;
  }

  const exists = await pathExists(gitignorePath);
  if (!exists) {
    const content = normalizedEntries.map((entry) => `${entry}\n`).join("");
    await fs.writeFile(gitignorePath, content, "utf8");
    return true;
  }

  const existing = await fs.readFile(gitignorePath, "utf8");
  const lines = existing.split(/\r?\n/);
  const missing = normalizedEntries.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const appended = missing.map((entry) => `${entry}\n`).join("");
  await fs.writeFile(gitignorePath, `${existing}${prefix}${appended}`, "utf8");
  return true;
}

export function resolveProjectSlug(projectDir: string, explicitProject?: string): string {
  const source = explicitProject?.trim() || path.basename(projectDir);
  const slug = normalizeSlug(source);
  if (!slug) {
    throw new Error("Could not derive project slug. Pass --project <slug>.");
  }
  return slug;
}

async function writeCodexConfig(
  projectDir: string,
  resolved: { command: string; baseArgs: string[] },
): Promise<string> {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const escapedBin = escapeTomlString(resolved.command);
  const args = [...resolved.baseArgs, "mcp"].map((value) => `"${escapeTomlString(value)}"`).join(", ");
  const escapedProjectDir = escapeTomlString(projectDir);
  const newLine = `agenr = { command = "${escapedBin}", args = [${args}], env = { AGENR_PROJECT_DIR = "${escapedProjectDir}" } }`;

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  let next: string;

  if (existing.trim().length === 0) {
    next = `[mcp]\n${newLine}\n`;
  } else {
    const lines = existing.split("\n");
    const mcpSectionIdx = lines.findIndex((l) => l.trim() === "[mcp]");
    if (mcpSectionIdx !== -1) {
      let mcpSectionEnd = lines.length;
      for (let i = mcpSectionIdx + 1; i < lines.length; i += 1) {
        if (/^\s*\[/.test(lines[i] ?? "")) {
          mcpSectionEnd = i;
          break;
        }
      }

      const relativeAgenrIdx = lines
        .slice(mcpSectionIdx + 1, mcpSectionEnd)
        .findIndex((l) => l.trimStart().startsWith("agenr ="));

      if (relativeAgenrIdx !== -1) {
        // Replace existing agenr line in place (idempotent)
        const agenrLineIdx = mcpSectionIdx + 1 + relativeAgenrIdx;
        lines[agenrLineIdx] = newLine;
      } else {
        // Insert after [mcp] line
        lines.splice(mcpSectionIdx + 1, 0, newLine);
      }
      next = lines.join("\n");
    } else {
      // Append [mcp] block at end
      const suffix = existing.endsWith("\n") ? "" : "\n";
      next = `${existing}${suffix}\n[mcp]\n${newLine}\n`;
    }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, next, "utf8");
  return configPath;
}

export function formatInitSummary(result: InitCommandResult): string[] {
  const dependencyLabel = result.dependencies.length > 0 ? `[${result.dependencies.join(",")}]` : "[]";
  const configPath =
    result.platform === "openclaw" || result.platform === "codex"
      ? formatPathForDisplay(result.configPath)
      : path.relative(result.projectDir, result.configPath) || path.basename(result.configPath);
  const lines = [
    `agenr init: platform=${result.platform} project=${result.project} dependencies=${dependencyLabel}`,
    `- Wrote config to ${configPath}`,
    result.platform === "codex"
      ? "- Wrote MCP entry to ~/.codex/config.toml"
      : result.mcpSkipped
        ? "- MCP: handled by OpenClaw native plugin (openclaw plugins install agenr)"
        : `- Wrote MCP config to ${path.relative(result.projectDir, result.mcpPath) || path.basename(result.mcpPath)}`,
  ];
  if (result.instructionsPath !== null) {
    lines.splice(2, 0, `- Wrote system prompt block to ${formatPathForDisplay(result.instructionsPath)}`);
  } else {
    lines.splice(2, 0, `- Memory injection: handled automatically by ${result.platform} plugin (no instructions file needed)`);
  }
  if (result.gitignoreUpdated) {
    lines.push("- Added .agenr/knowledge.db to .gitignore");
  }
  return lines;
}

export function formatPathForDisplay(filePath: string): string {
  const home = os.homedir();
  if (filePath === home) {
    return "~";
  }
  const homePrefix = `${home}${path.sep}`;
  return filePath.startsWith(homePrefix) ? `~${filePath.slice(home.length)}` : filePath;
}

function resolveInputPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Input path is empty.");
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function resolveSharedKnowledgeDbPath(): string {
  return path.join(os.homedir(), ".agenr", "knowledge.db");
}

function isWizardPlatformId(value: string): value is DetectedPlatform["id"] {
  return value === "openclaw" || value === "codex";
}

function resolveEmbeddingKeyOrNull(config: ReturnType<typeof readConfig>, env: NodeJS.ProcessEnv): string | null {
  if (!config) {
    return null;
  }
  try {
    return resolveEmbeddingApiKey(config, env);
  } catch {
    return null;
  }
}

function formatPlatformLabel(platform: InitPlatform | DetectedPlatform["id"]): string {
  if (platform === "openclaw") {
    return "OpenClaw";
  }
  if (platform === "codex") {
    return "Codex";
  }
  return platform;
}

export function resolveWizardProjectSlug(projectDir: string, platformId: string): string {
  if (platformId === "openclaw" || platformId === "codex") {
    return platformId;
  }
  return resolveProjectSlug(projectDir);
}

export function resolveWizardProjectDir(projectDir: string, platformId: string, platformConfigDir: string): string {
  if (platformId === "openclaw" || platformId === "codex") {
    return platformConfigDir;
  }
  return projectDir;
}

async function readExistingProjectSettings(projectDir: string): Promise<ExistingProjectSettings> {
  const globalProject = resolveProjectFromGlobalConfig(projectDir, process.env);
  if (globalProject) {
    return {
      project: globalProject.slug,
      platform: isPlatform(globalProject.platform) ? globalProject.platform : undefined,
    };
  }

  const configPath = path.join(projectDir, ".agenr", "config.json");
  const config = await readJsonRecord(configPath);
  if (!config) {
    return {};
  }

  const next: ExistingProjectSettings = {};
  if (typeof config.project === "string" && config.project.trim().length > 0) {
    next.project = config.project.trim();
  }
  if (typeof config.platform === "string" && isPlatform(config.platform)) {
    next.platform = config.platform;
  }
  return next;
}

async function promptPlatformSelector(platforms: DetectedPlatform[]): Promise<DetectedPlatform | null> {
  const selectedId = await clack.select<DetectedPlatform["id"]>({
    message: "Which platform are you using?",
    options: platforms.map((platform) => ({
      value: platform.id,
      label: platform.label,
      hint: platform.detected ? `detected at ${platform.configDir}` : undefined,
    })),
  });

  if (clack.isCancel(selectedId)) {
    return null;
  }

  return platforms.find((platform) => platform.id === selectedId) ?? null;
}

async function choosePlatform(platforms: DetectedPlatform[]): Promise<DetectedPlatform | null> {
  const detected = platforms.filter((platform) => platform.detected);

  if (detected.length === 1) {
    const detectedPlatform = detected[0];
    const useDetected = await clack.confirm({
      message: `Detected ${detectedPlatform.label} at ${detectedPlatform.configDir}. Use this platform?`,
      initialValue: true,
    });

    if (clack.isCancel(useDetected)) {
      return null;
    }

    if (useDetected) {
      return detectedPlatform;
    }
    return await promptPlatformSelector(platforms);
  }

  if (detected.length > 1) {
    return await promptPlatformSelector(detected);
  }

  clack.log.info("No known platform config detected. More platforms coming soon.");
  return await promptPlatformSelector(platforms);
}

interface PluginInstallResult {
  success: boolean;
  message: string;
}

function findBinaryPath(name: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, [name], { encoding: "utf8" }).trim().split("\n")[0];
    return result || null;
  } catch {
    return null;
  }
}

async function installOpenClawPlugin(
  openclawConfigDir: string,
): Promise<PluginInstallResult> {
  // Let OpenClaw resolve its own config path - don't override OPENCLAW_HOME.
  const env = { ...process.env };
  const openclawBin = findBinaryPath("openclaw");
  if (!openclawBin) {
    return {
      success: false,
      message:
        "openclaw not found on PATH. Install it first, then run:\n" +
        "  openclaw plugins install agenr",
    };
  }

  // Check if the plugin is actually installed on disk (not just in config).
  const installedPluginPath = path.join(
    resolveOpenClawConfigSubdir(openclawConfigDir),
    "extensions", "agenr", "dist", "openclaw-plugin", "index.js",
  );
  try {
    await fs.stat(installedPluginPath);
    return { success: true, message: "agenr plugin already installed" };
  } catch {
    // Not installed on disk - continue.
  }

  // If a local dev path already loads agenr, skip npm install to avoid duplicates.
  try {
    const loadCheckPath = path.join(resolveOpenClawConfigSubdir(openclawConfigDir), "openclaw.json");
    const loadCheckRaw = await fs.readFile(loadCheckPath, "utf8");
    const loadCheckParsed = JSON.parse(loadCheckRaw) as unknown;
    if (isRecord(loadCheckParsed) && isRecord(loadCheckParsed.plugins) && isRecord(loadCheckParsed.plugins.load)) {
      const loadPaths = loadCheckParsed.plugins.load.paths;
      if (Array.isArray(loadPaths) && loadPaths.some((p: unknown) => typeof p === "string" && String(p).includes("agenr"))) {
        return { success: true, message: "agenr loaded via local path (skipped npm install)" };
      }
    }
  } catch {
    // Continue with install.
  }

  try {
    await execAsync(openclawBin, ["plugins", "install", "agenr"], {
      encoding: "utf8",
      timeout: 60000,
      env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already exists")) {
      try {
        await execAsync(openclawBin, ["plugins", "update", "agenr"], {
          encoding: "utf8",
          timeout: 60000,
          env,
        });
      } catch {
        return {
          success: false,
          message:
            "Plugin exists but update failed. Try manually:\n" +
            "  openclaw plugins uninstall agenr && openclaw plugins install agenr",
        };
      }
    } else {
      return {
        success: false,
        message: `Plugin install failed: ${message}`,
      };
    }
  }

  return { success: true, message: "Plugin installed" };
}

async function writeOpenClawPluginDbPath(
  openclawConfigDir: string,
  dbPath: string | undefined,
): Promise<void> {
  const configDir = resolveOpenClawConfigSubdir(openclawConfigDir);
  const configPath = path.join(configDir, "openclaw.json");
  let config: JsonRecord = {};

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      config = parsed;
    }
  } catch {
    // Missing or invalid file - start with empty object.
  }

  if (!isRecord(config.plugins)) {
    config.plugins = {};
  }
  const plugins = config.plugins as JsonRecord;
  if (!Array.isArray(plugins.allow)) {
    plugins.allow = [];
  }
  const allow = plugins.allow as string[];
  if (!allow.includes("agenr")) {
    allow.push("agenr");
  }
  if (!isRecord(plugins.entries)) {
    plugins.entries = {};
  }
  const entries = plugins.entries as JsonRecord;
  if (!isRecord(entries.agenr)) {
    entries.agenr = { enabled: true };
  }
  const agenr = entries.agenr as JsonRecord;
  if (!isRecord(agenr.config)) {
    agenr.config = {};
  }
  const agenrConfig = agenr.config as JsonRecord;
  if (dbPath) {
    agenrConfig.dbPath = dbPath;
  } else {
    delete agenrConfig.dbPath;
  }

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

function normalizeTaskModels(models: Partial<AgenrConfig["models"]> | undefined): AgenrConfig["models"] | undefined {
  if (!models) {
    return undefined;
  }

  const normalized: NonNullable<AgenrConfig["models"]> = {
    extraction: DEFAULT_TASK_MODEL,
    claimExtraction: DEFAULT_TASK_MODEL,
    contradictionJudge: DEFAULT_TASK_MODEL,
    handoffSummary: DEFAULT_TASK_MODEL,
  };

  for (const task of TASK_MODEL_DEFINITIONS) {
    const value = models[task.key];
    if (typeof value === "string" && value.trim().length > 0) {
      normalized[task.key] = value.trim();
    }
  }

  return normalized;
}

export function resolveTaskModelDefaults(baseModel: string | undefined): TaskModelRecord {
  const model = baseModel?.trim() || DEFAULT_TASK_MODEL;
  return {
    extraction: model,
    claimExtraction: model,
    contradictionJudge: model,
    handoffSummary: model,
  };
}

function resolveTaskModelCurrentValues(
  baseModel: string | undefined,
  models: AgenrConfig["models"],
): TaskModelRecord {
  const defaults = resolveTaskModelDefaults(baseModel);
  const normalizedModels = normalizeTaskModels(models);
  return {
    extraction: normalizedModels?.extraction || defaults.extraction,
    claimExtraction: normalizedModels?.claimExtraction || defaults.claimExtraction,
    contradictionJudge: normalizedModels?.contradictionJudge || defaults.contradictionJudge,
    handoffSummary: normalizedModels?.handoffSummary || defaults.handoffSummary,
  };
}

function taskModelsEqual(a: AgenrConfig["models"], b: AgenrConfig["models"]): boolean {
  const normalizedA = normalizeTaskModels(a);
  const normalizedB = normalizeTaskModels(b);
  for (const task of TASK_MODEL_DEFINITIONS) {
    if (normalizedA?.[task.key] !== normalizedB?.[task.key]) {
      return false;
    }
  }
  return true;
}

function toTaskModels(selected: TaskModelRecord): AgenrConfig["models"] {
  const models: NonNullable<AgenrConfig["models"]> = {
    extraction: DEFAULT_TASK_MODEL,
    claimExtraction: DEFAULT_TASK_MODEL,
    contradictionJudge: DEFAULT_TASK_MODEL,
    handoffSummary: DEFAULT_TASK_MODEL,
  };
  for (const task of TASK_MODEL_DEFINITIONS) {
    const value = selected[task.key].trim();
    if (value) {
      models[task.key] = value;
    }
  }
  return models;
}

async function promptTaskModelOverrides(
  baseModel: string | undefined,
  existingModels: AgenrConfig["models"],
): Promise<TaskModelPromptResult> {
  const currentModels = normalizeTaskModels(existingModels);
  const fallbackModels = resolveTaskModelDefaults(baseModel);
  const configureSelection = await clack.select<"no" | "yes">({
    message: "Configure per-task models? (Advanced)",
    options: [
      {
        value: "no",
        label: currentModels ? "No, keep current task models" : `No, use ${fallbackModels.extraction} for extraction`,
      },
      {
        value: "yes",
        label: "Yes, customize per-task models",
      },
    ],
  });

  if (clack.isCancel(configureSelection)) {
    return {
      cancelled: true,
      models: currentModels,
      changed: false,
    };
  }

  if (configureSelection === "no") {
    const nextModels = currentModels ?? fallbackModels;
    return {
      cancelled: false,
      models: nextModels,
      changed: !taskModelsEqual(currentModels, nextModels),
    };
  }

  const current = resolveTaskModelCurrentValues(baseModel, currentModels);
  clack.note(
    TASK_MODEL_DEFINITIONS.map((task) => `${task.name}: ${current[task.key]} - ${task.description}`).join("\n"),
    "Per-task model defaults",
  );

  const selected: TaskModelRecord = { ...current };
  for (const task of TASK_MODEL_DEFINITIONS) {
    const changeAction = await clack.select<"keep" | "change">({
      message: `${task.name}: ${selected[task.key]} - Keep / Change`,
      options: [
        { value: "keep", label: "Keep" },
        { value: "change", label: "Change" },
      ],
    });

    if (clack.isCancel(changeAction)) {
      return {
        cancelled: true,
        models: currentModels,
        changed: false,
      };
    }

    if (changeAction === "keep") {
      continue;
    }

    const changedModel = await clack.text({
      message: `New model for ${task.name}:`,
      initialValue: selected[task.key],
      validate: (value) => {
        if (!value.trim()) {
          return "Model is required";
        }
        return undefined;
      },
    });

    if (clack.isCancel(changedModel)) {
      return {
        cancelled: true,
        models: currentModels,
        changed: false,
      };
    }

    selected[task.key] = changedModel.trim();
  }

  const nextModels = toTaskModels(selected);
  return {
    cancelled: false,
    models: nextModels,
    changed: !taskModelsEqual(currentModels, nextModels),
  };
}

function formatTaskModelsForSummary(models: AgenrConfig["models"] | undefined): string[] {
  const normalized = normalizeTaskModels(models);
  if (!normalized) {
    return [];
  }

  const lines: string[] = ["  Per-task models:"];
  for (const task of TASK_MODEL_DEFINITIONS) {
    const value = normalized[task.key];
    if (!value) {
      continue;
    }
    lines.push(`    ${task.name}: ${value}`);
  }
  return lines;
}

function formatWizardSummary(result: WizardSummary): string {
  const taskModelLines = formatTaskModelsForSummary(result.taskModels);
  const hasActions = result.pluginStatus || result.ingestStatus || result.watcherStatus;
  if (hasActions) {
    const lines = [`  Platform:     ${result.platform}`];
    if (result.directory) {
      lines.push(`  Directory:    ${result.directory}`);
    }
    if (result.database) {
      lines.push(`  Database:     ${result.database}`);
    }
    lines.push(`  Config:       ${result.configPath}`);
    lines.push(`  Project:      ${result.project}`);
    lines.push(`  Auth:         ${result.authLabel}`);
    lines.push(`  Model:        ${result.model}`);
    lines.push(...taskModelLines);
    if (result.pluginStatus) {
      lines.push(`  Plugin:       ${result.pluginStatus}`);
    }
    if (result.ingestStatus) {
      lines.push(`  Ingest:       ${result.ingestStatus}`);
    }
    if (result.consolidateStatus) {
      lines.push(`  Consolidate:  ${result.consolidateStatus}`);
    }
    if (result.watcherStatus) {
      lines.push(`  Watcher:      ${result.watcherStatus}`);
    }
    return lines.join("\n");
  }

  const lines = [`  Platform:  ${result.platform}`];
  if (result.directory) {
    lines.push(`  Directory: ${result.directory}`);
  }
  if (result.database) {
    lines.push(`  Database:  ${result.database}`);
  }
  lines.push(`  Config:    ${result.configPath}`);
  lines.push(`  Project:   ${result.project}`);
  lines.push(`  Auth:      ${result.authLabel}`);
  lines.push(`  Model:     ${result.model}`);
  lines.push(...taskModelLines);
  return lines.join("\n");
}

function getGlobalProjectMap(config: AgenrConfig | null | undefined): Record<string, GlobalProjectEntry> {
  if (!config?.projects) {
    return {};
  }

  const out: Record<string, GlobalProjectEntry> = {};
  for (const [dirKey, entry] of Object.entries(config.projects)) {
    out[dirKey] = {
      project: entry.project,
      platform: entry.platform,
      ...(entry.dbPath ? { dbPath: entry.dbPath } : {}),
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
    };
  }
  return out;
}

function formatRegisteredProjects(
  projects: Record<string, GlobalProjectEntry>,
  defaultDbPath: string,
): string {
  const entries = Object.entries(projects).sort(([, a], [, b]) => a.project.localeCompare(b.project));
  if (entries.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const [dirKey, entry] of entries) {
    const dbDisplay = entry.dbPath
      ? `${formatPathForDisplay(entry.dbPath)} (isolated)`
      : `${formatPathForDisplay(defaultDbPath)} (shared)`;

    lines.push(`  ${entry.project}`);
    lines.push(`    Directory: ${formatPathForDisplay(dirKey)}`);
    lines.push(`    Database:  ${dbDisplay}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatWizardChanges(changes: WizardChanges): string {
  const items: string[] = [];

  if (changes.authChanged) {
    items.push("Auth method updated");
  }
  if (changes.modelChanged) {
    const previousModel = changes.previousModel ?? "(not set)";
    const newModel = changes.newModel ?? "(not set)";
    items.push(`Model changed: ${previousModel} -> ${newModel}`);
  }
  if (changes.modelsChanged) {
    items.push("Per-task model overrides updated");
  }
  if (changes.embeddingsKeyChanged) {
    items.push("Embeddings API key updated");
  }
  if (changes.platformChanged) {
    items.push("Platform changed");
  }
  if (changes.projectChanged) {
    items.push("Project slug changed");
  }
  if (changes.directoryChanged) {
    items.push("OpenClaw directory changed");
  }
  if (changes.dbPathChanged) {
    if (changes.openclawDbPath) {
      items.push(`Database: isolated at ${changes.openclawDbPath}`);
    } else {
      items.push("Database: switched to shared");
    }
  }

  if (items.length === 0) {
    return "No changes detected.";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export async function runInitCommand(options: InitCommandOptions): Promise<InitCommandResult> {
  const projectDir = path.resolve(options.path?.trim() || process.cwd());
  if (projectDir === os.homedir()) {
    throw new Error(
      "Cannot initialize agenr in your home directory. cd into a project directory first, or pass --path <project-dir>.",
    );
  }

  const platform = (() => {
    if (!options.platform) {
      return null;
    }
    const normalized = options.platform.trim().toLowerCase();
    if (!isPlatform(normalized)) {
      throw new Error(`--platform must be one of: ${PLATFORM_VALUES.join(", ")}`);
    }
    return normalized;
  })();

  const resolvedPlatform = platform ?? (await detectPlatform(projectDir));
  const project = resolveProjectSlug(projectDir, options.project);
  const dependencies = options.dependsOn !== undefined ? normalizeSlugList(options.dependsOn) : undefined;

  const configResult = await writeAgenrConfig(
    projectDir,
    project,
    resolvedPlatform,
    dependencies,
    options.openclawDbPath,
  );
  const instructionsPath = await resolveInstructionsPath(projectDir, resolvedPlatform);
  if (instructionsPath !== null) {
    await upsertPromptBlock(instructionsPath, buildSystemPromptBlock(project));
  }
  const { mcpPath, skipped: mcpSkipped } = await writeMcpConfig(projectDir, resolvedPlatform);
  let gitignoreUpdated = false;
  if (resolvedPlatform !== "openclaw" && resolvedPlatform !== "codex") {
    const gitignoreEntries = [".agenr/knowledge.db"];
    if (resolvedPlatform === "cursor") {
      gitignoreEntries.push(".cursor/rules/agenr.mdc");
      if (instructionsPath !== null && isPathInsideProject(projectDir, instructionsPath)) {
        const relativeInstructionsPath = path.relative(projectDir, instructionsPath).split(path.sep).join("/");
        gitignoreEntries.push(relativeInstructionsPath);
      }
    }
    gitignoreUpdated = await addGitignoreEntries(projectDir, gitignoreEntries);
  }

  return {
    platform: resolvedPlatform,
    project,
    projectDir,
    dependencies: Array.isArray(configResult.config.dependencies) ? configResult.config.dependencies : [],
    configPath: configResult.configPath,
    instructionsPath,
    mcpPath,
    mcpSkipped,
    gitignoreUpdated,
  };
}

export const initWizardRuntime = {
  runInitCommand,
  formatInitSummary,
  readConfig,
  formatExistingConfig,
  runSetupCore,
  detectPlatforms,
  installOpenClawPlugin,
  writeOpenClawPluginDbPath,
  scanSessionFiles,
  runIngestCommand,
  runConsolidateCommand,
  runWatcherInstallCommand,
  runWatcherStopCommand,
  runDbResetCommand,
};

export async function runInitWizard(options: WizardOptions): Promise<void> {
  const shouldRunInteractive = options.isInteractive && !options.platform && !options.project;

  if (!shouldRunInteractive) {
    const result = await initWizardRuntime.runInitCommand(options);
    for (const line of initWizardRuntime.formatInitSummary(result)) {
      process.stdout.write(`${line}\n`);
    }
    return;
  }

  clack.intro(banner());

  const env = process.env;
  const baseProjectDir = path.resolve(options.path?.trim() || process.cwd());
  let projectDir = baseProjectDir;
  const rawExistingConfig = initWizardRuntime.readConfig(env);
  const existingConfig = rawExistingConfig ? mergeConfigPatch(rawExistingConfig, {}) : null;
  const existingProjectSettings = await readExistingProjectSettings(baseProjectDir);
  const hasExistingConfig =
    existingConfig !== null || existingProjectSettings.platform !== undefined || existingProjectSettings.project !== undefined;

  if (hasExistingConfig) {
    const summaryLines: string[] = [];
    if (existingConfig) {
      const sharedDbPath = resolveSharedKnowledgeDbPath();
      summaryLines.push(initWizardRuntime.formatExistingConfig(existingConfig, sharedDbPath));
    } else {
      if (existingProjectSettings.platform) {
        summaryLines.push(`Platform: ${formatPlatformLabel(existingProjectSettings.platform)}`);
      }
      if (existingProjectSettings.project) {
        summaryLines.push(`Project: ${existingProjectSettings.project}`);
      }
    }
    if (summaryLines.length > 0) {
      clack.note(summaryLines.join("\n"), "Current config");
    }

    const reconfigure = await clack.confirm({
      message: "Reconfigure?",
      initialValue: false,
    });
    if (clack.isCancel(reconfigure)) {
      clack.cancel("Setup cancelled.");
      return;
    }
    if (!reconfigure) {
      clack.outro("Setup unchanged.");
      return;
    }
  }

  const wizardChanges: WizardChanges = {
    authChanged: false,
    modelChanged: false,
    modelsChanged: false,
    platformChanged: false,
    projectChanged: false,
    embeddingsKeyChanged: false,
    directoryChanged: false,
    dbPathChanged: false,
    previousModel: existingConfig?.models?.extraction,
    newModel: existingConfig?.models?.extraction,
  };

  let selectedAuth = existingConfig?.auth;
  let selectedModel = existingConfig?.models?.extraction;
  const previousTaskModels = normalizeTaskModels(existingConfig?.models);
  let selectedTaskModels = normalizeTaskModels(existingConfig?.models);
  let workingConfig = existingConfig;
  let ranSetupCoreForAuthModel = false;
  const previousEmbeddingKey = resolveEmbeddingKeyOrNull(existingConfig, env);
  let currentEmbeddingKey = previousEmbeddingKey;
  const hasCurrentAuthModel = Boolean(existingConfig?.auth && selectedModel && existingConfig.provider);

  if (hasCurrentAuthModel && existingConfig?.auth) {
    const authAction = await clack.select<"keep" | "change-model" | "change-auth">({
      message: `Auth: ${describeAuth(existingConfig.auth)} | Model: ${selectedModel} (current)`,
      options: [
        { value: "keep", label: "Keep current auth and model" },
        { value: "change-model", label: "Change model only" },
        { value: "change-auth", label: "Change auth and model..." },
      ],
    });
    if (clack.isCancel(authAction)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (authAction === "change-auth") {
      ranSetupCoreForAuthModel = true;
      const setupResult = await initWizardRuntime.runSetupCore({
        env,
        existingConfig,
        skipIntroOutro: true,
      });
      if (!setupResult) {
        clack.cancel("Setup cancelled.");
        return;
      }
      selectedAuth = setupResult.auth;
      selectedModel = setupResult.model;
      workingConfig = setupResult.config;
      selectedTaskModels = normalizeTaskModels(setupResult.config.models);
      currentEmbeddingKey = resolveEmbeddingKeyOrNull(setupResult.config, env);
    } else if (authAction === "change-model") {
      const provider = existingConfig.provider;
      if (!provider) {
        throw new Error("Existing config is missing provider for model selection.");
      }

      const modelChoices = modelChoicesForAuth(existingConfig.auth, provider);
      if (modelChoices.length === 0) {
        throw new Error(`No models are available for provider "${provider}".`);
      }

      const newModel = await clack.select<string>({
        message: "Select default model:",
        options: modelChoices.map((id) => ({
          value: id,
          label: id,
          hint: modelHintForChoice(provider, id),
        })),
        initialValue: selectedModel,
      });
      if (clack.isCancel(newModel)) {
        clack.cancel("Setup cancelled.");
        return;
      }

      selectedModel = newModel;
      selectedTaskModels = {
        ...(selectedTaskModels ?? resolveTaskModelDefaults(newModel)),
        extraction: newModel,
      };
      workingConfig = {
        ...existingConfig,
        models: selectedTaskModels,
      };
      currentEmbeddingKey = resolveEmbeddingKeyOrNull(workingConfig, env);
    }
  } else {
    ranSetupCoreForAuthModel = true;
    const setupResult = await initWizardRuntime.runSetupCore({
      env,
      existingConfig,
      skipIntroOutro: true,
    });
    if (!setupResult) {
      clack.cancel("Setup cancelled.");
      return;
    }
    selectedAuth = setupResult.auth;
    selectedModel = setupResult.model;
    workingConfig = setupResult.config;
    selectedTaskModels = normalizeTaskModels(setupResult.config.models);
    currentEmbeddingKey = resolveEmbeddingKeyOrNull(setupResult.config, env);
  }

  wizardChanges.authChanged = existingConfig ? existingConfig.auth !== selectedAuth : false;
  wizardChanges.modelChanged = existingConfig ? existingConfig.models?.extraction !== selectedModel : false;
  wizardChanges.embeddingsKeyChanged = previousEmbeddingKey !== currentEmbeddingKey;
  wizardChanges.newModel = selectedModel;

  if (!wizardChanges.authChanged && hasCurrentAuthModel) {
    const embeddingStatus = currentEmbeddingKey ? "configured" : "not configured";
    clack.log.info(formatLabel("Embeddings", embeddingStatus));
  }

  if (!ranSetupCoreForAuthModel) {
    const taskModelResult = await promptTaskModelOverrides(selectedModel, selectedTaskModels);
    if (taskModelResult.cancelled) {
      clack.cancel("Setup cancelled.");
      return;
    }

    selectedTaskModels = normalizeTaskModels(taskModelResult.models) ?? resolveTaskModelDefaults(selectedModel);
    if (taskModelResult.changed) {
      const nextConfig: AgenrConfig = {
        ...(workingConfig ?? {}),
        models: selectedTaskModels,
      };
      workingConfig = nextConfig;
    }
  }
  wizardChanges.modelsChanged = !taskModelsEqual(previousTaskModels, selectedTaskModels);

  const platforms = initWizardRuntime.detectPlatforms();
  const currentPlatform =
    existingProjectSettings.platform && isWizardPlatformId(existingProjectSettings.platform)
      ? existingProjectSettings.platform
      : undefined;

  let selectedPlatform: DetectedPlatform | null;
  if (currentPlatform) {
    const platformAction = await clack.select<"keep" | "change">({
      message: `Platform: ${formatPlatformLabel(currentPlatform)} (current)`,
      options: [
        { value: "keep", label: "Keep current" },
        { value: "change", label: "Change..." },
      ],
    });
    if (clack.isCancel(platformAction)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (platformAction === "keep") {
      selectedPlatform =
        platforms.find((platform) => platform.id === currentPlatform) ?? {
          id: currentPlatform,
          label: formatPlatformLabel(currentPlatform),
          detected: false,
          configDir:
            currentPlatform === "openclaw" ? resolveDefaultOpenClawConfigDir() : resolveDefaultCodexConfigDir(),
          sessionsDir:
            currentPlatform === "openclaw"
              ? path.join(resolveOpenClawConfigSubdir(resolveDefaultOpenClawConfigDir()), "agents", "main", "sessions")
              : path.join(resolveDefaultCodexConfigDir(), "sessions"),
        };
    } else {
      selectedPlatform = await choosePlatform(platforms);
    }
  } else {
    if (existingProjectSettings.platform) {
      clack.log.info(
        `Current platform "${existingProjectSettings.platform}" is not supported in this wizard yet. Choose OpenClaw or Codex.`,
      );
    }
    selectedPlatform = await choosePlatform(platforms);
  }

  if (!selectedPlatform) {
    clack.cancel("Setup cancelled.");
    return;
  }

  const sharedDbPath = resolveSharedKnowledgeDbPath();
  let selectedOpenclawDbPath: string | undefined;

  if (selectedPlatform.id === "openclaw") {
    const openclawDir = await clack.text({
      message: "OpenClaw directory:",
      initialValue: selectedPlatform.configDir,
      placeholder: selectedPlatform.configDir,
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Path is required";
        }
        return undefined;
      },
    });

    if (clack.isCancel(openclawDir)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    const resolvedOpenclawDir = resolveInputPath(openclawDir.trim());
    selectedPlatform = {
      ...selectedPlatform,
      configDir: resolvedOpenclawDir,
      sessionsDir: path.join(resolveOpenClawConfigSubdir(resolvedOpenclawDir), "agents", "main", "sessions"),
    };
  }

  projectDir = resolveWizardProjectDir(projectDir, selectedPlatform.id, selectedPlatform.configDir);

  if (selectedPlatform.id === "openclaw" && !isDefaultOpenClawPath(selectedPlatform.configDir)) {
    const dbSelection = await clack.select<"isolated" | "shared">({
      message: "Database: use shared brain (~/.agenr/knowledge.db) or isolated?",
      options: [
        {
          value: "isolated",
          label: "Isolated (separate database for this instance)",
        },
        {
          value: "shared",
          label: "Shared (all instances use the same knowledge)",
        },
      ],
    });

    if (clack.isCancel(dbSelection)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (dbSelection === "isolated") {
      selectedOpenclawDbPath = path.join(selectedPlatform.configDir, "agenr-data", "knowledge.db");
      clack.log.info(`Database path: ${formatPathForDisplay(selectedOpenclawDbPath)}`);
    }
  }

  wizardChanges.platformChanged = existingProjectSettings.platform
    ? existingProjectSettings.platform !== selectedPlatform.id
    : false;
  wizardChanges.openclawDbPath = selectedOpenclawDbPath;

  const derivedSlug = resolveWizardProjectSlug(projectDir, selectedPlatform.id);
  let projectSlug: string | null = null;
  let offeredKeepProjectSelection = false;
  while (true) {
    if (!projectSlug) {
      if (existingProjectSettings.project && !offeredKeepProjectSelection) {
        const projectAction = await clack.select<"keep" | "change">({
          message: `Project: ${existingProjectSettings.project} (current)`,
          options: [
            { value: "keep", label: "Keep current" },
            { value: "change", label: "Change..." },
          ],
        });
        if (clack.isCancel(projectAction)) {
          clack.cancel("Setup cancelled.");
          return;
        }

        offeredKeepProjectSelection = true;
        if (projectAction === "keep") {
          projectSlug = existingProjectSettings.project;
        }
      }

      if (!projectSlug) {
        const enteredProject = await clack.text({
          message: "Project name:",
          initialValue: existingProjectSettings.project ?? derivedSlug,
          placeholder: derivedSlug,
          validate: (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              return "Project name is required";
            }
            if (!normalizeSlug(trimmed)) {
              return "Project name must include letters or numbers";
            }
            return undefined;
          },
        });

        if (clack.isCancel(enteredProject)) {
          clack.cancel("Setup cancelled.");
          return;
        }

        projectSlug = normalizeSlug(enteredProject.trim());
        if (!projectSlug) {
          clack.log.warn("Project name must include letters or numbers.");
          projectSlug = null;
          continue;
        }
        offeredKeepProjectSelection = true;
      }
    }

    if (!projectSlug) {
      continue;
    }

    if (isWizardPlatformId(selectedPlatform.id)) {
      const globalProjects = getGlobalProjectMap(readConfig(env));

      if (!selectedOpenclawDbPath) {
        const resolvedDir = path.resolve(projectDir);
        const otherSharedEntries = Object.entries(globalProjects)
          .filter(([dirKey, entry]) => dirKey !== resolvedDir && !entry.dbPath);
        const otherSharedSameSlug = otherSharedEntries
          .filter(([, entry]) => entry.project === projectSlug);
        const otherSharedDiffSlug = otherSharedEntries
          .filter(([, entry]) => entry.project !== projectSlug);

        if (otherSharedSameSlug.length > 0) {
          const conflicting = otherSharedSameSlug
            .map(([dirPath]) => `  - ${formatPathForDisplay(dirPath)}`)
            .join("\n");
          clack.log.warn(
            `WARNING: This project uses the same name ("${projectSlug}") and the same database as:\n${conflicting}\n\n` +
              "Entries from these instances will be completely indistinguishable.\n" +
              "There is no way to isolate one instance's data from the other.\n\n" +
              "To fix this, either:\n" +
              "  1. Use a different project name for this instance\n" +
              "  2. Use an isolated database instead of shared",
          );

          projectSlug = null;
          clack.log.info(
            "Choose a different project name, or restart and select an isolated database for this instance.",
          );
          continue;
        } else if (otherSharedDiffSlug.length > 0) {
          const others = otherSharedDiffSlug
            .map(([dirPath, entry]) => `  - ${entry.project} (${formatPathForDisplay(dirPath)})`)
            .join("\n");
          clack.log.info(
            `This project shares the knowledge database with:\n${others}\n` +
              "All projects using the shared database can see each other's knowledge.\n" +
              "Data is separated by project tag in recall queries.",
          );
        }
      }
    }

    break;
  }

  if (!projectSlug) {
    clack.cancel("Setup cancelled.");
    return;
  }

  wizardChanges.projectChanged = existingProjectSettings.project
    ? existingProjectSettings.project !== projectSlug
    : false;

  if (isWizardPlatformId(selectedPlatform.id)) {
    const existingProjects = getGlobalProjectMap(readConfig(env));
    const resolvedDir = path.resolve(projectDir);
    const existingEntry = existingProjects[resolvedDir];

    if (existingEntry) {
      wizardChanges.directoryChanged = false;
      const existingDbPath = existingEntry.dbPath ?? null;
      const newDbPath = selectedOpenclawDbPath ?? null;
      wizardChanges.dbPathChanged = existingDbPath !== newDbPath;
    } else {
      wizardChanges.directoryChanged = true;
      wizardChanges.dbPathChanged = Boolean(selectedOpenclawDbPath);
    }
  }

  let initResult: InitCommandResult;
  let pluginStatus = "";
  if (selectedPlatform.id === "openclaw") {
    const openclawConfigPath = path.join(resolveOpenClawConfigSubdir(selectedPlatform.configDir), "openclaw.json");
    const confirmConfigPath = await clack.text({
      message: "OpenClaw config file path:",
      initialValue: openclawConfigPath,
      placeholder: openclawConfigPath,
      validate: (value) => {
        if (!value.trim()) return "Path is required";
        if (!value.endsWith("openclaw.json")) return "Path must end with openclaw.json";
        return undefined;
      },
    });
    if (clack.isCancel(confirmConfigPath)) {
      clack.cancel("Setup cancelled.");
      return;
    }
    // If user accepted the default, use selectedPlatform.configDir as OPENCLAW_HOME.
    // If they changed it, derive OPENCLAW_HOME from the config file's parent,
    // accounting for the .openclaw subdir pattern.
    const confirmedPath = confirmConfigPath as string;
    const defaultPath = path.join(resolveOpenClawConfigSubdir(selectedPlatform.configDir), "openclaw.json");
    let resolvedConfigDir: string;
    if (confirmedPath === defaultPath) {
      resolvedConfigDir = selectedPlatform.configDir;
    } else {
      // User changed the path - the config dir parent is the OPENCLAW_HOME
      // unless the parent is a .openclaw subdir
      const configFileDir = path.dirname(confirmedPath);
      resolvedConfigDir = path.basename(configFileDir) === ".openclaw"
        ? path.dirname(configFileDir)
        : configFileDir;
    }
    selectedPlatform = {
      ...selectedPlatform,
      configDir: resolvedConfigDir,
    };

    const confirmSessionsDir = await clack.text({
      message: "Sessions directory:",
      initialValue: selectedPlatform.sessionsDir,
      placeholder: selectedPlatform.sessionsDir,
      validate: (value) => {
        if (!value.trim()) return "Path is required";
        return undefined;
      },
    });
    if (clack.isCancel(confirmSessionsDir)) {
      clack.cancel("Setup cancelled.");
      return;
    }
    selectedPlatform = {
      ...selectedPlatform,
      sessionsDir: resolveInputPath((confirmSessionsDir as string).trim()),
    };

    projectDir = resolveWizardProjectDir(projectDir, selectedPlatform.id, selectedPlatform.configDir);
    initResult = await initWizardRuntime.runInitCommand({
      platform: selectedPlatform.id,
      project: projectSlug,
      path: projectDir,
      dependsOn: options.dependsOn,
      openclawDbPath: selectedOpenclawDbPath,
    });

    const spinner = clack.spinner();
    spinner.start("Installing agenr plugin for OpenClaw...");
    const pluginResult = await initWizardRuntime.installOpenClawPlugin(resolvedConfigDir);
    spinner.stop(pluginResult.message);
    pluginStatus = pluginResult.message;

    // Write plugins.allow + entries + dbPath AFTER install but BEFORE restart
    // so the config references a plugin that actually exists on disk.
    if (pluginResult.success) {
      await initWizardRuntime.writeOpenClawPluginDbPath(
        resolvedConfigDir,
        selectedOpenclawDbPath,
      );
      if (selectedOpenclawDbPath) {
        clack.log.info(
          `Configured isolated database: ${formatPathForDisplay(selectedOpenclawDbPath)}`,
        );
      }

      // Restart gateway to pick up the new plugin config.
      const openclawBin = findBinaryPath("openclaw");
      if (!openclawBin) {
        clack.log.warn("openclaw not found on PATH. Restart the gateway manually: openclaw gateway restart");
      } else {
        spinner.start("Restarting gateway...");
        try {
          await execAsync(openclawBin, ["gateway", "restart"], {
            encoding: "utf8",
            timeout: 30000,
            env: { ...process.env },
          });
          spinner.stop("Gateway restarted");
        } catch {
          try {
            await execAsync(openclawBin, ["gateway", "start"], {
              encoding: "utf8",
              timeout: 30000,
              env: { ...process.env },
            });
            spinner.stop("Gateway started");
          } catch {
            spinner.stop("Gateway needs restart. Run: openclaw gateway restart");
          }
        }
      }
    }
  } else {
    initResult = await initWizardRuntime.runInitCommand({
      platform: selectedPlatform.id,
      project: projectSlug,
      path: projectDir,
      dependsOn: options.dependsOn,
      openclawDbPath: selectedOpenclawDbPath,
    });
  }

  if (wizardChanges.modelChanged || wizardChanges.modelsChanged) {
    const latestConfig = initWizardRuntime.readConfig(env) ?? workingConfig ?? { models: resolveTaskModelDefaults(selectedModel) };
    const resolvedTaskModels = selectedTaskModels ?? resolveTaskModelDefaults(selectedModel);
    const nextConfig: AgenrConfig = {
      ...latestConfig,
      models: resolvedTaskModels,
    };
    writeConfig(nextConfig, env);
    workingConfig = nextConfig;
  }

  if (hasExistingConfig && (wizardChanges.authChanged || wizardChanges.modelChanged)) {
    const modelChangeDesc = wizardChanges.previousModel && wizardChanges.newModel
      ? `from ${wizardChanges.previousModel} to ${wizardChanges.newModel}`
      : "your extraction model";

    clack.log.warn(
      `You changed ${modelChangeDesc}.\n\n` +
        "Re-ingesting with a better model can significantly improve extraction quality,\n" +
        "but requires clearing your existing knowledge database first.",
    );

    const reIngestChoice = await clack.select<"reingest" | "keep">({
      message: "WARNING: Re-ingest will permanently delete all existing entries.",
      options: [
        {
          value: "reingest",
          label: "Re-ingest (reset DB + ingest with new model)",
          hint: "recommended",
        },
        {
          value: "keep",
          label: "Keep existing data (new sessions use new model going forward)",
        },
      ],
    });

    if (clack.isCancel(reIngestChoice)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (reIngestChoice === "reingest") {
      const spinner = clack.spinner();

      if (process.platform === "darwin") {
        spinner.start("Stopping watcher...");
        try {
          await initWizardRuntime.runWatcherStopCommand({});
        } catch {
          // Watcher might not be running.
        }
        spinner.stop("Watcher stopped");
      }

      spinner.start("Resetting knowledge database...");
      await initWizardRuntime.runDbResetCommand({
        full: true,
        confirmReset: true,
        ...(selectedOpenclawDbPath ? { db: selectedOpenclawDbPath } : {}),
      });
      spinner.stop("Database reset");
    }
  }

  let ingestStatus = "Skipped";
  let ingestResult: IngestCommandResult | null = null;

  const scan = await initWizardRuntime.scanSessionFiles(selectedPlatform.sessionsDir);
  if (scan.totalFiles === 0) {
    clack.log.info(
      "No sessions found yet. The watcher will pick them up as you use " +
        formatPlatformLabel(selectedPlatform.id) + ".",
    );
    ingestStatus = "No sessions found";
  } else {
    const config = initWizardRuntime.readConfig(env);
    const rawProvider = config?.provider ?? "openai";
    const VALID_PROVIDERS: AgenrProvider[] = ["openai", "anthropic", "openai-codex"];
    const provider: AgenrProvider = VALID_PROVIDERS.includes(rawProvider as AgenrProvider)
      ? (rawProvider as AgenrProvider)
      : "openai";
    const model = config?.models.extraction ?? DEFAULT_TASK_MODEL;

    const recentCost = estimateIngestCost(scan.recentSizeBytes, model, provider);
    const fullCost = estimateIngestCost(scan.totalSizeBytes, model, provider);

    const ingestChoice = await clack.select<"recent" | "full" | "skip">({
      message:
        `Found ${scan.totalFiles} sessions ` +
        `(${scan.recentFiles.length} from last 7 days)\n\n` +
        `Estimated cost with ${model}:\n` +
        `  Last 7 days:  ${formatTokenCount(recentCost.inputTokens)} tokens  ` +
        `${formatCostUsd(recentCost.totalCostUsd)}\n` +
        `  Full history: ${formatTokenCount(fullCost.inputTokens)} tokens  ` +
        `${formatCostUsd(fullCost.totalCostUsd)}`,
      options: [
        {
          value: "recent",
          label: `Ingest last 7 days (${formatCostUsd(recentCost.totalCostUsd)})`,
          hint: "recommended",
        },
        {
          value: "full",
          label: `Ingest everything (${formatCostUsd(fullCost.totalCostUsd)})`,
          hint: "may take a while",
        },
        {
          value: "skip",
          label: "Skip for now",
        },
      ],
    });

    if (clack.isCancel(ingestChoice)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (ingestChoice !== "skip") {
      const isRecent = ingestChoice === "recent";
      const fileCount = isRecent ? scan.recentFiles.length : scan.totalFiles;
      const spinner = clack.spinner();
      spinner.start(`Ingesting ${fileCount} sessions...`);

      const inputPaths = isRecent
        ? scan.recentFiles
        : [selectedPlatform.sessionsDir];

      const ingestOptions = {
        bulk: true,
        workers: 10,
        concurrency: 1,
        platform: selectedPlatform.id,
        project: projectSlug,
        wholeFile: true,
        ...(selectedOpenclawDbPath ? { db: selectedOpenclawDbPath } : {}),
        ...(!isRecent ? { glob: "**/*.jsonl*" } : {}),
      };

      ingestResult = await initWizardRuntime.runIngestCommand(
        inputPaths,
        ingestOptions,
      );

      if (ingestResult.exitCode === 0) {
        spinner.stop(
          `${ingestResult.filesProcessed} sessions processed - ` +
            `${ingestResult.totalEntriesStored} entries extracted`,
        );
        ingestStatus =
          `${ingestResult.filesProcessed} sessions - ` +
          `${ingestResult.totalEntriesStored} entries`;
      } else {
        spinner.stop(
          `Ingest completed with errors (${ingestResult.filesFailed} failures)`,
        );
        ingestStatus = `Completed with ${ingestResult.filesFailed} errors`;
      }
    }
  }

  let consolidateStatus = "Skipped";
  if (
    ingestResult &&
    ingestResult.exitCode === 0 &&
    ingestResult.totalEntriesStored > 0
  ) {
    const runConsolidate = await clack.confirm({
      message:
        `Consolidate ${ingestResult.totalEntriesStored} entries? ` +
        "Merges duplicates and related knowledge.",
      initialValue: true,
    });

    if (clack.isCancel(runConsolidate)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (runConsolidate) {
      const spinner = clack.spinner();
      spinner.start("Consolidating knowledge base...");

      try {
        const consolidateResult = await initWizardRuntime.runConsolidateCommand({
          ...(selectedOpenclawDbPath ? { db: selectedOpenclawDbPath } : {}),
          simThreshold: 0.76,
        });

        if (consolidateResult.exitCode === 0) {
          spinner.stop("Consolidation complete");
          consolidateStatus = "Complete";
        } else {
          spinner.stop(
            "Consolidation finished with errors. Run manually: agenr consolidate",
          );
          consolidateStatus = "Failed";
        }
      } catch {
        spinner.stop(
          "Consolidation failed. Run manually: agenr consolidate",
        );
        consolidateStatus = "Failed";
      }
    }
  }

  let watcherStatus = "";
  if (process.platform === "darwin") {
    const setupWatcher = await clack.confirm({
      message:
        "Set up automatic ingestion? Watches for new sessions and extracts " +
        "knowledge continuously.",
      initialValue: true,
    });

    if (clack.isCancel(setupWatcher)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (setupWatcher) {
      const spinner = clack.spinner();
      spinner.start("Installing watcher...");

      try {
        const watcherResult = await initWizardRuntime.runWatcherInstallCommand({
          force: true,
          interval: 120,
          dir: selectedPlatform.sessionsDir,
          platform: selectedPlatform.id,
        });

        if (watcherResult.exitCode === 0) {
          spinner.stop("Watcher installed and running (120s interval)");
          watcherStatus = "Running (120s interval)";
        } else {
          spinner.stop(
            "Watcher install failed. Run manually:\n" +
              `  agenr watch --dir ${selectedPlatform.sessionsDir} ` +
              `--platform ${selectedPlatform.id}`,
          );
          watcherStatus = "Failed";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        spinner.stop(`Watcher install failed: ${message}`);
        watcherStatus = "Failed";
      }
    } else {
      watcherStatus = "Skipped";
    }
  } else {
    const osName = process.platform === "win32" ? "Windows" : "Linux";
    clack.log.info(
      `Automatic ingestion not yet supported on ${osName}. Run manually:\n` +
        `  agenr watch --dir ${selectedPlatform.sessionsDir} ` +
        `--platform ${selectedPlatform.id}`,
    );
    watcherStatus = `Not supported on ${osName}`;
  }

  const openclawDatabase =
    selectedPlatform.id === "openclaw"
      ? `${formatPathForDisplay(selectedOpenclawDbPath ?? sharedDbPath)} (${selectedOpenclawDbPath ? "isolated" : "shared"})`
      : undefined;
  clack.note(
    formatWizardSummary({
      platform: formatPlatformLabel(initResult.platform),
      directory: initResult.platform === "openclaw" ? formatPathForDisplay(selectedPlatform.configDir) : undefined,
      database: openclawDatabase,
      configPath: formatPathForDisplay(initResult.configPath),
      project: initResult.project,
      authLabel: selectedAuth ? describeAuth(selectedAuth) : "(not set)",
      model: selectedModel ?? "(not set)",
      taskModels: selectedTaskModels,
      pluginStatus: pluginStatus || undefined,
      ingestStatus,
      consolidateStatus:
        consolidateStatus !== "Skipped" ? consolidateStatus : undefined,
      watcherStatus: watcherStatus || undefined,
    }),
    "Setup summary",
  );

  const nextSteps: string[] = [];
  if (
    selectedPlatform.id === "openclaw" &&
    !pluginStatus.includes("installed") &&
    !pluginStatus.includes("loaded via local path") &&
    !pluginStatus.includes("skipped npm install")
  ) {
    nextSteps.push("Install plugin: openclaw plugins install agenr");
  }
  if (ingestStatus === "Skipped" || ingestStatus === "No sessions found") {
    nextSteps.push(
      `Run ingest: agenr ingest ${selectedPlatform.sessionsDir} --bulk ` +
        `--platform ${selectedPlatform.id} --project ${projectSlug} --whole-file`,
    );
  }
  if (watcherStatus === "Skipped" || watcherStatus.startsWith("Not supported")) {
    nextSteps.push(
      `Start watcher: agenr watch --dir ${selectedPlatform.sessionsDir} ` +
        `--platform ${selectedPlatform.id}`,
    );
  }
  if (nextSteps.length > 0) {
    clack.note(nextSteps.map((step) => `  ${step}`).join("\n"), "Next steps");
  }

  if (isWizardPlatformId(selectedPlatform.id)) {
    const registeredProjects = getGlobalProjectMap(readConfig(env));
    if (Object.keys(registeredProjects).length >= 2) {
      clack.note(formatRegisteredProjects(registeredProjects, sharedDbPath), "Registered projects");
    }
  }

  if (hasExistingConfig) {
    clack.note(formatWizardChanges(wizardChanges), "Changes");
  }
  clack.outro("Setup complete.");
}
