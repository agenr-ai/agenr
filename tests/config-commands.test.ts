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
