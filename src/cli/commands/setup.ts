import { getModels } from "@mariozechner/pi-ai";
import type { Command } from "commander";

import { createEmbeddingClient } from "../../adapters/embeddings.js";
import { createLlmClient, probeLlmCredentials } from "../../adapters/llm.js";
import { configFileExists, readConfig, resolveConfigPath, resolveDbPath, writeConfig } from "../../config.js";
import { banner, cliPrompts, ui } from "../ui.js";
import { formatExistingConfig, getSetupReadiness, isSetupConfigured } from "./setup/config.js";
import { filterSetupModelsForAuth, buildStageAuthOptions } from "./setup/stages.js";
import { formatUnknownError, withTimeout } from "./setup/shared.js";
import { runSetupCore as runSetupWizard } from "./setup/wizard.js";
import type { ConnectionTestResult, SetupCoreOptions, SetupCoreResult, SetupModelDescriptor, SetupProvider, SetupRuntime } from "./setup/types.js";

const CONNECTION_TEST_TIMEOUT_MS = 5_000;

const defaultSetupRuntime: SetupRuntime = {
  resolveConfigPath: () => resolveConfigPath(),
  resolveDbPath: (config) => resolveDbPath(config),
  writeConfig: (config) => writeConfig(config),
  getModelsForProvider: (provider) =>
    getModels(provider)
      .map((model) => ({
        id: model.id,
        name: model.name,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  probeCredentials: (auth, config) =>
    probeLlmCredentials({
      auth,
      storedCredentials: config?.credentials,
    }),
  testLlmConnection: async (provider, modelId, apiKey) => {
    try {
      const client = createLlmClient(provider, modelId, { apiKey });
      await withTimeout(
        client.complete("You are a connection test. Reply with OK.", "Reply with OK."),
        CONNECTION_TEST_TIMEOUT_MS,
        "LLM connection test timed out.",
      );
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: formatUnknownError(error),
      };
    }
  },
  testEmbeddingConnection: async (apiKey, modelId) => {
    try {
      const client = createEmbeddingClient(apiKey, modelId);
      const vectors = await withTimeout(client.embed(["connection test"]), CONNECTION_TEST_TIMEOUT_MS, "Embedding connection test timed out.");
      if (vectors.length !== 1 || vectors[0] === undefined || vectors[0].length === 0) {
        return { ok: false, error: "Embedding API returned an empty vector." };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: formatUnknownError(error),
      };
    }
  },
  getSetupReadiness: (config) => getSetupReadiness(config),
};

export type { ConnectionTestResult, SetupCoreOptions, SetupCoreResult, SetupModelDescriptor, SetupProvider, SetupRuntime };
export { buildStageAuthOptions, filterSetupModelsForAuth, formatExistingConfig, getSetupReadiness, isSetupConfigured };

/**
 * Registers the `agenr setup` command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Configure auth, models, embeddings, and the agenr database path")
    .action(async () => {
      await runSetupCommand();
    });
}

/**
 * Runs the full `agenr setup` command, including existing-config detection.
 */
export async function runSetupCommand(): Promise<void> {
  const prompts = cliPrompts;
  const runtime = defaultSetupRuntime;
  prompts.intro(banner());

  try {
    const existingConfigPath = runtime.resolveConfigPath();
    const existingConfig = readConfig();
    const hasExistingConfig = configFileExists();

    if (hasExistingConfig) {
      const summary = formatExistingConfig(existingConfig, existingConfigPath, runtime.resolveDbPath(existingConfig));
      prompts.note(summary, "Current config");

      const reconfigure = await prompts.confirm({
        message: "Reconfigure agenr now?",
        initialValue: true,
      });

      if (prompts.isCancel(reconfigure)) {
        prompts.cancel("Setup cancelled.");
        return;
      }

      if (!reconfigure) {
        prompts.outro("Setup unchanged.");
        return;
      }
    }

    const result = await runSetupCore({
      existingConfig: hasExistingConfig ? existingConfig : undefined,
      prompts,
      runtime,
    });

    if (!result) {
      prompts.cancel("Setup cancelled.");
      return;
    }

    if (!result.ready) {
      const pendingCredentialGuidance = result.readinessGuidance ?? "Additional credentials are still required before agenr can run.";
      prompts.outro(`Setup saved. ${pendingCredentialGuidance}`);
      return;
    }

    prompts.outro(`Next: ${ui.bold('agenr recall "test"')} or ${ui.bold("agenr ingest <path>")}`);
  } catch (error) {
    process.exitCode = 1;
    prompts.log.error(formatUnknownError(error));
    prompts.outro(ui.error("Setup failed"));
  }
}

/**
 * Runs the reusable interactive setup flow without banner/outro handling.
 *
 * @param options - Existing config, prompts, and runtime hooks.
 * @returns Saved config details, or `null` when the user cancels.
 */
export async function runSetupCore(options: SetupCoreOptions = {}): Promise<SetupCoreResult | null> {
  return runSetupWizard({
    ...options,
    runtime: options.runtime ?? defaultSetupRuntime,
  });
}
