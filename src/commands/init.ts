import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export interface InitCommandResult {
  platform: InitPlatform;
  project: string;
  projectDir: string;
  dependencies: string[];
  configPath: string;
  instructionsPath: string;
  mcpPath: string;
  gitignoreUpdated: boolean;
}

interface InitConfigFile {
  project?: string;
  platform?: InitPlatform;
  projectDir?: string;
  dependencies?: string[];
  [key: string]: unknown;
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
  if (await pathExists(path.join(projectDir, "AGENTS.md"))) {
    return "openclaw";
  }
  if (await pathExists(path.join(projectDir, ".windsurfrules"))) {
    return "windsurf";
  }
  return "generic";
}

async function resolveInstructionsPath(projectDir: string, platform: InitPlatform): Promise<string> {
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

function buildMcpEntry(projectDir: string): JsonRecord {
  return {
    command: "agenr",
    args: ["mcp"],
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

async function writeMcpConfig(projectDir: string, platform: InitPlatform): Promise<string> {
  const mcpPath = platform === "cursor" ? path.join(projectDir, ".cursor", "mcp.json") : path.join(projectDir, ".mcp.json");
  const existing = (await readJsonRecord(mcpPath)) ?? {};
  const next = mergeMcpConfig(existing, buildMcpEntry(projectDir));
  await writeJsonFile(mcpPath, next);
  return mcpPath;
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

function resolveProjectSlug(projectDir: string, explicitProject?: string): string {
  const source = explicitProject?.trim() || path.basename(projectDir);
  const slug = normalizeSlug(source);
  if (!slug) {
    throw new Error("Could not derive project slug. Pass --project <slug>.");
  }
  return slug;
}

export function formatInitSummary(result: InitCommandResult): string[] {
  const dependencyLabel = result.dependencies.length > 0 ? `[${result.dependencies.join(",")}]` : "[]";
  const lines = [
    `agenr init: platform=${result.platform} project=${result.project} dependencies=${dependencyLabel}`,
    `- Wrote .agenr/config.json`,
    `- Wrote system prompt block to ${path.basename(result.instructionsPath)}`,
    `- Wrote MCP config to ${path.relative(result.projectDir, result.mcpPath) || path.basename(result.mcpPath)}`,
  ];
  if (result.gitignoreUpdated) {
    lines.push("- Added .agenr/knowledge.db to .gitignore");
  }
  return lines;
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
  await upsertPromptBlock(instructionsPath, buildSystemPromptBlock(project));
  const mcpPath = await writeMcpConfig(projectDir, resolvedPlatform);
  const gitignoreEntries = [".agenr/knowledge.db"];
  if (resolvedPlatform === "cursor") {
    gitignoreEntries.push(".cursor/rules/agenr.mdc");
    if (isPathInsideProject(projectDir, instructionsPath)) {
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
    gitignoreUpdated,
  };
}
