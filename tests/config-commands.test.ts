import { describe, expect, it } from "vitest";
import { maskSecret, setConfigKey, setStoredCredential } from "../src/config.js";
import type { AgenrConfig } from "../src/types.js";

const DEFAULT_MODELS: AgenrConfig["models"] = {
  extraction: "gpt-4.1-nano",
  claimExtraction: "gpt-4.1-nano",
  contradictionJudge: "gpt-4.1-nano",
  handoffSummary: "gpt-4.1-nano",
};

describe("config command helpers", () => {
  it("sets auth and automatically maps provider", () => {
    const result = setConfigKey({}, "auth", "openai-subscription");

    expect(result.config.auth).toBe("openai-subscription");
    expect(result.config.provider).toBe("openai-codex");
  });

  it("rejects provider incompatible with configured auth", () => {
    const current: AgenrConfig = {
      auth: "openai-subscription",
      provider: "openai-codex",
      models: {
        extraction: "gpt-5.3-codex",
        claimExtraction: "gpt-5.3-codex",
        contradictionJudge: "gpt-5.3-codex",
        handoffSummary: "gpt-5.3-codex",
      },
    };

    expect(() => setConfigKey(current, "provider", "openai")).toThrow("is incompatible with auth");
  });

  it("rejects top-level model key", () => {
    expect(() => setConfigKey({}, "model", "gpt-4o")).toThrow(
      'Invalid key. Expected one of: "provider", "auth", or "models.<task>".',
    );
  });

  it("warns when changing auth leaves model incompatible", () => {
    const current: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      models: {
        extraction: "definitely-not-an-anthropic-model",
        claimExtraction: "gpt-4.1-nano",
        contradictionJudge: "gpt-4.1-nano",
        handoffSummary: "gpt-4.1-nano",
      },
    };

    const result = setConfigKey(current, "auth", "anthropic-api-key");
    expect(result.config.provider).toBe("anthropic");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("sets per-task model override via dot-path", () => {
    const result = setConfigKey({}, "models.extraction", "gpt-4.1");

    expect(result.config.models.extraction).toBe("gpt-4.1");
  });

  it("resets task model to default when value is default", () => {
    const first = setConfigKey({}, "models.extraction", "gpt-4.1");
    const second = setConfigKey(first.config, "models.extraction", "default");

    expect(second.config.models.extraction).toBe("gpt-4.1-nano");
  });

  it("rejects invalid task name in models dot-path", () => {
    expect(() => setConfigKey({}, "models.invalidTask", "gpt-4.1")).toThrow(
      'Invalid model task "invalidTask". Expected one of: extraction, claimExtraction, contradictionJudge, handoffSummary.',
    );
  });

  it("preserves other task models when setting one", () => {
    const first = setConfigKey({}, "models.extraction", "gpt-4.1");
    const second = setConfigKey(first.config, "models.claimExtraction", "gpt-4.1-mini");
    const third = setConfigKey(second.config, "models.extraction", "gpt-4.1-nano");

    expect(third.config.models).toEqual({ ...DEFAULT_MODELS, claimExtraction: "gpt-4.1-mini" });
  });

  it("keeps full models when values are reset", () => {
    const first = setConfigKey({}, "models.handoffSummary", "gpt-4.1-mini");
    const second = setConfigKey(first.config, "models.handoffSummary", "default");

    expect(second.config.models).toEqual(DEFAULT_MODELS);
  });

  it("writes task model override even when value matches task default", () => {
    const result = setConfigKey({}, "models.contradictionJudge", "gpt-4.1-nano");

    expect(result.config.models.contradictionJudge).toBe("gpt-4.1-nano");
  });

  it("stores and overwrites credential fields", () => {
    const first = setStoredCredential({}, "openai", "sk-old");
    const second = setStoredCredential(first, "openai", "sk-new");

    expect(second.credentials?.openaiApiKey).toBe("sk-new");
  });

  it("masks stored secrets", () => {
    expect(maskSecret("sk-ant-api03-1234")).toBe("****1234");
    expect(maskSecret(undefined)).toBe("(not set)");
  });
});
