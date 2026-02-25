import type { Context } from "@mariozechner/pi-ai";
import { describeAuth, isCompleteConfig, readConfig } from "./config.js";
import { embed, resolveEmbeddingApiKey } from "./embeddings/client.js";
import { probeCredentials } from "./llm/credentials.js";
import { resolveModel } from "./llm/models.js";
import { runSimpleStream, type StreamSimpleFn } from "./llm/stream.js";
import type { AgenrAuthMethod, AgenrConfig, AgenrProvider, ResolvedCredentials } from "./types.js";

export interface AuthStatusResult {
  configured: boolean;
  provider?: AgenrProvider;
  auth?: AgenrAuthMethod;
  model?: string;
  credentialAvailable: boolean;
  credentialSource?: string;
  authenticated?: boolean;
  embeddingsConfigured?: boolean;
  embeddingsAuthenticated?: boolean;
  embeddingsError?: string;
  guidance: string;
  error?: string;
}

export interface ConnectionTestInput {
  auth: AgenrAuthMethod;
  provider: AgenrProvider;
  model: string;
  credentials: ResolvedCredentials;
  streamSimpleImpl?: StreamSimpleFn;
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
}

export interface EmbeddingTestResult {
  ok: boolean;
  error?: string;
}

export interface StatusDeps {
  config?: AgenrConfig | null;
  connectionTestFn?: (input: ConnectionTestInput) => Promise<ConnectionTestResult>;
  embeddingConnectionTestFn?: (apiKey: string) => Promise<EmbeddingTestResult>;
}

function buildAuthTestContext(): Context {
  return {
    systemPrompt: "You are a connection test. Respond with OK.",
    messages: [
      {
        role: "user",
        content: "Respond with OK.",
        timestamp: Date.now(),
      },
    ],
  };
}

export async function runConnectionTest(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  try {
    const resolvedModel = resolveModel(input.provider, input.model);
    const response = await runSimpleStream({
      model: resolvedModel.model,
      context: buildAuthTestContext(),
      options: {
        apiKey: input.credentials.apiKey,
      },
      verbose: false,
      streamSimpleImpl: input.streamSimpleImpl,
    });

    if (response.stopReason === "error" || response.errorMessage) {
      return {
        ok: false,
        error: response.errorMessage ?? "Provider returned an authentication error.",
      };
    }

    return {
      ok: true,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runEmbeddingConnectionTest(apiKey: string): Promise<EmbeddingTestResult> {
  try {
    const vectors = await embed(["connection test"], apiKey);
    if (vectors.length === 1 && vectors[0] && vectors[0].length > 0) {
      return { ok: true };
    }
    return { ok: false, error: "Unexpected response: empty embedding vector" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runEmbeddingStatusCheck(
  config: AgenrConfig | null | undefined,
  env: NodeJS.ProcessEnv,
  testFn: (apiKey: string) => Promise<EmbeddingTestResult>,
): Promise<Pick<AuthStatusResult, "embeddingsConfigured" | "embeddingsAuthenticated" | "embeddingsError">> {
  let embeddingApiKey: string;
  try {
    embeddingApiKey = resolveEmbeddingApiKey(config, env);
  } catch {
    return {
      embeddingsConfigured: false,
      embeddingsAuthenticated: false,
    };
  }

  try {
    const embeddingTest = await testFn(embeddingApiKey);
    if (embeddingTest.ok) {
      return {
        embeddingsConfigured: true,
        embeddingsAuthenticated: true,
      };
    }

    return {
      embeddingsConfigured: true,
      embeddingsAuthenticated: false,
      embeddingsError: embeddingTest.error,
    };
  } catch (error) {
    return {
      embeddingsConfigured: true,
      embeddingsAuthenticated: false,
      embeddingsError: error instanceof Error ? error.message : String(error),
    };
  }
}

function configNotReadyResult(config: AgenrConfig | null): AuthStatusResult {
  return {
    configured: false,
    provider: config?.provider,
    auth: config?.auth,
    model: config?.model,
    credentialAvailable: false,
    guidance: "Not configured. Run `agenr setup`.",
  };
}

export function getQuickStatus(env: NodeJS.ProcessEnv = process.env): AuthStatusResult {
  const config = readConfig(env);
  if (!isCompleteConfig(config)) {
    return configNotReadyResult(config);
  }

  const probe = probeCredentials({
    auth: config.auth,
    storedCredentials: config.credentials,
    env,
  });

  if (!probe.available) {
    return {
      configured: true,
      provider: config.provider,
      auth: config.auth,
      model: config.model,
      credentialAvailable: false,
      guidance: probe.guidance,
    };
  }

  return {
    configured: true,
    provider: config.provider,
    auth: config.auth,
    model: config.model,
    credentialAvailable: true,
    credentialSource: probe.source,
    guidance: "Credentials available.",
  };
}

export async function getAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
  deps?: StatusDeps,
): Promise<AuthStatusResult> {
  const loadedConfig = deps?.config !== undefined ? deps.config : readConfig(env);
  const quick =
    deps?.config !== undefined
      ? (() => {
          if (!isCompleteConfig(loadedConfig)) {
            return configNotReadyResult(loadedConfig);
          }

          const probe = probeCredentials({
            auth: loadedConfig.auth,
            storedCredentials: loadedConfig.credentials,
            env,
          });

          if (!probe.available) {
            return {
              configured: true,
              provider: loadedConfig.provider,
              auth: loadedConfig.auth,
              model: loadedConfig.model,
              credentialAvailable: false,
              guidance: probe.guidance,
            } satisfies AuthStatusResult;
          }

          return {
            configured: true,
            provider: loadedConfig.provider,
            auth: loadedConfig.auth,
            model: loadedConfig.model,
            credentialAvailable: true,
            credentialSource: probe.source,
            guidance: "Credentials available.",
          } satisfies AuthStatusResult;
        })()
      : getQuickStatus(env);
  if (!quick.configured) {
    return quick;
  }

  if (!quick.credentialAvailable || !quick.auth || !quick.provider || !quick.model) {
    return {
      ...quick,
      authenticated: false,
    };
  }

  const probe = probeCredentials({
    auth: quick.auth,
    storedCredentials: loadedConfig?.credentials,
    env,
  });

  if (!probe.available || !probe.credentials) {
    return {
      ...quick,
      authenticated: false,
      guidance: probe.guidance,
    };
  }

  const test = await (deps?.connectionTestFn ?? runConnectionTest)({
    auth: quick.auth,
    provider: quick.provider,
    model: quick.model,
    credentials: probe.credentials,
  });
  const embeddings = await runEmbeddingStatusCheck(
    loadedConfig,
    env,
    deps?.embeddingConnectionTestFn ?? runEmbeddingConnectionTest,
  );

  if (!test.ok) {
    return {
      ...quick,
      ...embeddings,
      authenticated: false,
      guidance: `Not authenticated. ${probe.guidance}`,
      error: test.error,
    };
  }

  return {
    ...quick,
    ...embeddings,
    authenticated: true,
    guidance: "Authenticated.",
  };
}

export function formatAuthSummary(auth: AgenrAuthMethod): string {
  return describeAuth(auth);
}
