import type { AgenrAuthMethod, AgenrConfigInput, AgenrProvider } from "../../../config.js";
import type { LlmCredentialProbeResult } from "../../../adapters/llm.js";
import type { WizardPrompts } from "../../ui.js";

/**
 * Providers exposed by setup and init helpers.
 */
export type SetupProvider = AgenrProvider;

/**
 * Model metadata shown in setup model pickers.
 */
export interface SetupModelDescriptor {
  /** Provider-local model identifier. */
  id: string;
  /** Human-readable model name. */
  name?: string;
}

/**
 * Result returned by LLM and embedding connection tests.
 */
export interface ConnectionTestResult {
  /** Whether the test succeeded. */
  ok: boolean;
  /** Optional human-readable error when the test failed. */
  error?: string;
}

/**
 * Runtime hooks used by the setup flow for testability.
 */
export interface SetupRuntime {
  /** Resolves the effective config file path. */
  resolveConfigPath(): string;
  /** Resolves the effective database path. */
  resolveDbPath(config?: AgenrConfigInput): string;
  /** Persists the updated config. */
  writeConfig(config: AgenrConfigInput): void;
  /** Lists available models for one setup provider. */
  getModelsForProvider(provider: SetupProvider): SetupModelDescriptor[];
  /** Probes credentials for one auth method. */
  probeCredentials(auth: AgenrAuthMethod, config?: AgenrConfigInput): LlmCredentialProbeResult;
  /** Verifies that the chosen LLM credential works. */
  testLlmConnection(provider: SetupProvider, modelId: string, apiKey: string): Promise<ConnectionTestResult>;
  /** Verifies that the embedding credential works. */
  testEmbeddingConnection(apiKey: string, modelId: string): Promise<ConnectionTestResult>;
  /** Explains whether the saved config can run agenr commands immediately. */
  getSetupReadiness(config: AgenrConfigInput): { ready: boolean; guidance?: string };
}

/**
 * Options for the reusable setup core flow.
 */
export interface SetupCoreOptions {
  /** Existing config values used for defaults and key reuse prompts. */
  existingConfig?: AgenrConfigInput;
  /** Prompt implementation used by the interactive flow. */
  prompts?: WizardPrompts;
  /** Runtime dependencies used by the interactive flow. */
  runtime?: SetupRuntime;
  /** When true, writes every known feature flag as enabled in config.json. */
  populateAllFeatures?: boolean;
}

/**
 * Successful result from the setup core flow.
 */
export interface SetupCoreResult {
  /** Persisted agenr config. */
  config: AgenrConfigInput;
  /** Config file path written by setup. */
  configPath: string;
  /** Database path stored in the config. */
  dbPath: string;
  /** Selected auth method. */
  auth: AgenrAuthMethod;
  /** Selected default provider. */
  provider: SetupProvider;
  /** Selected default model. */
  model: string;
  /** Whether embeddings reuse the primary OpenAI key. */
  embeddingUsesPrimaryKey: boolean;
  /** Whether the saved config can run agenr commands immediately. */
  ready: boolean;
  /** Human-readable blocker when the saved config is not ready yet. */
  readinessGuidance?: string;
}
