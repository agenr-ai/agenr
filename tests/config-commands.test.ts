import { describe, expect, it } from "vitest";
import { maskSecret, setConfigKey, setStoredCredential } from "../src/config.js";
import type { AgenrConfig } from "../src/types.js";

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
      model: "gpt-5.3-codex",
    };

    expect(() => setConfigKey(current, "provider", "openai")).toThrow("is incompatible with auth");
  });

  it("validates model against current provider", () => {
    const current: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.2-codex",
    };

    const result = setConfigKey(current, "model", "gpt-4o");
    expect(result.config.model).toBe("gpt-4o");
  });

  it("warns when changing auth leaves model incompatible", () => {
    const current: AgenrConfig = {
      auth: "openai-api-key",
      provider: "openai",
      model: "definitely-not-an-anthropic-model",
    };

    const result = setConfigKey(current, "auth", "anthropic-api-key");
    expect(result.config.provider).toBe("anthropic");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("sets per-task model override via dot-path", () => {
    const result = setConfigKey({}, "models.extraction", "gpt-4.1");

    expect(result.config.models?.extraction).toBe("gpt-4.1");
  });

  it("removes per-task override when value is default", () => {
    const first = setConfigKey({}, "models.extraction", "gpt-4.1");
    const second = setConfigKey(first.config, "models.extraction", "default");

    expect(second.config.models?.extraction).toBeUndefined();
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

    expect(third.config.models).toEqual({
      extraction: "gpt-4.1-nano",
      claimExtraction: "gpt-4.1-mini",
    });
  });

  it("removes models field when last override is cleared", () => {
    const first = setConfigKey({}, "models.handoffSummary", "gpt-4.1-mini");
    const second = setConfigKey(first.config, "models.handoffSummary", "default");

    expect(second.config.models).toBeUndefined();
  });

  it("writes task model override even when value matches task default", () => {
    const result = setConfigKey({}, "models.contradictionJudge", "gpt-4.1-nano");

    expect(result.config.models?.contradictionJudge).toBe("gpt-4.1-nano");
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
