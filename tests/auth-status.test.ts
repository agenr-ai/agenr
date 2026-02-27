import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
}));

vi.mock("../src/embeddings/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/embeddings/client.js")>("../src/embeddings/client.js");
  return {
    ...actual,
    embed: embedMock,
  };
});

import { getAuthStatus, runEmbeddingConnectionTest } from "../src/auth-status.js";
import type { AgenrConfig } from "../src/types.js";

describe("auth status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runEmbeddingConnectionTest returns ok:true with valid key", async () => {
    embedMock.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);

    const result = await runEmbeddingConnectionTest("sk-valid");

    expect(result).toEqual({ ok: true });
    expect(embedMock).toHaveBeenCalledWith(["connection test"], "sk-valid");
  });

  it("runEmbeddingConnectionTest returns ok:false with invalid key", async () => {
    embedMock.mockRejectedValueOnce(new Error("OpenAI embeddings request failed (401): invalid API key"));

    const result = await runEmbeddingConnectionTest("sk-invalid");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });

  it("runEmbeddingConnectionTest returns ok:false on empty vector", async () => {
    embedMock.mockResolvedValueOnce([[]]);

    const result = await runEmbeddingConnectionTest("sk-empty");

    expect(result).toEqual({
      ok: false,
      error: "Unexpected response: empty embedding vector",
    });
  });

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
      models: {
        extraction: "gpt-5.2-codex",
        claimExtraction: "gpt-5.2-codex",
        contradictionJudge: "gpt-5.2-codex",
        handoffSummary: "gpt-5.2-codex",
      },
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
      models: {
        extraction: "gpt-5.2-codex",
        claimExtraction: "gpt-5.2-codex",
        contradictionJudge: "gpt-5.2-codex",
        handoffSummary: "gpt-5.2-codex",
      },
      credentials: {
        openaiApiKey: "sk-test",
      },
    };

    const status = await getAuthStatus(process.env, {
      config,
      connectionTestFn: async () => ({ ok: true }),
      embeddingConnectionTestFn: async () => ({ ok: true }),
    });

    expect(status.configured).toBe(true);
    expect(status.credentialAvailable).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.embeddingsConfigured).toBe(true);
    expect(status.embeddingsAuthenticated).toBe(true);
  });

  it("returns not authenticated when live test fails", async () => {
    const config: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      models: {
        extraction: "gpt-5.2-codex",
        claimExtraction: "gpt-5.2-codex",
        contradictionJudge: "gpt-5.2-codex",
        handoffSummary: "gpt-5.2-codex",
      },
      credentials: {
        openaiApiKey: "sk-test",
      },
    };

    const status = await getAuthStatus(process.env, {
      config,
      connectionTestFn: async () => ({ ok: false, error: "invalid key" }),
      embeddingConnectionTestFn: async () => ({ ok: true }),
    });

    expect(status.authenticated).toBe(false);
    expect(status.error).toContain("invalid key");
    expect(status.embeddingsConfigured).toBe(true);
    expect(status.embeddingsAuthenticated).toBe(true);
  });
});
