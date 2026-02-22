import { getModels } from "@mariozechner/pi-ai";
import * as clack from "@clack/prompts";
import {
  AUTH_METHOD_DEFINITIONS,
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
      resolveModel(provider, modelId);
      return true;
    } catch {
      return false;
    }
  });
  const fallback = allModels.filter((modelId) => !preferred.includes(modelId));

  if (provider === "openai") {
    const prioritizedFallback = fallback
      .filter(
        (modelId) =>
          modelId.startsWith("gpt-5") || modelId.startsWith("gpt-4o") || modelId === "o3" || modelId === "o4-mini",
      )
      .concat(fallback.filter((modelId) => !modelId.startsWith("gpt-") && modelId !== "o3" && modelId !== "o4-mini"));

    return Array.from(new Set([...preferred, ...prioritizedFallback]));
  }

  return Array.from(new Set([...preferred, ...fallback]));
}

function formatExistingConfig(config: AgenrConfig): string {
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

export async function runSetup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  clack.intro(banner());

  const existing = readConfig(env);
  let working = existing ? mergeConfigPatch(existing, {}) : {};

  if (existing) {
    clack.note(formatExistingConfig(existing), "Current config");
    const reconfigure = await clack.confirm({
      message: "Reconfigure?",
      initialValue: true,
    });

    if (clack.isCancel(reconfigure) || !reconfigure) {
      clack.cancel("Setup unchanged.");
      return;
    }
  }

  const auth = await clack.select<AgenrAuthMethod>({
    message: "How would you like to authenticate?",
    options: AUTH_METHOD_DEFINITIONS.map((definition) => ({
      value: definition.id,
      label: definition.title,
      hint: definition.setupDescription,
    })),
  });

  if (clack.isCancel(auth)) {
    clack.cancel("Setup cancelled.");
    return;
  }

  const provider = getAuthMethodDefinition(auth).provider;

  let probe = probeCredentials({
    auth,
    storedCredentials: working.credentials,
    env,
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
        clack.cancel("Setup cancelled.");
        return;
      }

      if (shouldEnterNow) {
        const entered = await clack.password({
          message: promptToEnterCredential(auth),
        });

        if (clack.isCancel(entered)) {
          clack.cancel("Setup cancelled.");
          return;
        }

        const normalized = entered.trim();
        if (normalized) {
          working = setStoredCredential(working, credentialKey, normalized);
          probe = probeCredentials({
            auth,
            storedCredentials: working.credentials,
            env,
          });
        }
      }
    }
  } else if (existing && credentialKey) {
    // Already configured and working. When reconfiguring, offer to update.
    const updateKey = await clack.confirm({
      message: "Update stored credential?",
      initialValue: false,
    });

    if (clack.isCancel(updateKey)) {
      clack.cancel("Setup cancelled.");
      return;
    }

    if (updateKey) {
      const entered = await clack.password({
        message: promptToEnterCredential(auth),
      });

      if (clack.isCancel(entered)) {
        clack.cancel("Setup cancelled.");
        return;
      }

      const normalized = entered.trim();
      if (normalized) {
        working = setStoredCredential(working, credentialKey, normalized);
      }
    }
  }

  const modelChoices = modelChoicesForAuth(auth, provider);
  if (modelChoices.length === 0) {
    throw new Error(`No models are available for provider "${provider}".`);
  }

  const model = await clack.select<string>({
    message: "Select default model:",
    options: modelChoices.map((id) => {
      const details = getModels(provider).find((modelInfo) => modelInfo.id === id);
      return {
        value: id,
        label: id,
        hint: details ? details.name : undefined,
      };
    }),
  });

  if (clack.isCancel(model)) {
    clack.cancel("Setup cancelled.");
    return;
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
        clack.cancel("Setup cancelled.");
        return;
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

  writeConfig(nextConfig, env);

  clack.note(
    [
      formatLabel("Auth", describeAuth(auth)),
      formatLabel("Provider", provider),
      formatLabel("Model", resolvedModel.modelId),
    ].join("\n"),
    "Configuration saved",
  );

  clack.outro("Try it: " + ui.bold("agenr extract <transcript.jsonl>"));
}
