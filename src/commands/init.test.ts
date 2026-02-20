import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInitCommand } from "./init.js";

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

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await createTempDir("agenr-home-");
  tempDirs.push(homeDir);
  process.env.HOME = homeDir;
  return await fn(homeDir);
}

afterEach(async () => {
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

  it("explicit --platform openclaw skips AGENTS.md write and still writes MCP config", async () => {
    const dir = await createTempDir();
    tempDirs.push(dir);

    const result = await runInitCommand({ path: dir, platform: "openclaw" });
    expect(result.platform).toBe("openclaw");
    expect(result.instructionsPath).toBeNull();
    expect(await pathExists(path.join(dir, "AGENTS.md"))).toBe(false);

    const mcpPath = path.join(dir, ".mcp.json");
    expect(await pathExists(mcpPath)).toBe(true);
    const config = await readJson(mcpPath);
    const mcpServers = config.mcpServers as Record<string, unknown>;
    expect(mcpServers.agenr).toEqual({
      command: "agenr",
      args: ["mcp"],
      env: {
        AGENR_PROJECT_DIR: path.resolve(dir),
      },
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
      expect(result.mcpPath).toBe(path.join(dir, ".mcp.json"));
      expect(await pathExists(path.join(dir, "AGENTS.md"))).toBe(false);
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
      command: "agenr",
      args: ["mcp"],
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
        command: "agenr",
        args: ["mcp"],
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
