import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { describeAuth, readConfig } from "../config.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { formatExistingConfig, runSetupCore } from "../setup.js";
import { banner, formatLabel } from "../ui.js";
import { detectPlatforms } from "./init/platform-detector.js";
import type { DetectedPlatform } from "./init/platform-detector.js";

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

export function resolveAgenrCommand(): { command: string; baseArgs: string[] } {
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
  platformChanged: boolean;
  projectChanged: boolean;
  embeddingsKeyChanged: boolean;
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
  project: string;
  authLabel: string;
  model: string;
}

type JsonRecord = Record<string, unknown>;

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

function buildSystemPromptBlock(projectSlug: string): string {
  return [
    "You have access to agenr_recall and agenr_store for persistent memory across sessions.",
    "",
    'On session start, call agenr_recall with context="session-start" to load prior knowledge for this project. Mid-session, call agenr_recall with a query when you need context you do not have.',
    "",
    `After any decision, user preference, lesson learned, or important event, immediately call agenr_store. Do not ask - just store it. Each entry needs: type (fact|decision|preference|todo|lesson|event), content (what and why), importance (1-10, default 7, use 9 for critical, 10 sparingly), project="${projectSlug}".`,
    "",
    "Do not store: secrets/credentials, temporary state, verbatim conversation, or information already in files.",
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
): Promise<{ configPath: string; config: InitConfigFile }> {
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
  function tildePath(filePath: string): string {
    const home = os.homedir();
    return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
  }

  const dependencyLabel = result.dependencies.length > 0 ? `[${result.dependencies.join(",")}]` : "[]";
  const lines = [
    `agenr init: platform=${result.platform} project=${result.project} dependencies=${dependencyLabel}`,
    `- Wrote .agenr/config.json`,
    result.platform === "codex"
      ? "- Wrote MCP entry to ~/.codex/config.toml"
      : result.mcpSkipped
        ? "- MCP: handled by OpenClaw native plugin (openclaw plugins install agenr)"
        : `- Wrote MCP config to ${path.relative(result.projectDir, result.mcpPath) || path.basename(result.mcpPath)}`,
  ];
  if (result.instructionsPath !== null) {
    lines.splice(2, 0, `- Wrote system prompt block to ${tildePath(result.instructionsPath)}`);
  } else {
    lines.splice(2, 0, `- Memory injection: handled automatically by ${result.platform} plugin (no instructions file needed)`);
  }
  if (result.gitignoreUpdated) {
    lines.push("- Added .agenr/knowledge.db to .gitignore");
  }
  return lines;
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

async function readExistingProjectSettings(projectDir: string): Promise<ExistingProjectSettings> {
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

function formatWizardSummary(result: WizardSummary): string {
  return [
    `  Platform:  ${result.platform}`,
    `  Project:   ${result.project}`,
    `  Auth:      ${result.authLabel}`,
    `  Model:     ${result.model}`,
  ].join("\n");
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

  const configResult = await writeAgenrConfig(projectDir, project, resolvedPlatform, dependencies);
  const instructionsPath = await resolveInstructionsPath(projectDir, resolvedPlatform);
  if (instructionsPath !== null) {
    await upsertPromptBlock(instructionsPath, buildSystemPromptBlock(project));
  }
  const { mcpPath, skipped: mcpSkipped } = await writeMcpConfig(projectDir, resolvedPlatform);
  const gitignoreEntries = [".agenr/knowledge.db"];
  if (resolvedPlatform === "cursor") {
    gitignoreEntries.push(".cursor/rules/agenr.mdc");
    if (instructionsPath !== null && isPathInsideProject(projectDir, instructionsPath)) {
      const relativeInstructionsPath = path.relative(projectDir, instructionsPath).split(path.sep).join("/");
      gitignoreEntries.push(relativeInstructionsPath);
    }
  }
  const gitignoreUpdated = await addGitignoreEntries(projectDir, gitignoreEntries);

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
  const projectDir = path.resolve(options.path?.trim() || process.cwd());
  const existingConfig = initWizardRuntime.readConfig(env);
  const existingProjectSettings = await readExistingProjectSettings(projectDir);
  const hasExistingConfig =
    existingConfig !== null || existingProjectSettings.platform !== undefined || existingProjectSettings.project !== undefined;

  if (hasExistingConfig) {
    const summaryLines: string[] = [];
    if (existingConfig) {
      summaryLines.push(initWizardRuntime.formatExistingConfig(existingConfig));
    }
    if (existingProjectSettings.platform) {
      summaryLines.push(`Platform: ${formatPlatformLabel(existingProjectSettings.platform)}`);
    }
    if (existingProjectSettings.project) {
      summaryLines.push(`Project: ${existingProjectSettings.project}`);
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
    platformChanged: false,
    projectChanged: false,
    embeddingsKeyChanged: false,
    previousModel: existingConfig?.model,
    newModel: existingConfig?.model,
  };

  let selectedAuth = existingConfig?.auth;
  let selectedModel = existingConfig?.model;
  const previousEmbeddingKey = resolveEmbeddingKeyOrNull(existingConfig, env);
  let currentEmbeddingKey = previousEmbeddingKey;
  const hasCurrentAuthModel = Boolean(existingConfig?.auth && existingConfig.model && existingConfig.provider);

  if (hasCurrentAuthModel && existingConfig?.auth) {
    const authAction = await clack.select<"keep" | "change">({
      message: `Auth: ${describeAuth(existingConfig.auth)} (current)`,
      options: [
        { value: "keep", label: "Keep current" },
        { value: "change", label: "Change..." },
      ],
    });
    if (clack.isCancel(authAction)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (authAction === "change") {
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
      currentEmbeddingKey = resolveEmbeddingKeyOrNull(setupResult.config, env);
    }
  } else {
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
    currentEmbeddingKey = resolveEmbeddingKeyOrNull(setupResult.config, env);
  }

  wizardChanges.authChanged = existingConfig ? existingConfig.auth !== selectedAuth : false;
  wizardChanges.modelChanged = existingConfig ? existingConfig.model !== selectedModel : false;
  wizardChanges.embeddingsKeyChanged = previousEmbeddingKey !== currentEmbeddingKey;
  wizardChanges.newModel = selectedModel;

  if (!wizardChanges.authChanged && hasCurrentAuthModel) {
    const embeddingStatus = currentEmbeddingKey ? "configured" : "not configured";
    clack.log.info(formatLabel("Embeddings", embeddingStatus));
  }

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
          configDir: "",
          sessionsDir: "",
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

  wizardChanges.platformChanged = existingProjectSettings.platform
    ? existingProjectSettings.platform !== selectedPlatform.id
    : false;

  const derivedSlug = resolveProjectSlug(projectDir);
  let projectSlug: string | null = null;

  if (existingProjectSettings.project) {
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
        return undefined;
      },
    });

    if (clack.isCancel(enteredProject)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    projectSlug = enteredProject.trim();
  }

  wizardChanges.projectChanged = existingProjectSettings.project
    ? existingProjectSettings.project !== projectSlug
    : false;

  const initResult = await initWizardRuntime.runInitCommand({
    platform: selectedPlatform.id,
    project: projectSlug,
    path: options.path,
    dependsOn: options.dependsOn,
  });

  clack.note(
    formatWizardSummary({
      platform: formatPlatformLabel(initResult.platform),
      project: initResult.project,
      authLabel: selectedAuth ? describeAuth(selectedAuth) : "(not set)",
      model: selectedModel ?? "(not set)",
    }),
    "Setup summary",
  );

  clack.log.info(`Wizard changes: ${JSON.stringify(wizardChanges)}`);
  clack.outro("Setup complete.");
}
