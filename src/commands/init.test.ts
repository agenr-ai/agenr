import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  readConfigMock,
  describeAuthMock,
  runSetupCoreMock,
  formatExistingConfigMock,
  clackIntroMock,
  clackNoteMock,
  clackConfirmMock,
  clackSelectMock,
  clackTextMock,
  clackLogInfoMock,
  clackCancelMock,
  clackOutroMock,
  clackCancelToken,
} = vi.hoisted(() => ({
  readConfigMock: vi.fn(),
  describeAuthMock: vi.fn((auth: string) => auth),
  runSetupCoreMock: vi.fn(),
  formatExistingConfigMock: vi.fn(),
  clackIntroMock: vi.fn(),
  clackNoteMock: vi.fn(),
  clackConfirmMock: vi.fn(),
  clackSelectMock: vi.fn(),
  clackTextMock: vi.fn(),
  clackLogInfoMock: vi.fn(),
  clackCancelMock: vi.fn(),
  clackOutroMock: vi.fn(),
  clackCancelToken: Symbol("cancel"),
}));

vi.mock("@clack/prompts", () => ({
  intro: clackIntroMock,
  note: clackNoteMock,
  confirm: clackConfirmMock,
  select: clackSelectMock,
  text: clackTextMock,
  log: {
    info: clackLogInfoMock,
  },
  cancel: clackCancelMock,
  outro: clackOutroMock,
  isCancel: (value: unknown) => value === clackCancelToken,
}));

vi.mock("../config.js", () => ({
  readConfig: readConfigMock,
  describeAuth: describeAuthMock,
}));

vi.mock("../setup.js", () => ({
  runSetupCore: runSetupCoreMock,
  formatExistingConfig: formatExistingConfigMock,
}));

import {
  buildMcpEntry,
  formatInitSummary,
  initWizardRuntime,
  resolveAgenrCommand,
  runInitCommand,
  runInitWizard,
} from "./init.js";

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

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await createTempDir("agenr-home-");
  tempDirs.push(homeDir);
  process.env.HOME = homeDir;
  return await fn(homeDir);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  readConfigMock.mockReset();
  describeAuthMock.mockReset();
  describeAuthMock.mockImplementation((auth: string) => auth);
  runSetupCoreMock.mockReset();
  formatExistingConfigMock.mockReset();
  clackSelectMock.mockReset();
  clackTextMock.mockReset();
  clackLogInfoMock.mockReset();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
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
        configDir: "/tmp/.openclaw",
        sessionsDir: "/tmp/.openclaw/sessions",
      },
      {
        id: "codex" as const,
        label: "Codex",
        detected: codexDetected,
        configDir: "/tmp/.codex",
        sessionsDir: "/tmp/.codex/sessions",
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

  it("wizard suggests single detected platform", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackTextMock.mockResolvedValue("agenr");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackConfirmMock).toHaveBeenCalledWith({
      message: "Detected OpenClaw at /tmp/.openclaw. Use this platform?",
      initialValue: true,
    });
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

    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining(`"authChanged":true`));
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

    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining(`"modelChanged":true`));
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
    });
    describeAuthMock.mockReturnValue("OpenAI API key");
    formatExistingConfigMock.mockReturnValue("auth summary");
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(true, true));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackConfirmMock.mockResolvedValue(true);
    clackSelectMock.mockResolvedValueOnce("keep").mockResolvedValueOnce("keep").mockResolvedValueOnce("keep");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining(`"authChanged":false`));
    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining(`"modelChanged":false`));
    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining(`"platformChanged":false`));
    expect(clackLogInfoMock).toHaveBeenCalledWith(expect.stringContaining(`"projectChanged":false`));
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

  it("wizard handles Ctrl+C at project slug input", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("openclaw");
    clackTextMock.mockResolvedValue(clackCancelToken);

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
    clackTextMock.mockResolvedValue("agenr");

    await runInitWizard({ isInteractive: true, path: dir });

    const textCall = clackTextMock.mock.calls[0]?.[0] as { validate?: (value: string) => string | undefined };
    expect(textCall.validate?.("   ")).toBe("Project name is required");
    expect(textCall.validate?.("my-project")).toBeUndefined();
  });

  it("calls runSetupCore when no existing config", async () => {
    const dir = await createWizardProjectDir();
    readConfigMock.mockReturnValue(null);
    runSetupCoreMock.mockResolvedValue(mockSetupResult());
    vi.spyOn(initWizardRuntime, "detectPlatforms").mockReturnValue(platformList(false, false));
    vi.spyOn(initWizardRuntime, "runInitCommand").mockResolvedValue(mockInitResult());
    clackSelectMock.mockResolvedValue("openclaw");
    clackTextMock.mockResolvedValue("agenr");

    await runInitWizard({ isInteractive: true, path: dir });

    expect(runSetupCoreMock).toHaveBeenCalledWith({
      env: process.env,
      existingConfig: null,
      skipIntroOutro: true,
    });
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
});
