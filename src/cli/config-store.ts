import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { resolveConfigPath } from "./paths";
import type { AgenrConfig, ApiKeyProvider, LlmProviderPreference } from "./types";

const providerApiKeysSchema = z.object({
  anthropic: z.string().min(1).nullable().default(null),
  openai: z.string().min(1).nullable().default(null),
});

const llmConfigSchema = z.object({
  provider: z
    .enum(["codex", "claude-code", "openai-api", "anthropic-api", "auto", "openai-codex", "openai", "anthropic"])
    .default("codex")
    .transform((value) => {
      switch (value) {
        case "auto":
        case "openai-codex":
          return "codex";
        case "openai":
          return "openai-api";
        case "anthropic":
          return "claude-code";
        default:
          return value;
      }
    }),
  model: z.string().min(1).nullable().default(null),
  subscriptionToken: z.string().min(1).nullable().default(null),
  apiKeys: providerApiKeysSchema.default({ anthropic: null, openai: null }),
});

const configSchema = z.object({
  llm: llmConfigSchema,
  generation: z.object({
    maxIterations: z.number().int().min(1).max(10).default(5),
    autoVerify: z.boolean().default(true),
  }),
});

const DEFAULT_CONFIG: AgenrConfig = {
  llm: {
    provider: "codex",
    model: null,
    subscriptionToken: null,
    apiKeys: {
      anthropic: null,
      openai: null,
    },
  },
  generation: {
    maxIterations: 5,
    autoVerify: true,
  },
};

function ensureParentDirectory(filePath: string) {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

export function loadConfig(): AgenrConfig {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return configSchema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Warning: config at '${configPath}' is invalid/corrupt (${message}). Replacing with defaults.`,
    );
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(config: AgenrConfig): void {
  const configPath = resolveConfigPath();
  ensureParentDirectory(configPath);
  const normalized = configSchema.parse(config);
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(configPath, 0o600);
}

export function setConfigProvider(provider: LlmProviderPreference): AgenrConfig {
  const config = loadConfig();
  config.llm.provider = provider;
  saveConfig(config);
  return config;
}

export function setConfigModel(model: string | null): AgenrConfig {
  const config = loadConfig();
  config.llm.model = model;
  saveConfig(config);
  return config;
}

export function setConfigSubscriptionToken(subscriptionToken: string | null): AgenrConfig {
  const config = loadConfig();
  config.llm.subscriptionToken = subscriptionToken;
  saveConfig(config);
  return config;
}

export function setConfigApiKey(provider: ApiKeyProvider, apiKey: string | null): AgenrConfig {
  const config = loadConfig();
  config.llm.apiKeys[provider] = apiKey;
  saveConfig(config);
  return config;
}
