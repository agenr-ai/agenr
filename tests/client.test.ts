import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConfig } from "../src/config.js";
import { createLlmClient, resolveProviderAndModel } from "../src/llm/client.js";

const tempDirs: string[] = [];
let savedOpenAiApiKey: string | undefined;

async function makeConfigEnv(): Promise<{ env: NodeJS.ProcessEnv; configPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-client-test-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.json");
  return {
    configPath,
    env: {
      ...process.env,
      AGENR_CONFIG_PATH: configPath,
    },
  };
}

beforeEach(() => {
  savedOpenAiApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  if (savedOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedOpenAiApiKey;
  }
  savedOpenAiApiKey = undefined;

  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("llm client", () => {
  it("uses provider/model defaults from config", async () => {
    const { env } = await makeConfigEnv();

    writeConfig(
      {
        auth: "anthropic-api-key",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      env,
    );

    const resolved = resolveProviderAndModel({ env });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-opus-4-6");
    expect(resolved.auth).toBe("anthropic-api-key");
  });

  it("allows flags to override config model", async () => {
    const { env } = await makeConfigEnv();

    writeConfig(
      {
        auth: "anthropic-api-key",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      env,
    );

    const resolved = resolveProviderAndModel({
      env,
      model: "claude-sonnet-4-20250514",
    });

    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-sonnet-4-20250514");
  });

  it("fails when setup has not been run", async () => {
    const { env } = await makeConfigEnv();

    expect(() => resolveProviderAndModel({ env })).toThrow("Not configured. Run `agenr setup`.");
  });

  it("enforces auth/provider coupling", async () => {
    const { env } = await makeConfigEnv();

    writeConfig(
      {
        auth: "openai-subscription",
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      },
      env,
    );

    expect(() =>
      resolveProviderAndModel({
        env,
        provider: "openai",
      }),
    ).toThrow("requires provider \"openai-codex\"");
  });

  it("creates a client with resolved credentials", async () => {
    const { env } = await makeConfigEnv();

    writeConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.2-codex",
        credentials: {
          openaiApiKey: "sk-from-config",
        },
      },
      env,
    );

    const client = createLlmClient({ env });
    expect(client.auth).toBe("openai-api-key");
    expect(client.resolvedModel.provider).toBe("openai");
    expect(client.credentials.apiKey).toBe("sk-from-config");
  });
});
