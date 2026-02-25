import { getModels } from "@mariozechner/pi-ai";
import * as clack from "@clack/prompts";
import {
  describeAuth,
  getAuthMethodDefinition,
  mergeConfigPatch,
  readConfig,
  setStoredCredential,
  writeConfig,
} from "./config.js";
import { runConnectionTest } from "./auth-status.js";
import { probeCredentials } from "./llm/credentials.js";
import { resolveModel } from "./llm/models.js";
import { banner, formatLabel, ui } from "./ui.js";
import type { AgenrAuthMethod, AgenrConfig, AgenrProvider } from "./types.js";

const ADVANCED_AUTH_NOTICE =
  "Note: Subscription models may have limited extraction quality. API keys with gpt-4.1-mini are recommended for best results.";

function credentialKeyForAuth(auth: AgenrAuthMethod): "anthropic-token" | "anthropic" | "openai" | null {
  if (auth === "anthropic-token") {
    return "anthropic-token";
  }
  if (auth === "anthropic-api-key") {
    return "anthropic";
  }
  if (auth === "openai-api-key") {
    return "openai";
  }
  return null;
}

function promptToEnterCredential(auth: AgenrAuthMethod): string {
  if (auth === "anthropic-token") {
    return "Enter long-lived token:";
  }
  if (auth === "anthropic-api-key") {
    return "Enter Anthropic API key:";
  }
  return "Enter OpenAI API key:";
}

function modelChoicesForAuth(auth: AgenrAuthMethod, provider: AgenrProvider): string[] {
  const definition = getAuthMethodDefinition(auth);
  const allModels = getModels(provider).map((model) => model.id);

  const preferred = definition.preferredModels.filter((modelId) => {
    try {
      // resolveModel throws if the alias is unknown - used here for validation only.
      resolveModel(provider, modelId);
      return true;
    } catch {
      return false;
    }
  });
  const fallback = allModels.filter((modelId) => !preferred.includes(modelId));

  if (provider === "openai") {
    const preferredOpenAiOrder = ["gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano"];
    const prioritizedPreferred = preferredOpenAiOrder.filter((modelId) => allModels.includes(modelId));
    const remainingPreferred = preferred.filter((modelId) => !prioritizedPreferred.includes(modelId));
    const prioritizedFallback = fallback
      .filter(
        (modelId) =>
          modelId.startsWith("gpt-5") || modelId.startsWith("gpt-4o") || modelId === "o3" || modelId === "o4-mini",
      )
      .concat(fallback.filter((modelId) => !modelId.startsWith("gpt-") && modelId !== "o3" && modelId !== "o4-mini"));

    return Array.from(new Set([...prioritizedPreferred, ...remainingPreferred, ...prioritizedFallback]));
  }

  return Array.from(new Set([...preferred, ...fallback]));
}

function modelHintForChoice(provider: AgenrProvider, modelId: string): string | undefined {
  if (provider === "openai") {
    if (modelId === "gpt-4.1-mini") {
      return "recommended - good balance of quality and cost";
    }
    if (modelId === "gpt-4.1") {
      return "best extraction quality - ~5x cost of mini";
    }
    if (modelId === "gpt-4.1-nano") {
      return "cheapest - lower quality extraction";
    }
  }

  const details = getModels(provider).find((modelInfo) => modelInfo.id === modelId);
  return details?.name;
}

async function selectAuthMethod(): Promise<AgenrAuthMethod | null> {
  while (true) {
    const authSelection = await clack.select<AgenrAuthMethod | "advanced-options">({
      message: "How would you like to authenticate?",
      options: [
        {
          value: "openai-api-key",
          label: "OpenAI API key",
          hint: "recommended for extraction",
        },
        {
          value: "anthropic-api-key",
          label: "Anthropic API key",
        },
        {
          value: "advanced-options",
          label: "Advanced options...",
        },
      ],
    });

    if (clack.isCancel(authSelection)) {
      return null;
    }

    if (authSelection !== "advanced-options") {
      return authSelection;
    }

    const advancedSelection = await clack.select<AgenrAuthMethod | "back">({
      message: "Advanced authentication:",
      options: [
        {
          value: "anthropic-oauth",
          label: "Anthropic - Claude subscription (OAuth)",
        },
        {
          value: "anthropic-token",
          label: "Anthropic - Claude subscription (long-lived token)",
        },
        {
          value: "openai-subscription",
          label: "OpenAI - Subscription (via Codex CLI)",
        },
        {
          value: "back",
          label: "Back",
        },
      ],
    });

    if (clack.isCancel(advancedSelection)) {
      return null;
    }

    if (advancedSelection === "back") {
      continue;
    }

    clack.log.info(ADVANCED_AUTH_NOTICE);
    return advancedSelection;
  }
}

function showAuthSetupGuidance(auth: AgenrAuthMethod): void {
  if (auth === "openai-api-key") {
    clack.log.info("Get your API key at https://platform.openai.com/api-keys");
    return;
  }

  if (auth === "anthropic-api-key") {
    clack.log.info("Get your API key at https://console.anthropic.com/settings/keys");
    return;
  }

  clack.log.info("This uses your existing subscription - no API key needed.");
}

export function formatExistingConfig(config: AgenrConfig): string {
  return [
    formatLabel("Auth", config.auth ? describeAuth(config.auth) : "(not set)"),
    formatLabel("Provider", config.provider ?? "(not set)"),
    formatLabel("Model", config.model ?? "(not set)"),
  ].join("\n");
}

function buildConfigWithCredentials(base: AgenrConfig, credentials?: AgenrConfig["credentials"]): AgenrConfig {
  if (!credentials || Object.keys(credentials).length === 0) {
    return {
      auth: base.auth,
      provider: base.provider,
      model: base.model,
    };
  }

  return {
    ...base,
    credentials,
  };
}

export interface SetupResult {
  auth: AgenrAuthMethod;
  provider: AgenrProvider;
  model: string;
  config: AgenrConfig;
  changed: boolean;
}

export interface SetupCoreOptions {
  env: NodeJS.ProcessEnv;
  existingConfig: AgenrConfig | null;
  skipIntroOutro: boolean;
}

export async function runSetupCore(options: SetupCoreOptions): Promise<SetupResult | null> {
  if (!options.skipIntroOutro) {
    clack.intro(banner());
  }

  let working = options.existingConfig ? mergeConfigPatch(options.existingConfig, {}) : {};

  const auth = await selectAuthMethod();
  if (!auth) {
    return null;
  }

  showAuthSetupGuidance(auth);

  const provider = getAuthMethodDefinition(auth).provider;

  let probe = probeCredentials({
    auth,
    storedCredentials: working.credentials,
    env: options.env,
  });

  const credentialKey = credentialKeyForAuth(auth);

  if (!probe.available) {
    clack.log.warn(probe.guidance);

    if (credentialKey) {
      const shouldEnterNow = await clack.confirm({
        message: "Enter the credential now?",
        initialValue: false,
      });

      if (clack.isCancel(shouldEnterNow)) {
        return null;
      }

      if (shouldEnterNow) {
        const entered = await clack.password({
          message: promptToEnterCredential(auth),
        });

        if (clack.isCancel(entered)) {
          return null;
        }

        const normalized = entered.trim();
        if (normalized) {
          working = setStoredCredential(working, credentialKey, normalized);
          probe = probeCredentials({
            auth,
            storedCredentials: working.credentials,
            env: options.env,
          });
        }
      }
    }
  } else if (options.existingConfig && credentialKey) {
    // Already configured and working. When reconfiguring, offer to update.
    const updateKey = await clack.confirm({
      message: "Update stored credential?",
      initialValue: false,
    });

    if (clack.isCancel(updateKey)) {
      return null;
    }

    if (updateKey) {
      const entered = await clack.password({
        message: promptToEnterCredential(auth),
      });

      if (clack.isCancel(entered)) {
        return null;
      }

      const normalized = entered.trim();
      if (normalized) {
        working = setStoredCredential(working, credentialKey, normalized);
        probe = probeCredentials({
          auth,
          storedCredentials: working.credentials,
          env: options.env,
        });
        clack.log.info("Credential updated.");
      } else {
        clack.log.warn("Credential not updated - empty input.");
      }
    }
  }

  const modelChoices = modelChoicesForAuth(auth, provider);
  if (modelChoices.length === 0) {
    throw new Error(`No models are available for provider "${provider}".`);
  }

  const model = await clack.select<string>({
    message: "Select default model:",
    options: modelChoices.map((id) => ({
      value: id,
      label: id,
      hint: modelHintForChoice(provider, id),
    })),
  });

  if (clack.isCancel(model)) {
    return null;
  }

  const resolvedModel = resolveModel(provider, model);

  if (probe.available && probe.credentials) {
    const spinner = clack.spinner();
    spinner.start("Testing connection...");

    while (true) {
      const test = await runConnectionTest({
        auth,
        provider,
        model: resolvedModel.modelId,
        credentials: probe.credentials,
      });

      if (test.ok) {
        spinner.stop(ui.success("Connected"));
        break;
      }

      spinner.stop(ui.error(`Connection failed: ${test.error ?? "unknown error"}`));

      const retry = await clack.confirm({
        message: "Retry connection test?",
        initialValue: true,
      });

      if (clack.isCancel(retry)) {
        return null;
      }

      if (!retry) {
        clack.log.info("Skipping connection test. You can verify later with " + ui.bold("agenr auth status") + ".");
        break;
      }

      spinner.start("Testing connection...");
    }
  } else {
    clack.log.info("Credentials not available yet. Skipping connection test.");
    clack.log.info(
      "Add credentials later with " + ui.bold("agenr config set-key") + ", then run " + ui.bold("agenr auth status"),
    );
  }

  const nextConfig = buildConfigWithCredentials(
    {
      auth,
      provider,
      model: resolvedModel.modelId,
    },
    working.credentials,
  );

  writeConfig(nextConfig, options.env);

  clack.note(
    [
      formatLabel("Auth", describeAuth(auth)),
      formatLabel("Provider", provider),
      formatLabel("Model", resolvedModel.modelId),
    ].join("\n"),
    "Configuration saved",
  );

  if (!options.skipIntroOutro) {
    clack.outro("Try it: " + ui.bold("agenr extract <transcript.jsonl>"));
  }

  return {
    auth,
    provider,
    model: resolvedModel.modelId,
    config: nextConfig,
    changed: true,
  };
}

export const setupRuntime = {
  runSetupCore,
};

export async function runSetup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  clack.intro(banner());

  const existing = readConfig(env);
  if (existing) {
    clack.note(formatExistingConfig(existing), "Current config");
    const reconfigure = await clack.confirm({
      message: "Reconfigure?",
      initialValue: true,
    });

    if (clack.isCancel(reconfigure)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (!reconfigure) {
      clack.cancel("Setup unchanged.");
      return;
    }
  }

  const result = await setupRuntime.runSetupCore({
    env,
    existingConfig: existing,
    skipIntroOutro: true,
  });
  if (!result) {
    clack.cancel("Setup cancelled.");
    return;
  }

  clack.outro("Try it: " + ui.bold("agenr extract <transcript.jsonl>"));
}
