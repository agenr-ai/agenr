import { resolveModel } from "./model-aliases";
import { resolveCredentials } from "./credentials";
import { resolvePiAiModel, streamText } from "./pi-ai-client";
import type { AgenrConfig, ConfigOverrides, ResolvedLlmRuntime } from "./types";

interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

interface StreamOptions extends CompletionOptions {
  onThinking?: (text: string) => void;
  onText?: (text: string) => void;
}

export const AGENR_LLM_SYSTEM_PROMPT = [
  "You are generating production-ready integrations for Agenr.",
  "Agenr is the trust and commerce layer between AI agents and real-world businesses.",
  "Output must align with AGP protocol operations: discover, query, and execute.",
  "When asked to generate adapters, produce strict TypeScript and valid JSON that match the provided schemas/examples.",
  "Prefer concrete endpoint/auth details from provided docs and avoid inventing unsupported capabilities.",
].join(" ");

export async function resolveLlmRuntime(
  config: AgenrConfig,
  overrides: ConfigOverrides = {},
): Promise<ResolvedLlmRuntime> {
  const credentials = await resolveCredentials(config, overrides.provider);
  const modelId = resolveModel(credentials.provider, config.llm.model, overrides.model);
  const model = resolvePiAiModel(credentials.provider, modelId);

  return {
    provider: credentials.provider,
    source: credentials.source,
    authMode: credentials.authMode,
    token: credentials.token,
    refreshToken: credentials.refreshToken,
    model: model.id,
    expiresAt: credentials.expiresAt,
    accountId: credentials.accountId,
    baseUrl: credentials.baseUrl,
  };
}

export function isLlmAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /request failed \((401|403)\)|unauthorized|forbidden|invalid[_\s-]?api[_\s-]?key|authentication|token expired|expired token|failed to refresh oauth token/i.test(
    message,
  );
}

export async function streamPrompt(
  runtime: ResolvedLlmRuntime,
  prompt: string,
  options?: StreamOptions,
): Promise<string> {
  const systemPrompt = options?.systemPrompt?.trim() || AGENR_LLM_SYSTEM_PROMPT;
  const model = resolvePiAiModel(runtime.provider, runtime.model);

  return streamText(model, systemPrompt, prompt, {
    apiKey: runtime.token,
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    onThinking: options?.onThinking ?? (() => {}),
    onText: options?.onText ?? (() => {}),
  });
}
