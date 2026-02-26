import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  readConfigMock,
  describeAuthMock,
  resolveEmbeddingApiKeyMock,
  runSetupCoreMock,
  formatExistingConfigMock,
  clackIntroMock,
  clackNoteMock,
  clackConfirmMock,
  clackSelectMock,
  clackTextMock,
  clackSpinnerMock,
  clackSpinnerStartMock,
  clackSpinnerStopMock,
  clackLogInfoMock,
  clackLogWarnMock,
  clackCancelMock,
  clackOutroMock,
  clackCancelToken,
  execFileMock,
  execFileSyncMock,
  readConfigActualRef,
} = vi.hoisted(() => ({
  readConfigMock: vi.fn(),
  describeAuthMock: vi.fn((auth: string) => auth),
  resolveEmbeddingApiKeyMock: vi.fn(),
  runSetupCoreMock: vi.fn(),
  formatExistingConfigMock: vi.fn(),
  clackIntroMock: vi.fn(),
  clackNoteMock: vi.fn(),
  clackConfirmMock: vi.fn(),
  clackSelectMock: vi.fn(),
  clackTextMock: vi.fn(async (options?: { message?: string; initialValue?: string }) => {
    if (options?.message === "OpenClaw config file path:") {      return options.initialValue ?? "openclaw.json";    }    if (options?.message === "Sessions directory:") {      return options.initialValue ?? "/tmp/sessions";    }    if (options?.message === "OpenClaw directory:") {
      return options.initialValue ?? resolveDefaultOpenClawConfigDir();
    }
    return "agenr";
  }),
  clackSpinnerStartMock: vi.fn(),
  clackSpinnerStopMock: vi.fn(),
  clackSpinnerMock: vi.fn(),
  clackLogInfoMock: vi.fn(),
  clackLogWarnMock: vi.fn(),
  clackCancelMock: vi.fn(),
  clackOutroMock: vi.fn(),
  clackCancelToken: Symbol("cancel"),
  execFileMock: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => { cb(null, "", ""); }),
  execFileSyncMock: vi.fn(),
  readConfigActualRef: {
    value: undefined as undefined | typeof import("../config.js")["readConfig"],
  },
}));

vi.mock("@clack/prompts", () => ({
  intro: clackIntroMock,
  note: clackNoteMock,
  confirm: clackConfirmMock,
  select: clackSelectMock,
  text: clackTextMock,
  spinner: clackSpinnerMock,
  log: {
    info: clackLogInfoMock,
    warn: clackLogWarnMock,
  },
  cancel: clackCancelMock,
  outro: clackOutroMock,
  isCancel: (value: unknown) => value === clackCancelToken,
}));

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  readConfigActualRef.value = actual.readConfig;
  return {
    ...actual,
    readConfig: readConfigMock,
    describeAuth: describeAuthMock,
  };
});

vi.mock("../setup.js", () => ({
  runSetupCore: runSetupCoreMock,
  formatExistingConfig: formatExistingConfigMock,
}));

vi.mock("../embeddings/client.js", () => ({
  resolveEmbeddingApiKey: resolveEmbeddingApiKeyMock,
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import {
  buildMcpEntry,
  formatPathForDisplay,
  formatWizardChanges,
  formatInitSummary,
  initWizardRuntime,
  resolveAgenrCommand,
  resolveWizardProjectDir,
  resolveWizardProjectSlug,
  runInitCommand,
  runInitWizard,
} from "./init.js";
import { resolveDefaultCodexConfigDir, resolveDefaultOpenClawConfigDir } from "./init/platform-detector.js";

function resetReadConfigMockDefault(): void {
  readConfigMock.mockImplementation((env?: NodeJS.ProcessEnv) => {
    if (!readConfigActualRef.value) {
      return null;
    }
    return readConfigActualRef.value(env);
  });
}

resetReadConfigMockDefault();

async function createTempDir(prefix = "agenr-init-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getIsolatedConfigPath(): string {
  const configPath = process.env.AGENR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected AGENR_CONFIG_PATH to be set for test isolation.");
  }
  return configPath;
}

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgenrConfigPath = process.env.AGENR_CONFIG_PATH;

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await createTempDir("agenr-home-");
  tempDirs.push(homeDir);
  process.env.HOME = homeDir;
  return await fn(homeDir);
}

async function withMockedPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) {
    throw new Error("process.platform descriptor is unavailable");
  }

  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

beforeEach(async () => {
  const configDir = await createTempDir("agenr-config-");
  tempDirs.push(configDir);
  process.env.AGENR_CONFIG_PATH = path.join(configDir, "config.json");

  clackSpinnerMock.mockImplementation(() => ({
    start: clackSpinnerStartMock,
    stop: clackSpinnerStopMock,
  }));

  vi.spyOn(initWizardRuntime, "installOpenClawPlugin").mockResolvedValue({
    success: true,
    message: "agenr plugin already installed",
  });
  vi.spyOn(initWizardRuntime, "writeOpenClawPluginDbPath").mockResolvedValue();
  vi.spyOn(initWizardRuntime, "scanSessionFiles").mockResolvedValue({
    totalFiles: 0,
    recentFiles: [],
    allFiles: [],
    totalSizeBytes: 0,
    recentSizeBytes: 0,
  });
  vi.spyOn(initWizardRuntime, "runIngestCommand").mockResolvedValue({
    exitCode: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    totalEntriesExtracted: 0,
    totalEntriesStored: 0,
    dedupStats: {
      entries_added: 0,
      entries_updated: 0,
      entries_skipped: 0,
      entries_reinforced: 0,
      entries_superseded: 0,
      dedup_llm_calls: 0,
    },
    durationMs: 0,
    results: [],
  });
  vi.spyOn(initWizardRuntime, "runConsolidateCommand").mockResolvedValue({ exitCode: 0 });
  vi.spyOn(initWizardRuntime, "runDaemonInstallCommand").mockResolvedValue({ exitCode: 0 });
  vi.spyOn(initWizardRuntime, "runDaemonStopCommand").mockResolvedValue({ exitCode: 0 });
  vi.spyOn(initWizardRuntime, "runDbResetCommand").mockResolvedValue({ exitCode: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  readConfigMock.mockReset();
  resetReadConfigMockDefault();
  describeAuthMock.mockReset();
  describeAuthMock.mockImplementation((auth: string) => auth);
  resolveEmbeddingApiKeyMock.mockReset();
  runSetupCoreMock.mockReset();
  formatExistingConfigMock.mockReset();
  clackSelectMock.mockReset();
  clackTextMock.mockReset();
  clackSpinnerMock.mockReset();
  clackSpinnerStartMock.mockReset();
  clackSpinnerStopMock.mockReset();
  execFileSyncMock.mockReset();
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => { cb(null, "", ""); });
  clackTextMock.mockImplementation(async (options?: { message?: string; initialValue?: string }) => {
    if (options?.message === "OpenClaw config file path:") {      return options.initialValue ?? "openclaw.json";    }    if (options?.message === "Sessions directory:") {      return options.initialValue ?? "/tmp/sessions";    }    if (options?.message === "OpenClaw directory:") {
      return options.initialValue ?? resolveDefaultOpenClawConfigDir();
    }
    return "agenr";
  });
  clackLogInfoMock.mockReset();
  clackLogWarnMock.mockReset();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalAgenrConfigPath === undefined) {
    delete process.env.AGENR_CONFIG_PATH;
  } else {
    process.env.AGENR_CONFIG_PATH = originalAgenrConfigPath;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("runInitCommand", () => {
  it("auto-detects claude-code from .claude directory", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });

    await withTempHome(async (homeDir) => {
      const result = await runInitCommand({ path: dir });
      expect(result.platform).toBe("claude-code");
      expect(result.instructionsPath).toBe(path.join(homeDir, ".claude", "CLAUDE.md"));
      expect(await pathExists(path.join(dir, "CLAUDE.md"))).toBe(false);
    });
  });

  it("auto-detects cursor from .cursor directory", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, ".cursor"), { recursive: true });

    const result = await runInitCommand({ path: dir });
    expect(result.platform).toBe("cursor");
    expect(result.instructionsPath).toBe(path.join(dir, ".cursor", "rules", "agenr.mdc"));
    expect(result.mcpPath).toBe(path.join(dir, ".cursor", "mcp.json"));
  });

  it("writeAgenrConfig still writes per-repo config for cursor", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    const result = await runInitCommand({ path: dir, platform: "cursor" });
    const configPath = path.join(dir, ".agenr", "config.json");
    const config = await readJson(configPath);

    expect(result.configPath).toBe(configPath);
    expect(config.platform).toBe("cursor");
    expect(config.projectDir).toBe(path.resolve(dir));
  });

  it("writeAgenrConfig still writes per-repo config for claude-code", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    const result = await runInitCommand({ path: dir, platform: "claude-code" });
    const configPath = path.join(dir, ".agenr", "config.json");
    const config = await readJson(configPath);

    expect(result.configPath).toBe(configPath);
    expect(config.platform).toBe("claude-code");
    expect(config.projectDir).toBe(path.resolve(dir));
  });

  it("explicit --platform openclaw skips AGENTS.md write and does not write .mcp.json", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    const result = await runInitCommand({ path: dir, platform: "openclaw" });
    expect(result.platform).toBe("openclaw");
    expect(result.instructionsPath).toBeNull();
    expect(result.mcpPath).toBe("");
    expect(result.mcpSkipped).toBe(true);
    expect(await pathExists(path.join(dir, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(dir, ".mcp.json"))).toBe(false);
  });

  it("writeGlobalProjectEntry keys by resolved projectDir", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async () => {
      const result = await runInitCommand({ path: dir, platform: "openclaw" });
      const configPath = getIsolatedConfigPath();
      const config = await readJson(configPath);
      const projects = config.projects as Record<string, unknown>;

      expect(result.configPath).toBe(configPath);
      expect(projects[path.resolve(dir)]).toEqual({
        project: result.project,
        platform: "openclaw",
      });
    });
  });

  it("writeGlobalProjectEntry stores project slug as field", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async () => {
      const result = await runInitCommand({ path: dir, platform: "openclaw", project: "openclaw" });
      const config = await readJson(getIsolatedConfigPath());
      const projects = config.projects as Record<string, { project?: string }>;
      expect(projects[path.resolve(dir)]?.project).toBe(result.project);
    });
  });

  it("writeAgenrConfig does not create .agenr dir for openclaw", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async () => {
      await runInitCommand({ path: dir, platform: "openclaw" });
      expect(await pathExists(path.join(dir, ".agenr"))).toBe(false);
    });
  });

  it("AGENTS.md presence no longer auto-detects openclaw (falls through to generic)", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "existing instructions\n", "utf8");

    const result = await runInitCommand({ path: dir });
    expect(result.platform).toBe("generic");
    expect(result.instructionsPath).toBe(path.join(dir, "AGENTS.md"));

    const instructions = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(instructions).toContain("<!-- agenr:start -->");
    expect(instructions).toContain("<!-- agenr:end -->");
  });

  it("auto-detects windsurf from .windsurfrules", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, ".windsurfrules"), "rules\n", "utf8");

    await withTempHome(async (homeDir) => {
      const result = await runInitCommand({ path: dir });
      expect(result.platform).toBe("windsurf");
      expect(result.instructionsPath).toBe(
        path.join(homeDir, ".codeium", "windsurf", "memories", "global_rules.md"),
      );
      expect(await pathExists(path.join(dir, ".windsurfrules"))).toBe(true);
    });
  });

  it("falls back to generic when no platform markers are present", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    const result = await runInitCommand({ path: dir });
    expect(result.platform).toBe("generic");
    expect(result.instructionsPath).toBe(path.join(dir, "AGENTS.md"));
    expect(result.mcpPath).toBe(path.join(dir, ".mcp.json"));
  });

  it("supports explicit codex platform override", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });

    await withTempHome(async (homeDir) => {
      const result = await runInitCommand({ path: dir, platform: "codex" });
      expect(result.platform).toBe("codex");
      expect(result.instructionsPath).toBe(path.join(homeDir, ".codex", "AGENTS.md"));
      expect(result.mcpPath).toBe(path.join(homeDir, ".codex", "config.toml"));
      expect(result.mcpSkipped).toBe(false);
      expect(await pathExists(path.join(dir, "AGENTS.md"))).toBe(false);
      expect(await pathExists(path.join(dir, ".mcp.json"))).toBe(false);
    });
  });

  it("writeAgenrConfig writes to global projects map for codex", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async () => {
      const result = await runInitCommand({ path: dir, platform: "codex" });
      const configPath = getIsolatedConfigPath();
      const config = await readJson(configPath);
      const projects = config.projects as Record<string, unknown>;

      expect(result.configPath).toBe(configPath);
      expect(projects[path.resolve(dir)]).toEqual({
        project: result.project,
        platform: "codex",
      });
    });
  });

  it("writeAgenrConfig preserves existing projects when adding new one", async () => {
    await withTempHome(async () => {
      const openclawDir = await createTempDir("agenr-openclaw-");
      const codexDir = await createTempDir("agenr-codex-");
      tempDirs.push(openclawDir);
      tempDirs.push(codexDir);

      const openclawResult = await runInitCommand({ path: openclawDir, platform: "openclaw" });
      const codexResult = await runInitCommand({ path: codexDir, platform: "codex" });

      const config = await readJson(getIsolatedConfigPath());
      const projects = config.projects as Record<string, unknown>;
      expect(projects[path.resolve(openclawDir)]).toEqual({
        project: openclawResult.project,
        platform: "openclaw",
      });
      expect(projects[path.resolve(codexDir)]).toEqual({
        project: codexResult.project,
        platform: "codex",
      });
    });
  });

  it("two projects with same slug coexist when keyed by different dirs", async () => {
    await withTempHome(async () => {
      const primaryDir = await createTempDir("agenr-openclaw-primary-");
      const sandboxDir = await createTempDir("agenr-openclaw-sandbox-");
      tempDirs.push(primaryDir);
      tempDirs.push(sandboxDir);

      await runInitCommand({ path: primaryDir, platform: "openclaw", project: "openclaw" });
      await runInitCommand({ path: sandboxDir, platform: "openclaw", project: "openclaw" });

      const config = await readJson(getIsolatedConfigPath());
      const projects = config.projects as Record<string, { project?: string }>;
      expect(Object.keys(projects)).toEqual(expect.arrayContaining([path.resolve(primaryDir), path.resolve(sandboxDir)]));
      expect(projects[path.resolve(primaryDir)]?.project).toBe("openclaw");
      expect(projects[path.resolve(sandboxDir)]?.project).toBe("openclaw");
    });
  });

  it("writeAgenrConfig does not clobber auth/model settings", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async () => {
      const configPath = getIsolatedConfigPath();
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            auth: "openai-api-key",
            provider: "openai",
            model: "gpt-4.1-mini",
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await runInitCommand({ path: dir, platform: "openclaw" });

      const config = await readJson(configPath);
      const projects = config.projects as Record<string, unknown>;
      expect(config.auth).toBe("openai-api-key");
      expect(config.provider).toBe("openai");
      expect(config.model).toBe("gpt-4.1-mini");
      expect(projects[path.resolve(dir)]).toEqual({
        project: result.project,
        platform: "openclaw",
      });
    });
  });

  it("writeAgenrConfig includes dbPath when provided", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const openclawDbPath = path.join(path.resolve(dir), "agenr-data", "knowledge.db");

    await withTempHome(async () => {
      await runInitCommand({ path: dir, platform: "openclaw", openclawDbPath });
      const config = await readJson(getIsolatedConfigPath());
      const projects = config.projects as Record<string, { dbPath?: string }>;
      expect(projects[path.resolve(dir)]?.dbPath).toBe(openclawDbPath);
    });
  });

  it("writeAgenrConfig omits dbPath when not provided", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async () => {
      const result = await runInitCommand({ path: dir, platform: "openclaw" });
      const config = await readJson(getIsolatedConfigPath());
      const projects = config.projects as Record<string, unknown>;
      expect(projects[path.resolve(dir)]).toEqual({
        project: result.project,
        platform: "openclaw",
      });
    });
  });

  it("codex platform writes ~/.codex/config.toml with agenr entry and project env", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async (homeDir) => {
      const result = await runInitCommand({ path: dir, platform: "codex" });
      const configPath = path.join(homeDir, ".codex", "config.toml");
      expect(result.mcpPath).toBe(configPath);
      expect(await pathExists(configPath)).toBe(true);
      expect(await pathExists(path.join(dir, ".mcp.json"))).toBe(false);

      const toml = await fs.readFile(configPath, "utf8");
      expect(toml).toContain("[mcp]");
      expect(toml).toContain(`command = "${escapeTomlString(process.execPath)}"`);
      expect(toml).toContain(`args = ["${escapeTomlString(process.argv[1] as string)}", "mcp"]`);
      expect(toml).toContain(`AGENR_PROJECT_DIR = "${path.resolve(dir)}"`);
      expect(toml).not.toContain("OPENAI_API_KEY");
    });
  });

  it("re-running init for codex is idempotent and does not duplicate agenr line", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    await withTempHome(async (homeDir) => {
      await runInitCommand({ path: dir, platform: "codex" });
      await runInitCommand({ path: dir, platform: "codex" });

      const configPath = path.join(homeDir, ".codex", "config.toml");
      const toml = await fs.readFile(configPath, "utf8");
      const agenrLines = toml
        .split(/\r?\n/)
        .filter((line) => line.trimStart().startsWith("agenr ="));
      expect(agenrLines).toHaveLength(1);
    });
  });

  it("uses .cursorrules for cursor when present", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, ".cursor"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cursorrules"), "legacy\n", "utf8");

    const result = await runInitCommand({ path: dir });
    expect(result.platform).toBe("cursor");
    expect(result.instructionsPath).toBe(path.join(dir, ".cursorrules"));
  });

  it("derives slug from directory name with spaces and special chars", async () => {
    const root = await createTempDir("agenr-init-parent-");
    tempDirs.push(root);
    const projectDir = path.join(root, "My Agenr Project!!!");
    await fs.mkdir(projectDir, { recursive: true });

    const result = await runInitCommand({ path: projectDir });
    expect(result.project).toBe("my-agenr-project");

    const config = await readJson(path.join(projectDir, ".agenr", "config.json"));
    expect(config.project).toBe("my-agenr-project");
  });

  it("writes .agenr/config.json with project, platform, projectDir, and dependencies", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });

    const result = await withTempHome(async () => {
      return await runInitCommand({
        path: dir,
        dependsOn: "api-service,shared-lib",
      });
    });

    const configPath = path.join(dir, ".agenr", "config.json");
    const config = await readJson(configPath);
    expect(config.project).toBe(result.project);
    expect(config.platform).toBe("claude-code");
    expect(config.projectDir).toBe(path.resolve(dir));
    expect(config.dependencies).toEqual(["api-service", "shared-lib"]);
  });

  it("writes MCP config with AGENR_PROJECT_DIR env and preserves other tools", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const mcpPath = path.join(dir, ".mcp.json");
    await fs.writeFile(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "other", args: ["x"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await runInitCommand({ path: dir });

    const config = await readJson(mcpPath);
    const mcpServers = config.mcpServers as Record<string, unknown>;
    expect(mcpServers.other).toEqual({ command: "other", args: ["x"] });
    expect(mcpServers.agenr).toEqual({
      command: process.execPath,
      args: [process.argv[1], "mcp"],
      env: {
        AGENR_PROJECT_DIR: path.resolve(dir),
      },
    });
  });

  it("wraps agenr MCP config under mcpServers when existing config has no mcpServers key", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const mcpPath = path.join(dir, ".mcp.json");
    await fs.writeFile(
      mcpPath,
      JSON.stringify(
        {
          custom: true,
          agenr: { command: "legacy-agenr" },
        },
        null,
        2,
      ),
      "utf8",
    );

    await runInitCommand({ path: dir });

    const config = await readJson(mcpPath);
    expect(config.custom).toBe(true);
    expect(config.agenr).toBeUndefined();
    expect(config.mcpServers).toEqual({
      agenr: {
        command: process.execPath,
        args: [process.argv[1], "mcp"],
        env: {
          AGENR_PROJECT_DIR: path.resolve(dir),
        },
      },
    });
  });

  it("adds .agenr/knowledge.db to .gitignore when file exists", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const gitignorePath = path.join(dir, ".gitignore");
    await fs.writeFile(gitignorePath, "node_modules/\n", "utf8");

    await runInitCommand({ path: dir });
    const content = await fs.readFile(gitignorePath, "utf8");
    expect(content).toContain(".agenr/knowledge.db");
  });

  it("creates .gitignore and adds .agenr/knowledge.db when file is missing", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const gitignorePath = path.join(dir, ".gitignore");

    await runInitCommand({ path: dir });

    expect(await pathExists(gitignorePath)).toBe(true);
    const content = await fs.readFile(gitignorePath, "utf8");
    expect(content).toContain(".agenr/knowledge.db");
  });

  it("does not add AGENTS.md to .gitignore for generic platform", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const gitignorePath = path.join(dir, ".gitignore");
    await fs.writeFile(gitignorePath, "node_modules/\n", "utf8");

    await runInitCommand({ path: dir, platform: "generic" });

    const content = await fs.readFile(gitignorePath, "utf8");
    expect(content).toContain(".agenr/knowledge.db");
    expect(content).not.toContain("AGENTS.md");
  });

  it("is idempotent on re-run: markers stay single, config merges, dependencies persist without --depends-on", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# Existing\n", "utf8");
    await fs.mkdir(path.join(dir, ".agenr"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".agenr", "config.json"),
      JSON.stringify(
        {
          customKey: "keep-me",
          dependencies: ["api-service"],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(dir, ".gitignore"), "", "utf8");

    await runInitCommand({ path: dir, project: "frontend", dependsOn: "api-service,shared-lib" });
    await runInitCommand({ path: dir, project: "frontend" });

    const instructions = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    const markerStarts = (instructions.match(/<!-- agenr:start -->/g) ?? []).length;
    const markerEnds = (instructions.match(/<!-- agenr:end -->/g) ?? []).length;
    expect(markerStarts).toBe(1);
    expect(markerEnds).toBe(1);

    const config = await readJson(path.join(dir, ".agenr", "config.json"));
    expect(config.customKey).toBe("keep-me");
    expect(config.project).toBe("frontend");
    expect(config.dependencies).toEqual(["api-service", "shared-lib"]);

    const gitignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    const gitignoreEntries = gitignore.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const dbEntries = gitignoreEntries.filter((line) => line === ".agenr/knowledge.db");
    expect(dbEntries).toHaveLength(1);
  });

  it("merges --depends-on with existing dependencies", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ project: "frontend", dependencies: ["api-service"] }),
      "utf8",
    );

    const result = await runInitCommand({ path: dir, dependsOn: "shared-lib" });
    expect(result.dependencies).toContain("api-service");
    expect(result.dependencies).toContain("shared-lib");
    expect(result.dependencies).toHaveLength(2);
  });

  it("deduplicates dependencies on re-run", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);
    const configDir = path.join(dir, ".agenr");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ project: "frontend", dependencies: ["api-service"] }),
      "utf8",
    );

    const result = await runInitCommand({ path: dir, dependsOn: "api-service,shared-lib" });
    expect(result.dependencies).toEqual(["api-service", "shared-lib"]);
  });

  it("throws when run from home directory", async () => {
    await expect(runInitCommand({ path: os.homedir() })).rejects.toThrow(
      "Cannot initialize agenr in your home directory",
    );
  });
});

describe("runInitWizard", () => {
  function mockSetupResult(overrides?: { auth?: string; model?: string }) {
    return {
      auth: (overrides?.auth ?? "openai-api-key") as
        | "openai-api-key"
        | "anthropic-api-key"
        | "anthropic-oauth"
        | "anthropic-token"
        | "openai-subscription",
      provider: "openai" as const,
      model: overrides?.model ?? "gpt-4.1-mini",
      config: {
        auth: "openai-api-key" as const,
        provider: "openai" as const,
        model: "gpt-4.1-mini",
      },
      changed: true,
    };
  }

  function mockInitResult() {
    return {
      platform: "openclaw" as const,
      project: "agenr",
      projectDir: "/tmp/project",
      dependencies: [],
      configPath: "/tmp/project/.agenr/config.json",
      instructionsPath: "/tmp/project/AGENTS.md",
      mcpPath: "/tmp/project/.mcp.json",
      mcpSkipped: false,
      gitignoreUpdated: false,
    };
  }

  function platformList(openclawDetected: boolean, codexDetected: boolean) {
    return [
      {
        id: "openclaw" as const,
        label: "OpenClaw",
        detected: openclawDetected,
        configDir: resolveDefaultOpenClawConfigDir(),
        sessionsDir: path.join(resolveDefaultOpenClawConfigDir(), "agents", "main", "sessions"),
      },
      {
        id: "codex" as const,
        label: "Codex",
        detected: codexDetected,
        configDir: resolveDefaultCodexConfigDir(),
        sessionsDir: path.join(resolveDefaultCodexConfigDir(), "sessions"),
      },
    ];
  }

  async function createWizardProjectDir(config?: Record<string, unknown>): Promise<string> {
    const dir = await createTempDir("agenr-init-wizard-");
    tempDirs.push(dir);
    if (config) {
      await fs.mkdir(path.join(dir, ".agenr"), { recursive: true });
      await fs.writeFile(path.join(dir, ".agenr", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
    }
    return dir;
  }

  async function writeGlobalProjectsConfig(
    projects: Record<string, { project: string; platform: string; dbPath?: string }>,
  ): Promise<void> {
    const configPath = getIsolatedConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify({ projects }, null, 2)}\n`, "utf8");
  }

  it("runs non-interactive path when isInteractive is false", async () => {
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "formatInitSummary").mockReturnValue(["line one", "line two"]);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInitWizard({ isInteractive: false });

    expect(runInitCommandSpy).toHaveBeenCalledOnce();
    expect(clackIntroMock).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith("line one\n");
    expect(writeSpy).toHaveBeenCalledWith("line two\n");
  });

  it("runs non-interactive when --platform flag provided", async () => {
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "formatInitSummary").mockReturnValue(["line one"]);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInitWizard({ isInteractive: true, platform: "generic" });

    expect(runInitCommandSpy).toHaveBeenCalledOnce();
    expect(clackIntroMock).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith("line one\n");
  });

  it("runs non-interactive when --project flag provided", async () => {
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "formatInitSummary").mockReturnValue(["line one"]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runInitWizard({ isInteractive: true, project: "agenr" });

    expect(runInitCommandSpy).toHaveBeenCalledOnce();
    expect(clackIntroMock).not.toHaveBeenCalled();
  });

  it("shows existing config and skips setup when user declines reconfigure", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    formatExistingConfigMock.mockReturnValue("current config");
    clackConfirmMock.mockResolvedValue(false);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith("current config", "Current config");
    expect(runSetupCoreMock).not.toHaveBeenCalled();
    expect(clackOutroMock).toHaveBeenCalledWith("Setup unchanged.");
  });

  it("current config box includes projects before reconfigure prompt", async () => {
    await withTempHome(async (homeDir) => {
      const dir = await createWizardProjectDir();
      const existingConfig = {
        auth: "openai-api-key" as const,
        provider: "openai" as const,
        model: "gpt-4.1-mini",
        projects: {
          "/tmp/.openclaw": {
            project: "openclaw",
            platform: "openclaw",
          },
          "/tmp/.openclaw-sandbox": {
            project: "openclaw",
            platform: "openclaw",
            dbPath: "/tmp/.openclaw-sandbox/agenr-data/knowledge.db",
          },
        },
      };
      readConfigMock.mockReturnValue(existingConfig);
      formatExistingConfigMock.mockReturnValue(
        [
          "Auth:     OpenAI API key",
          "Provider: openai",
          "Model:    gpt-4.1-mini",
          "",
          "Projects:",
          "  openclaw",
          "    Directory: /tmp/.openclaw",
          "    Database:  ~/.agenr/knowledge.db (shared)",
        ].join("\n"),
      );
      clackConfirmMock.mockResolvedValue(false);

      await runInitWizard({ isInteractive: true, path: dir });

      expect(formatExistingConfigMock).toHaveBeenCalledWith(
        existingConfig,
        path.join(homeDir, ".agenr", "knowledge.db"),
      );
      expect(clackNoteMock).toHaveBeenCalledWith(expect.stringContaining("Projects:\n  openclaw"), "Current config");
    });
  });

  it("readExistingProjectSettings finds project in global config by projectDir", async () => {
    await withTempHome(async () => {
      const dir = await createWizardProjectDir();
      const globalConfigPath = getIsolatedConfigPath();
      await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
      await fs.writeFile(
        globalConfigPath,
        JSON.stringify(
          {
            projects: {
              [path.resolve(dir)]: {
                project: "openclaw-sandbox",
                platform: "openclaw",
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      readConfigMock.mockReturnValue(null);
      clackConfirmMock.mockResolvedValue(false);

      await runInitWizard({ isInteractive: true, path: dir });

      expect(clackNoteMock).toHaveBeenCalledWith(
        expect.stringContaining("Platform: OpenClaw"),
        "Current config",
      );
      expect(clackNoteMock).toHaveBeenCalledWith(
        expect.stringContaining("Project: openclaw-sandbox"),
        "Current config",
      );
    });
  });

  it("readExistingProjectSettings falls back to per-repo config", async () => {
    const dir = await createWizardProjectDir({
      project: "local-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue(null);
    clackConfirmMock.mockResolvedValue(false);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Platform: OpenClaw"),
      "Current config",
    );
    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Project: local-project"),
      "Current config",
    );
  });

  it("readExistingProjectSettings returns empty when no config exists", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("openclaw");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).not.toHaveBeenCalledWith(expect.any(String), "Current config");
    expect(clackConfirmMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Reconfigure?" }),
    );
  });

  it("wizard suggests single detected platform", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackConfirmMock).toHaveBeenCalledWith({
      message: `Detected OpenClaw at ${resolveDefaultOpenClawConfigDir()}. Use this platform?`,
      initialValue: true,
    });
  });

  it("wizard shows OpenClaw directory prompt with detected path as default", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "OpenClaw directory:",
        initialValue: resolveDefaultOpenClawConfigDir(),
        placeholder: resolveDefaultOpenClawConfigDir(),
      }),
    );
  });

  it("wizard defaults project slug to openclaw when OpenClaw platform selected", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);

    await runInitWizard({ isInteractive: true, path: dir });

    const projectPrompt = clackTextMock.mock.calls
      .map((call) => call[0] as { message?: string; initialValue?: string })
      .find((call) => call.message === "Project name:");
    expect(projectPrompt?.initialValue).toBe("openclaw");
  });

  it("wizard shows selector when both platforms detected", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("codex");
    clackTextMock.mockResolvedValue("agenr");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackSelectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Which platform are you using?",
      }),
    );
  });

  it("wizard defaults project slug to codex when Codex platform selected", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("codex");

    await runInitWizard({ isInteractive: true, path: dir });

    const projectPrompt = clackTextMock.mock.calls
      .map((call) => call[0] as { message?: string; initialValue?: string })
      .find((call) => call.message === "Project name:");
    expect(projectPrompt?.initialValue).toBe("codex");
  });

  it("wizard still derives slug from cwd for other platforms", () => {
    const slug = resolveWizardProjectSlug("/tmp/My Sample Project", "generic");
    expect(slug).toBe("my-sample-project");
  });

  it("wizard updates sessionsDir when custom OpenClaw path provided", async () => {
    const dir = await createWizardProjectDir();
    const platforms = platformList(false, false);
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platforms);
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce("/tmp/custom-openclaw").mockResolvedValueOnce("agenr");

    await runInitWizard({ isInteractive: true, path: dir });

    // The wizard spreads into a new object, so verify via runInitCommand args
    expect(runInitCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: path.resolve("/tmp/custom-openclaw"),
      }),
    );
  });

  it("wizard uses OpenClaw configDir as projectDir", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    clackConfirmMock.mockResolvedValue(true);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(runInitCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: resolveDefaultOpenClawConfigDir(),
      }),
    );
  });

  it("wizard uses Codex configDir as projectDir", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    clackSelectMock.mockResolvedValue("codex");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(runInitCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: resolveDefaultCodexConfigDir(),
      }),
    );
  });

  it("wizard uses custom OpenClaw path as projectDir", async () => {
    const dir = await createWizardProjectDir();
    const customOpenclawDir = "/tmp/.openclaw-sandbox";
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("isolated");
    clackTextMock.mockResolvedValueOnce(customOpenclawDir).mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(runInitCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: path.resolve(customOpenclawDir),
      }),
    );
  });

  it("wizard keeps cwd as projectDir for coding platforms", () => {
    const cwdProjectDir = "/tmp/my-project";
    expect(resolveWizardProjectDir(cwdProjectDir, "cursor", "/tmp/.cursor")).toBe(cwdProjectDir);
  });

  it("wizard skips DB isolation step when OpenClaw directory is default", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackSelectMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Database: use shared brain (~/.agenr/knowledge.db) or isolated?",
      }),
    );
  });

  it("wizard shows DB isolation step for custom OpenClaw directory", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce("/tmp/.openclaw-sandbox").mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackSelectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Database: use shared brain (~/.agenr/knowledge.db) or isolated?",
        options: [
          expect.objectContaining({ label: "Isolated (separate database for this instance)" }),
          expect.objectContaining({ label: "Shared (all instances use the same knowledge)" }),
        ],
      }),
    );
  });

  it("wizard defaults to Isolated for custom OpenClaw directory", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce("/tmp/.openclaw-sandbox").mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    const dbPrompt = clackSelectMock.mock.calls
      .map((call) => call[0] as { message?: string; options?: Array<{ value: string }> })
      .find((call) => call.message === "Database: use shared brain (~/.agenr/knowledge.db) or isolated?");
    expect(dbPrompt?.options?.[0]?.value).toBe("isolated");
  });

  it("wizard sets isolated DB path from custom OpenClaw directory", async () => {
    const dir = await createWizardProjectDir();
    const customDir = "/tmp/.openclaw-sandbox";
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("isolated");
    clackTextMock.mockResolvedValueOnce(customDir).mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackLogInfoMock).toHaveBeenCalledWith(
      expect.stringContaining(`Database path: ${path.join(path.resolve(customDir), "agenr-data", "knowledge.db")}`),
    );
  });

  it("wizard shows shared DB in summary when shared selected", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce("/tmp/.openclaw-shared").mockResolvedValueOnce("openclaw");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Database:     ~/.agenr/knowledge.db (shared)"),
      "Setup summary",
    );
  });

  it("wizard summary shows ~/.agenr/config.json for openclaw", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    clackConfirmMock.mockResolvedValue(true);

    await withTempHome(async (homeDir) => {
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue({
        ...mockInitResult(),
        platform: "openclaw",
        configPath: path.join(homeDir, ".agenr", "config.json"),
      });

      await runInitWizard({ isInteractive: true, path: dir });
    });

    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Config:       ~/.agenr/config.json"),
      "Setup summary",
    );
  });

  it("formatRegisteredProjects shows project slug from entry", async () => {
    const dir = await createWizardProjectDir();
    const sandboxDir = await createTempDir("openclaw-sandbox-");
    tempDirs.push(sandboxDir);
    await writeGlobalProjectsConfig({
      "/tmp/.codex-main": {
        project: "openclaw",
        platform: "codex",
      },
    });
    formatExistingConfigMock.mockReturnValue("current config");
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce(sandboxDir).mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    const registeredProjectsNote = clackNoteMock.mock.calls.find((call) => call[1] === "Registered projects");
    expect(registeredProjectsNote?.[0]).toContain("openclaw");
    expect(registeredProjectsNote?.[0]).toContain("/tmp/.codex-main");
    expect(registeredProjectsNote?.[0]).toContain("openclaw-sandbox");
    expect(registeredProjectsNote?.[0]).toContain(path.resolve(sandboxDir));
  });

  it("summary hides registered projects when only 1 exists", async () => {
    const dir = await createWizardProjectDir();
    const sandboxDir = await createTempDir("openclaw-sandbox-");
    tempDirs.push(sandboxDir);
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce(sandboxDir).mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock.mock.calls.some((call) => call[1] === "Registered projects")).toBe(false);
  });

  it("registered projects shows database isolation status", async () => {
    const dir = await createWizardProjectDir();
    const sandboxDir = await createTempDir("openclaw-sandbox-");
    tempDirs.push(sandboxDir);
    await writeGlobalProjectsConfig({
      "/tmp/.openclaw": {
        project: "shared-main",
        platform: "openclaw",
      },
    });
    formatExistingConfigMock.mockReturnValue("current config");
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("isolated");
    clackTextMock.mockResolvedValueOnce(sandboxDir).mockResolvedValueOnce("isolated-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    const registeredProjectsNote = clackNoteMock.mock.calls.find((call) => call[1] === "Registered projects");
    expect(registeredProjectsNote?.[0]).toContain("(shared)");
    expect(registeredProjectsNote?.[0]).toContain("(isolated)");
  });

  it("wizard hard-blocks same project slug on shared DB and re-prompts project name", async () => {
    const dir = await createWizardProjectDir();
    const sandboxDir = await createTempDir("openclaw-sandbox-");
    tempDirs.push(sandboxDir);
    await writeGlobalProjectsConfig({
      "/tmp/.openclaw-main": {
        project: "openclaw",
        platform: "openclaw",
      },
    });
    formatExistingConfigMock.mockReturnValue("current config");
    readConfigMock.mockImplementationOnce(() => null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce(sandboxDir).mockResolvedValueOnce("OpenClaw").mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackLogWarnMock).toHaveBeenCalledWith(expect.stringContaining("Entries from these instances will be completely indistinguishable."));
    expect(clackLogInfoMock).toHaveBeenCalledWith(
      "Choose a different project name, or restart and select an isolated database for this instance.",
    );
    expect(clackConfirmMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Detected OpenClaw at /tmp/.openclaw-sandbox. Use this platform?",
      }),
    );
    const projectPrompts = clackTextMock.mock.calls
      .map((call) => call[0] as { message?: string })
      .filter((call) => call.message === "Project name:");
    expect(projectPrompts).toHaveLength(2);
    expect(runInitCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "openclaw-sandbox",
      }),
    );
  });

  it("wizard shows shared DB info when other projects share the DB", async () => {
    const dir = await createWizardProjectDir();
    const sandboxDir = await createTempDir("openclaw-sandbox-");
    tempDirs.push(sandboxDir);
    await writeGlobalProjectsConfig({
      "/tmp/.openclaw-main": {
        project: "other-shared",
        platform: "openclaw",
      },
    });
    formatExistingConfigMock.mockReturnValue("current config");
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
    clackTextMock.mockResolvedValueOnce(sandboxDir).mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackLogInfoMock).toHaveBeenCalledWith(
      expect.stringContaining("This project shares the knowledge database with:\n  - other-shared (/tmp/.openclaw-main)"),
    );
  });

  it("wizard does not show shared DB info for isolated projects", async () => {
    const dir = await createWizardProjectDir();
    const sandboxDir = await createTempDir("openclaw-sandbox-");
    tempDirs.push(sandboxDir);
    await writeGlobalProjectsConfig({
      "/tmp/.openclaw-main": {
        project: "other-shared",
        platform: "openclaw",
      },
    });
    formatExistingConfigMock.mockReturnValue("current config");
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("isolated");
    clackTextMock.mockResolvedValueOnce(sandboxDir).mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(
      clackLogInfoMock.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("This project shares the knowledge database with:"),
      ),
    ).toBe(false);
  });

  it("wizard shows isolated DB path without manual plugin hint", async () => {
    const dir = await createWizardProjectDir();
    const customDir = "/tmp/.openclaw-sandbox";
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("isolated");
    clackTextMock.mockResolvedValueOnce(customDir).mockResolvedValueOnce("openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining(`${path.join(path.resolve(customDir), "agenr-data", "knowledge.db")} (isolated)`),
      "Setup summary",
    );
    expect(
      clackLogInfoMock.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("To use the isolated database, add to your OpenClaw plugin config:"),
      ),
    ).toBe(false);
  });

  it("wizard shows selector when no platform detected", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("openclaw");
    clackTextMock.mockResolvedValue("agenr");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackSelectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Which platform are you using?",
        options: [
          expect.objectContaining({ label: "OpenClaw" }),
          expect.objectContaining({ label: "Codex" }),
        ],
      }),
    );
    expect(clackLogInfoMock).toHaveBeenCalledWith("No known platform config detected. More platforms coming soon.");
  });

  it("reconfigure mode shows keep current for auth", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("keep").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackSelectMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: "Auth: OpenAI API key (current)",
        options: [
          expect.objectContaining({ label: "Keep current" }),
          expect.objectContaining({ label: "Change..." }),
        ],
      }),
    );
  });

  it("reconfigure mode shows keep current for platform", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("keep").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackSelectMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: "Platform: OpenClaw (current)",
        options: [
          expect.objectContaining({ label: "Keep current" }),
          expect.objectContaining({ label: "Change..." }),
        ],
      }),
    );
  });

  it("reconfigure mode tracks auth change in WizardChanges", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    runSetupCoreMock.mockResolvedValue(mockSetupResult({ auth: "anthropic-api-key", model: "gpt-4.1-mini" }));
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("change").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(expect.stringContaining("Auth method updated"), "Changes");
  });

  it("reconfigure mode tracks model change in WizardChanges", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    runSetupCoreMock.mockResolvedValue(mockSetupResult({ auth: "openai-api-key", model: "gpt-4.1" }));
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("change").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("Model changed: gpt-4.1-mini -> gpt-4.1"),
      "Changes",
    );
  });

  it("wizard detects directory change on reconfigure", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
      projects: {
        [resolveDefaultOpenClawConfigDir()]: {
          project: "my-project",
          platform: "openclaw",
        },
      },
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock
      .mockResolvedValueOnce("keep")
      .mockResolvedValueOnce("keep")
      .mockResolvedValueOnce("shared")
      .mockResolvedValueOnce("keep");
    clackTextMock.mockResolvedValueOnce("/tmp/.openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(expect.stringContaining("OpenClaw directory changed"), "Changes");
  });

  it("wizard detects dbPath change on reconfigure", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    const customDir = "/tmp/.openclaw-sandbox";
    const isolatedDbPath = path.join(path.resolve(customDir), "agenr-data", "knowledge.db");
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
      projects: {
        [path.resolve(customDir)]: {
          project: "my-project",
          platform: "openclaw",
        },
      },
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock
      .mockResolvedValueOnce("keep")
      .mockResolvedValueOnce("keep")
      .mockResolvedValueOnce("isolated")
      .mockResolvedValueOnce("keep");
    clackTextMock.mockResolvedValueOnce(customDir);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(
      expect.stringContaining(`Database: isolated at ${isolatedDbPath}`),
      "Changes",
    );
  });

  it("reconfigure tracks embeddingsKeyChanged when key changes", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    runSetupCoreMock.mockResolvedValue(mockSetupResult({ auth: "anthropic-api-key", model: "gpt-4.1-mini" }));
    resolveEmbeddingApiKeyMock.mockImplementationOnce(() => "old-key").mockImplementationOnce(() => "new-key");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("change").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith(expect.stringContaining("Embeddings API key updated"), "Changes");
  });

  it("reconfigure does not set embeddingsKeyChanged when key is unchanged", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    runSetupCoreMock.mockResolvedValue(mockSetupResult({ auth: "anthropic-api-key", model: "gpt-4.1-mini" }));
    resolveEmbeddingApiKeyMock.mockImplementation(() => "same-key");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("change").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    const changesNote = clackNoteMock.mock.calls.find((call) => call[1] === "Changes");
    expect(changesNote?.[0]).not.toContain("Embeddings API key updated");
  });

  it("reconfigure shows embeddings status when auth is kept", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    resolveEmbeddingApiKeyMock.mockImplementation(() => "existing-key");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("keep").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining("Embeddings:"));
    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining("configured"));
  });

  it("reconfigure mode does NOT set changes when user keeps everything", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
      projects: {
        [resolveDefaultOpenClawConfigDir()]: {
          project: "my-project",
          platform: "openclaw",
        },
      },
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("keep").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackNoteMock).toHaveBeenCalledWith("No changes detected.", "Changes");
  });

  it("wizard does not log raw JSON for changes", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    runSetupCoreMock.mockResolvedValue(mockSetupResult({ auth: "anthropic-api-key", model: "gpt-4.1" }));
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("change").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    const logMessages = clackLogInfoMock.mock.calls
      .map((call) => call[0])
      .filter((value): value is string => typeof value === "string");
    expect(logMessages.some((message) => message.includes("Wizard changes:"))).toBe(false);
    expect(logMessages.some((message) => message.includes("\"authChanged\""))).toBe(false);
  });

  it("handles Ctrl+C gracefully at reconfigure prompt", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    formatExistingConfigMock.mockReturnValue("current config");
    clackConfirmMock.mockResolvedValue(clackCancelToken);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(runSetupCoreMock).not.toHaveBeenCalled();
    expect(clackCancelMock).toHaveBeenCalledWith("Setup cancelled.");
  });

  it("wizard handles Ctrl+C at platform selection", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    clackSelectMock.mockResolvedValue(clackCancelToken);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackCancelMock).toHaveBeenCalledWith("Setup cancelled.");
  });

  it("wizard handles Ctrl+C at OpenClaw directory prompt", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackSelectMock.mockResolvedValue("openclaw");
    clackTextMock.mockResolvedValue(clackCancelToken);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackCancelMock).toHaveBeenCalledWith("Setup cancelled.");
    expect(runInitCommandSpy).not.toHaveBeenCalled();
  });

  it("wizard handles Ctrl+C at DB isolation prompt", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    const runInitCommandSpy = vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce(clackCancelToken);
    clackTextMock.mockResolvedValueOnce("/tmp/.openclaw-sandbox");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackCancelMock).toHaveBeenCalledWith("Setup cancelled.");
    expect(runInitCommandSpy).not.toHaveBeenCalled();
  });

  it("wizard handles Ctrl+C at project slug input", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("openclaw");
    clackTextMock.mockResolvedValueOnce(resolveDefaultOpenClawConfigDir()).mockResolvedValueOnce(clackCancelToken);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackCancelMock).toHaveBeenCalledWith("Setup cancelled.");
  });

  it("project slug validation rejects empty input", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("openclaw");

    await runInitWizard({ isInteractive: true, path: dir });

    const textCall = clackTextMock.mock.calls
      .map((call) => call[0] as { message?: string; validate?: (value: string) => string | undefined })
      .find((call) => call.message === "Project name:");

    expect(textCall?.validate?.("   ")).toBe("Project name is required");
    expect(textCall?.validate?.("___")).toBe("Project name must include letters or numbers");
    expect(textCall?.validate?.("my-project")).toBeUndefined();
  });

  it("calls runSetupCore when no existing config", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("openclaw");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(runSetupCoreMock).toHaveBeenCalledWith({
      env: process.env,
      existingConfig: null,
      skipIntroOutro: true,
    });
  });

  it("wizard installs openclaw plugin with spinner", async () => {
    const dir = await createWizardProjectDir();
    const installSpy = vi.spyOn(initWizardRuntime, "installOpenClawPlugin").mockResolvedValue({
      success: true,
      message: "agenr plugin already installed",
    });
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackSpinnerStartMock).toHaveBeenCalledWith("Installing agenr plugin for OpenClaw...");
    expect(installSpy).toHaveBeenCalledWith(resolveDefaultOpenClawConfigDir());
  });

  it("wizard skips plugin install for codex platform", async () => {
    const dir = await createWizardProjectDir();
    const installSpy = vi.spyOn(initWizardRuntime, "installOpenClawPlugin");
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue({
      ...mockInitResult(),
      platform: "codex",
    });
    clackSelectMock.mockResolvedValue("codex");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(installSpy).not.toHaveBeenCalled();
  });

  it("wizard writes dbPath to openclaw.json for isolated DB", async () => {
    const dir = await createWizardProjectDir();
    const customDir = "/tmp/.openclaw-isolated";
    const writeSpy = vi.spyOn(initWizardRuntime, "writeOpenClawPluginDbPath");
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock
      .mockResolvedValueOnce("openclaw")
      .mockResolvedValueOnce("isolated");
    clackTextMock
      .mockResolvedValueOnce(customDir)
      .mockResolvedValueOnce("openclaw-isolated");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(writeSpy).toHaveBeenCalledWith(
      path.resolve(customDir),
      path.join(path.resolve(customDir), "agenr-data", "knowledge.db"),
    );
  });

  it("wizard calls writeOpenClawPluginDbPath with undefined dbPath for shared DB", async () => {
    const dir = await createWizardProjectDir();
    const customDir = "/tmp/.openclaw-shared";
    const writeSpy = vi.spyOn(initWizardRuntime, "writeOpenClawPluginDbPath");
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock
      .mockResolvedValueOnce("openclaw")
      .mockResolvedValueOnce("shared");
    clackTextMock
      .mockResolvedValueOnce(customDir)
      .mockResolvedValueOnce("openclaw-shared");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(writeSpy).toHaveBeenCalledWith(
      path.resolve(customDir),
      undefined,
    );
  });

  it("wizard offers re-ingest when model changed", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    runSetupCoreMock.mockResolvedValue(mockSetupResult({ model: "gpt-4.1" }));
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock
      .mockResolvedValueOnce("change")
      .mockResolvedValueOnce("keep")
      .mockResolvedValueOnce("keep")
      .mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(
      clackSelectMock.mock.calls.some(
        (call) =>
          typeof (call[0] as { message?: unknown }).message === "string" &&
          ((call[0] as { message: string }).message ===
            "WARNING: Re-ingest will permanently delete all existing entries."),
      ),
    ).toBe(true);
  });

  it("wizard does NOT offer re-ingest when nothing changed", async () => {
    const dir = await createWizardProjectDir({
      project: "my-project",
      platform: "openclaw",
    });
    readConfigMock.mockReturnValue({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("keep").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(
      clackSelectMock.mock.calls.some(
        (call) =>
          (call[0] as { message?: string }).message ===
          "WARNING: Re-ingest will permanently delete all existing entries.",
      ),
    ).toBe(false);
  });

  it("wizard stops daemon before db reset during re-ingest", async () => {
    await withMockedPlatform("darwin", async () => {
      const dir = await createWizardProjectDir({
        project: "my-project",
        platform: "openclaw",
      });
      const stopSpy = vi.spyOn(initWizardRuntime, "runDaemonStopCommand").mockResolvedValue({ exitCode: 0 });
      const resetSpy = vi.spyOn(initWizardRuntime, "runDbResetCommand").mockResolvedValue({ exitCode: 0 });
      readConfigMock.mockReturnValue({
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      describeAuthMock.mockReturnValue("OpenAI API key");
      formatExistingConfigMock.mockReturnValue("auth summary");
      runSetupCoreMock.mockResolvedValue(mockSetupResult({ model: "gpt-4.1" }));
      vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
      clackConfirmMock.mockResolvedValue(true);
      clackSelectMock
        .mockResolvedValueOnce("change")
        .mockResolvedValueOnce("keep")
        .mockResolvedValueOnce("keep")
        .mockResolvedValueOnce("reingest");

      await runInitWizard({ isInteractive: true, path: dir });

      expect(stopSpy).toHaveBeenCalled();
      expect(resetSpy).toHaveBeenCalledWith({
        full: true,
        confirmReset: true,
      });
      expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(resetSpy.mock.invocationCallOrder[0]);
    });
  });

  it("wizard passes db option to runDbResetCommand for isolated DB", async () => {
    await withMockedPlatform("darwin", async () => {
      const dir = await createWizardProjectDir({
        project: "my-project",
        platform: "openclaw",
      });
      const customDir = "/tmp/.openclaw-reingest";
      const resetSpy = vi.spyOn(initWizardRuntime, "runDbResetCommand").mockResolvedValue({ exitCode: 0 });
      readConfigMock.mockReturnValue({
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      describeAuthMock.mockReturnValue("OpenAI API key");
      formatExistingConfigMock.mockReturnValue("auth summary");
      runSetupCoreMock.mockResolvedValue(mockSetupResult({ model: "gpt-4.1" }));
      vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
      clackConfirmMock.mockResolvedValue(true);
      clackSelectMock
        .mockResolvedValueOnce("change")
        .mockResolvedValueOnce("keep")
        .mockResolvedValueOnce("isolated")
        .mockResolvedValueOnce("keep")
        .mockResolvedValueOnce("reingest");
      clackTextMock.mockResolvedValueOnce(customDir);

      await runInitWizard({ isInteractive: true, path: dir });

      expect(resetSpy).toHaveBeenCalledWith({
        full: true,
        confirmReset: true,
        db: path.join(path.resolve(customDir), "agenr-data", "knowledge.db"),
      });
    });
  });

  it("wizard passes recent file paths for recent ingest", async () => {
    const dir = await createWizardProjectDir();
    const ingestSpy = vi.spyOn(initWizardRuntime, "runIngestCommand").mockResolvedValue({
      exitCode: 0,
      filesProcessed: 2,
      filesSkipped: 0,
      filesFailed: 0,
      totalEntriesExtracted: 5,
      totalEntriesStored: 0,
      dedupStats: {
        entries_added: 0,
        entries_updated: 0,
        entries_skipped: 0,
        entries_reinforced: 0,
        entries_superseded: 0,
        dedup_llm_calls: 0,
      },
      durationMs: 0,
      results: [],
    });
    vi.spyOn(initWizardRuntime, "scanSessionFiles").mockResolvedValue({
      totalFiles: 3,
      recentFiles: ["/tmp/one.jsonl", "/tmp/two.jsonl"],
      allFiles: ["/tmp/one.jsonl", "/tmp/two.jsonl", "/tmp/three.jsonl"],
      totalSizeBytes: 12000,
      recentSizeBytes: 8000,
    });
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("recent");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(ingestSpy).toHaveBeenCalledWith(
      ["/tmp/one.jsonl", "/tmp/two.jsonl"],
      expect.not.objectContaining({ glob: expect.anything() }),
    );
  });

  it("wizard passes directory with glob for full ingest", async () => {
    const dir = await createWizardProjectDir();
    const ingestSpy = vi.spyOn(initWizardRuntime, "runIngestCommand").mockResolvedValue({
      exitCode: 0,
      filesProcessed: 3,
      filesSkipped: 0,
      filesFailed: 0,
      totalEntriesExtracted: 5,
      totalEntriesStored: 0,
      dedupStats: {
        entries_added: 0,
        entries_updated: 0,
        entries_skipped: 0,
        entries_reinforced: 0,
        entries_superseded: 0,
        dedup_llm_calls: 0,
      },
      durationMs: 0,
      results: [],
    });
    vi.spyOn(initWizardRuntime, "scanSessionFiles").mockResolvedValue({
      totalFiles: 3,
      recentFiles: ["/tmp/one.jsonl"],
      allFiles: ["/tmp/one.jsonl", "/tmp/two.jsonl", "/tmp/three.jsonl"],
      totalSizeBytes: 12000,
      recentSizeBytes: 4000,
    });
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("full");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(ingestSpy).toHaveBeenCalledWith(
      [path.join(resolveDefaultOpenClawConfigDir(), "agents", "main", "sessions")],
      expect.objectContaining({ glob: "**/*.jsonl*" }),
    );
  });

  it("wizard handles empty sessions directory", async () => {
    const dir = await createWizardProjectDir();
    vi.spyOn(initWizardRuntime, "scanSessionFiles").mockResolvedValue({
      totalFiles: 0,
      recentFiles: [],
      allFiles: [],
      totalSizeBytes: 0,
      recentSizeBytes: 0,
    });
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining("No sessions found yet."));
  });

  it("wizard prompts for consolidation after successful ingest", async () => {
    const dir = await createWizardProjectDir();
    const consolidateSpy = vi.spyOn(initWizardRuntime, "runConsolidateCommand");
    vi.spyOn(initWizardRuntime, "scanSessionFiles").mockResolvedValue({
      totalFiles: 1,
      recentFiles: ["/tmp/recent.jsonl"],
      allFiles: ["/tmp/recent.jsonl"],
      totalSizeBytes: 2000,
      recentSizeBytes: 2000,
    });
    vi.spyOn(initWizardRuntime, "runIngestCommand").mockResolvedValue({
      exitCode: 0,
      filesProcessed: 1,
      filesSkipped: 0,
      filesFailed: 0,
      totalEntriesExtracted: 4,
      totalEntriesStored: 4,
      dedupStats: {
        entries_added: 4,
        entries_updated: 0,
        entries_skipped: 0,
        entries_reinforced: 0,
        entries_superseded: 0,
        dedup_llm_calls: 0,
      },
      durationMs: 0,
      results: [],
    });
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    clackSelectMock.mockResolvedValueOnce("recent");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(consolidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ simThreshold: 0.76 }),
    );
  });

  it("wizard installs daemon with force:true on macOS and corrected sessionsDir", async () => {
    await withMockedPlatform("darwin", async () => {
      const dir = await createWizardProjectDir();
      const daemonSpy = vi.spyOn(initWizardRuntime, "runDaemonInstallCommand");
      readConfigMock.mockReturnValue(null);
      runSetupCoreMock.mockResolvedValue(mockSetupResult());
      vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
      clackConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      await runInitWizard({ isInteractive: true, path: dir });

      expect(daemonSpy).toHaveBeenCalledWith({
        force: true,
        interval: 120,
        dir: path.join(resolveDefaultOpenClawConfigDir(), "agents", "main", "sessions"),
        platform: "openclaw",
      });
    });
  });

  it("wizard shows manual command on Linux", async () => {
    await withMockedPlatform("linux", async () => {
      const dir = await createWizardProjectDir();
      readConfigMock.mockReturnValue(null);
      runSetupCoreMock.mockResolvedValue(mockSetupResult());
      vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
      clackConfirmMock.mockResolvedValue(true);

      await runInitWizard({ isInteractive: true, path: dir });

      expect(clackLogInfoMock).toHaveBeenCalledWith(
        expect.stringContaining("Automatic ingestion not yet supported on Linux."),
      );
    });
  });

  it("wizard summary includes plugin/ingest/watcher status and next steps for skipped items", async () => {
    await withMockedPlatform("darwin", async () => {
      const dir = await createWizardProjectDir();
      readConfigMock.mockReturnValue(null);
      runSetupCoreMock.mockResolvedValue(mockSetupResult());
      vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
      clackConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runInitWizard({ isInteractive: true, path: dir });

      const summaryNote = clackNoteMock.mock.calls.find((call) => call[1] === "Setup summary");
      expect(summaryNote?.[0]).toContain("Plugin:");
      expect(summaryNote?.[0]).toContain("Ingest:");
      expect(summaryNote?.[0]).toContain("Watcher:");
      expect(
        clackNoteMock.mock.calls.some(
          (call) =>
            call[1] === "Next steps" &&
            typeof call[0] === "string" &&
            call[0].includes("Run ingest: agenr ingest"),
        ),
      ).toBe(true);
    });
  });

  it("wizard omits next steps when all action steps succeed", async () => {
    await withMockedPlatform("darwin", async () => {
      const dir = await createWizardProjectDir();
      vi.spyOn(initWizardRuntime, "scanSessionFiles").mockResolvedValue({
        totalFiles: 1,
        recentFiles: ["/tmp/recent.jsonl"],
        allFiles: ["/tmp/recent.jsonl"],
        totalSizeBytes: 2000,
        recentSizeBytes: 2000,
      });
      vi.spyOn(initWizardRuntime, "runIngestCommand").mockResolvedValue({
        exitCode: 0,
        filesProcessed: 1,
        filesSkipped: 0,
        filesFailed: 0,
        totalEntriesExtracted: 4,
        totalEntriesStored: 4,
        dedupStats: {
          entries_added: 4,
          entries_updated: 0,
          entries_skipped: 0,
          entries_reinforced: 0,
          entries_superseded: 0,
          dedup_llm_calls: 0,
        },
        durationMs: 0,
        results: [],
      });
      readConfigMock.mockReturnValue(null);
      runSetupCoreMock.mockResolvedValue(mockSetupResult());
      vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
      clackConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      clackSelectMock.mockResolvedValueOnce("recent");

      await runInitWizard({ isInteractive: true, path: dir });

      expect(clackNoteMock.mock.calls.some((call) => call[1] === "Next steps")).toBe(false);
    });
  });

  it("OpenClaw directory confirmation sets sessionsDir to agents/main/sessions", async () => {
    await withMockedPlatform("darwin", async () => {
      const dir = await createWizardProjectDir();
      const daemonSpy = vi.spyOn(initWizardRuntime, "runDaemonInstallCommand");
      readConfigMock.mockReturnValue(null);
      runSetupCoreMock.mockResolvedValue(mockSetupResult());
      vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
      vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
      clackSelectMock.mockResolvedValueOnce("openclaw").mockResolvedValueOnce("shared");
      clackTextMock.mockResolvedValueOnce("/tmp/custom-openclaw-dir").mockResolvedValueOnce("custom-openclaw");
      clackConfirmMock.mockResolvedValueOnce(true);

      await runInitWizard({ isInteractive: true, path: dir });

      expect(daemonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dir: path.join("/tmp/custom-openclaw-dir", ".openclaw", "agents", "main", "sessions"),
        }),
      );
    });
  });
});

describe("installOpenClawPlugin", () => {
  it("runs OpenClaw CLI calls for plugin install", async () => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();

    const targetDir = "/tmp/test-openclaw";
    execFileSyncMock.mockImplementation(
      (command: string, args: string[]) => {
        if (command === "which" && args[0] === "openclaw") {
          return "/usr/local/bin/openclaw\n";
        }
        return "";
      },
    );
    execFileMock.mockImplementation(
      (command: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (command === "/usr/local/bin/openclaw" && args[0] === "plugins" && args[1] === "install") {
          cb(new Error("already exists"), "", "");
          return;
        }
        if (command === "/usr/local/bin/openclaw" && args[0] === "plugins" && args[1] === "update") {
          cb(null, "updated", "");
          return;
        }
        if (command === "/usr/local/bin/openclaw" && args[0] === "gateway" && args[1] === "restart") {
          cb(new Error("restart failed"), "", "");
          return;
        }
        if (command === "/usr/local/bin/openclaw" && args[0] === "gateway" && args[1] === "start") {
          cb(null, "started", "");
          return;
        }
        cb(null, "", "");
      },
    );

    const result = await initWizardRuntime.installOpenClawPlugin(targetDir);
    expect(result.success).toBe(true);
    expect(result.message).toBe("Plugin installed");

    const openclawCalls = execFileMock.mock.calls.filter(
      (call: string[]) => call[0] === "/usr/local/bin/openclaw",
    );
    expect(openclawCalls).toHaveLength(2);

    expect(openclawCalls).toHaveLength(2);
  });

  it("non-default target directory does not touch default ~/.openclaw path", async () => {
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();

    await withTempHome(async (homeDir) => {
      const defaultOpenclawDir = path.join(homeDir, ".openclaw");
      const targetDir = "/tmp/test-openclaw-sandbox";

      execFileSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === "which" && args[0] === "openclaw") {
          return "/usr/local/bin/openclaw\n";
        }
        return "";
      });
      execFileMock.mockImplementation(
        (command: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          cb(null, "", "");
        },
      );

      await initWizardRuntime.installOpenClawPlugin(targetDir);

      const openclawCalls = execFileMock.mock.calls.filter(
        (call: string[]) => call[0] === "/usr/local/bin/openclaw",
      );
      expect(openclawCalls.length).toBeGreaterThan(0);

      expect(openclawCalls.length).toBeGreaterThan(0);
    });
  });
});

describe("writeOpenClawPluginDbPath", () => {
  it("adds agenr to plugins.allow when missing", async () => {
    vi.restoreAllMocks();

    const readSpy = vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        plugins: {
          entries: {
            other: { enabled: true },
          },
        },
      }),
    );
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    await initWizardRuntime.writeOpenClawPluginDbPath(
      "/tmp/test-openclaw",
      "/tmp/test-openclaw/agenr-data/knowledge.db",
    );

    expect(readSpy).toHaveBeenCalled();
    expect(mkdirSpy).toHaveBeenCalledWith("/tmp/test-openclaw/.openclaw", { recursive: true });
    expect(writeSpy).toHaveBeenCalled();

    const writtenRaw = writeSpy.mock.calls[0]?.[1];
    expect(typeof writtenRaw).toBe("string");
    const writtenConfig = JSON.parse(writtenRaw as string) as {
      plugins?: { allow?: string[]; entries?: { agenr?: { config?: { dbPath?: string } } } };
    };

    expect(writtenConfig.plugins?.allow).toEqual(["agenr"]);
    expect(writtenConfig.plugins?.entries?.agenr?.config?.dbPath).toBe(
      "/tmp/test-openclaw/agenr-data/knowledge.db",
    );
  });

  it("does not duplicate agenr in plugins.allow when already present", async () => {
    vi.restoreAllMocks();

    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        plugins: {
          allow: ["agenr"],
          entries: {
            agenr: {
              enabled: true,
              config: {},
            },
          },
        },
      }),
    );
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const writeSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    await initWizardRuntime.writeOpenClawPluginDbPath(
      "/tmp/test-openclaw",
      "/tmp/test-openclaw/agenr-data/knowledge.db",
    );

    const writtenRaw = writeSpy.mock.calls[0]?.[1];
    expect(typeof writtenRaw).toBe("string");
    const writtenConfig = JSON.parse(writtenRaw as string) as { plugins?: { allow?: string[] } };
    const allow = writtenConfig.plugins?.allow ?? [];
    expect(allow.filter((entry) => entry === "agenr")).toHaveLength(1);
  });
});

describe("resolveAgenrCommand", () => {
  it("returns process.execPath and process.argv[1] as base args", () => {
    const resolved = resolveAgenrCommand();
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.baseArgs[0]).toBe(process.argv[1]);
    expect(resolved.baseArgs).toHaveLength(1);
  });
});

describe("buildMcpEntry", () => {
  it("uses resolved command and appends mcp to base args", () => {
    const projectDir = path.resolve("/tmp/agenr-project");
    const resolved = resolveAgenrCommand();
    const entry = buildMcpEntry(projectDir, resolved);
    expect(entry).toEqual({
      command: process.execPath,
      args: [process.argv[1], "mcp"],
      env: {
        AGENR_PROJECT_DIR: projectDir,
      },
    });
  });
});

describe("formatPathForDisplay", () => {
  it("does not replace sibling-prefix paths", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/Users/al");
    expect(formatPathForDisplay("/Users/alex/foo")).toBe("/Users/alex/foo");
  });

  it("returns ~ for exact home directory", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/Users/al");
    expect(formatPathForDisplay("/Users/al")).toBe("~");
  });
});

describe("formatInitSummary", () => {
  it("shows tilde-compressed path for global instructions files", async () => {
    await withTempHome(async (homeDir) => {
      const lines = formatInitSummary({
        platform: "codex",
        project: "agenr",
        projectDir: path.resolve("/tmp/project"),
        dependencies: [],
        configPath: path.resolve("/tmp/project/.agenr/config.json"),
        instructionsPath: path.join(homeDir, ".codex", "AGENTS.md"),
        mcpPath: path.join(homeDir, ".codex", "config.toml"),
        mcpSkipped: false,
        gitignoreUpdated: false,
      });
      expect(lines).toContain("- Wrote system prompt block to ~/.codex/AGENTS.md");
    });
  });

  it("shows per-project config path for cursor", () => {
    const projectDir = path.resolve("/tmp/project");
    const lines = formatInitSummary({
      platform: "cursor",
      project: "agenr",
      projectDir,
      dependencies: [],
      configPath: path.join(projectDir, ".agenr", "config.json"),
      instructionsPath: path.join(projectDir, ".cursor", "rules", "agenr.mdc"),
      mcpPath: path.join(projectDir, ".cursor", "mcp.json"),
      mcpSkipped: false,
      gitignoreUpdated: false,
    });

    expect(lines).toContain("- Wrote config to .agenr/config.json");
  });
});

describe("formatWizardChanges", () => {
  it("formatWizardChanges shows human readable list for changed items", () => {
    const formatted = formatWizardChanges({
      authChanged: true,
      modelChanged: true,
      platformChanged: false,
      projectChanged: true,
      embeddingsKeyChanged: true,
      directoryChanged: false,
      dbPathChanged: false,
      previousModel: "claude-sonnet-4-20250514",
      newModel: "openai/gpt-4.1",
    });

    expect(formatted).toContain("- Auth method updated");
    expect(formatted).toContain("- Model changed: claude-sonnet-4-20250514 -> openai/gpt-4.1");
    expect(formatted).toContain("- Embeddings API key updated");
    expect(formatted).toContain("- Project slug changed");
  });

  it("formatWizardChanges includes directory changed", () => {
    const formatted = formatWizardChanges({
      authChanged: false,
      modelChanged: false,
      platformChanged: false,
      projectChanged: false,
      embeddingsKeyChanged: false,
      directoryChanged: true,
      dbPathChanged: false,
      previousModel: "gpt-4.1-mini",
      newModel: "gpt-4.1-mini",
    });

    expect(formatted).toContain("- OpenClaw directory changed");
  });

  it("formatWizardChanges includes isolated DB change", () => {
    const formatted = formatWizardChanges({
      authChanged: false,
      modelChanged: false,
      platformChanged: false,
      projectChanged: false,
      embeddingsKeyChanged: false,
      directoryChanged: false,
      dbPathChanged: true,
      openclawDbPath: "/tmp/.openclaw-sandbox/agenr-data/knowledge.db",
      previousModel: "gpt-4.1-mini",
      newModel: "gpt-4.1-mini",
    });

    expect(formatted).toContain("- Database: isolated at /tmp/.openclaw-sandbox/agenr-data/knowledge.db");
  });

  it("formatWizardChanges includes shared DB change", () => {
    const formatted = formatWizardChanges({
      authChanged: false,
      modelChanged: false,
      platformChanged: false,
      projectChanged: false,
      embeddingsKeyChanged: false,
      directoryChanged: false,
      dbPathChanged: true,
      previousModel: "gpt-4.1-mini",
      newModel: "gpt-4.1-mini",
    });

    expect(formatted).toContain("- Database: switched to shared");
  });

  it("formatWizardChanges shows no changes message when nothing changed", () => {
    const formatted = formatWizardChanges({
      authChanged: false,
      modelChanged: false,
      platformChanged: false,
      projectChanged: false,
      embeddingsKeyChanged: false,
      directoryChanged: false,
      dbPathChanged: false,
      previousModel: "gpt-4.1-mini",
      newModel: "gpt-4.1-mini",
    });

    expect(formatted).toBe("No changes detected.");
  });
});
