import { describe, expect, it } from "vitest";
import { getAuthStatus } from "../src/auth-status.js";
import type { AgenrConfig } from "../src/types.js";

describe("auth status", () => {
  it("returns not configured when config is missing", async () => {
    const status = await getAuthStatus(process.env, {
      config: null,
    });

    expect(status.configured).toBe(false);
    expect(status.guidance).toContain("Run `agenr setup`");
  });

  it("returns not authenticated when credentials are missing", async () => {
    const config: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.2-codex",
    };

    const status = await getAuthStatus(
      {
        ...process.env,
        OPENAI_API_KEY: "",
      },
      {
        config,
      },
    );

    expect(status.configured).toBe(true);
    expect(status.credentialAvailable).toBe(false);
    expect(status.authenticated).toBe(false);
  });

  it("returns authenticated when live test succeeds", async () => {
    const config: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.2-codex",
      credentials: {
        openaiApiKey: "sk-test",
      },
    };

    const status = await getAuthStatus(process.env, {
      config,
      connectionTestFn: async () => ({ ok: true }),
    });

    expect(status.configured).toBe(true);
    expect(status.credentialAvailable).toBe(true);
    expect(status.authenticated).toBe(true);
  });

  it("returns not authenticated when live test fails", async () => {
    const config: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.2-codex",
      credentials: {
        openaiApiKey: "sk-test",
      },
    };

    const status = await getAuthStatus(process.env, {
      config,
      connectionTestFn: async () => ({ ok: false, error: "invalid key" }),
    });

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain("invalid key");
  });
});
