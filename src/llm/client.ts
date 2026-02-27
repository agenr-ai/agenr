import { authMethodToProvider, readConfig } from "../config.js";
import type { AgenrConfig, AgenrProvider, LlmClient } from "../types.js";
import { resolveCredentials } from "./credentials.js";
import { normalizeProvider, resolveModel } from "./models.js";

export interface ResolveLlmClientInput {
  provider?: string;
  model?: string;
  config?: AgenrConfig | null;
  env?: NodeJS.ProcessEnv;
}

export function resolveProviderAndModel(input: ResolveLlmClientInput): {
  auth: NonNullable<AgenrConfig["auth"]>;
  provider: AgenrProvider;
  model: string;
  storedCredentials: AgenrConfig["credentials"];
} {
  const config = input.config ?? readConfig(input.env);
  const auth = config?.auth;
  if (!auth) {
    throw new Error("Not configured. Run `agenr setup`.");
  }

  const providerRaw = input.provider?.trim() || config.provider?.trim();
  const modelRaw = input.model?.trim() || config?.models?.extraction?.trim();

  if (!providerRaw || !modelRaw) {
    throw new Error(
      [
        "Provider/model are not configured.",
        "Run `agenr setup`, or pass --provider and --model to override this run.",
      ].join("\n"),
    );
  }

  const provider = normalizeProvider(providerRaw);
  const expectedProvider = authMethodToProvider(auth);
  if (provider !== expectedProvider) {
    throw new Error(
      [
        `Configured auth method "${auth}" requires provider "${expectedProvider}".`,
        "Use `agenr config set auth <method>` to switch auth/provider together.",
      ].join(" "),
    );
  }

  const resolvedModel = resolveModel(provider, modelRaw);
  return {
    auth,
    provider: resolvedModel.provider,
    model: resolvedModel.modelId,
    storedCredentials: config?.credentials,
  };
}

export function createLlmClient(input: ResolveLlmClientInput): LlmClient {
  const resolved = resolveProviderAndModel(input);
  const resolvedModel = resolveModel(resolved.provider, resolved.model);
  const credentials = resolveCredentials({
    auth: resolved.auth,
    storedCredentials: resolved.storedCredentials,
    env: input.env,
  });

  return {
    auth: resolved.auth,
    resolvedModel,
    credentials,
  };
}
