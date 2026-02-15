import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeCredentials } from "../src/llm/credentials.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("credentials", () => {
  it("uses env token before stored token for anthropic-token", () => {
    const result = probeCredentials({
      auth: "anthropic-token",
      storedCredentials: {
        anthropicOauthToken: "stored-token",
      },
      env: {
        ...process.env,
        ANTHROPIC_OAUTH_TOKEN: "env-token",
      },
    });

    expect(result.available).toBe(true);
    expect(result.source).toBe("env:ANTHROPIC_OAUTH_TOKEN");
    expect(result.credentials?.apiKey).toBe("env-token");
  });

  it("uses stored token when env token is absent", () => {
    const result = probeCredentials({
      auth: "anthropic-token",
      storedCredentials: {
        anthropicOauthToken: "stored-token",
      },
      env: {
        ...process.env,
        ANTHROPIC_OAUTH_TOKEN: "",
      },
    });

    expect(result.available).toBe(true);
    expect(result.source).toBe("config:credentials.anthropicOauthToken");
    expect(result.credentials?.apiKey).toBe("stored-token");
  });

  it("is method-scoped and does not use API key for anthropic-oauth", () => {
    const fakeHome = path.join(os.tmpdir(), `agenr-empty-home-${Date.now()}`);
    const result = probeCredentials({
      auth: "anthropic-oauth",
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-env",
        HOME: fakeHome,
      },
    });

    expect(result.source).not.toBe("env:ANTHROPIC_API_KEY");
  });

  it("discovers codex subscription credential from auth file", async () => {
    const dir = await makeTempDir("agenr-codex-auth-");
    const codexHome = path.join(dir, "codex-home");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access-token",
        },
      }),
      "utf8",
    );

    const result = probeCredentials({
      auth: "openai-subscription",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });

    expect(result.available).toBe(true);
    expect(result.source).toContain("file:");
    expect(result.credentials?.apiKey).toBe("codex-access-token");
  });

  it("discovers anthropic oauth credential from Claude file", async () => {
    const dir = await makeTempDir("agenr-claude-home-");
    const fakeHome = path.join(dir, "home");
    const claudeDir = path.join(fakeHome, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access-token",
        },
      }),
      "utf8",
    );

    const result = probeCredentials({
      auth: "anthropic-oauth",
      env: {
        ...process.env,
        HOME: fakeHome,
      },
    });

    expect(result.available).toBe(true);
    expect(result.source).toContain(".claude/.credentials.json");
    expect(result.credentials?.apiKey).toBe("claude-access-token");
  });
});
