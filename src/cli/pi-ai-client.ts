import { complete, getModel, getOAuthApiKey, stream } from "@mariozechner/pi-ai";
import type { Api, Context, KnownProvider, Model, OAuthCredentials } from "@mariozechner/pi-ai";

import type { LlmProvider } from "./types";

type OAuthProvider = "openai-codex" | "anthropic";

interface CompleteTextOptions {
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
}

interface StreamTextOptions extends CompleteTextOptions {
  onThinking: (text: string) => void;
  onText: (text: string) => void;
}

export type PiAiModel = Model<Api>;

export function resolvePiAiModel(provider: LlmProvider, modelId: string): PiAiModel {
  try {
    return getModel(provider as KnownProvider, modelId as never) as PiAiModel;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unsupported model '${modelId}' for provider '${provider}': ${message}`);
  }
}

function isOpenAiFamilyApi(model: PiAiModel): boolean {
  const api = model.api.toLowerCase();
  return api.startsWith("openai-") || api.startsWith("azure-openai-");
}

export function isReasoningModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;

  if (id.includes("codex")) return true;
  if (id.startsWith("gpt-5")) return true;
  if (/^o\d+([-.][a-z0-9]+)*$/.test(id)) return true;
  if (id.includes("reasoning")) return true;

  return false;
}

export function shouldStripSamplingParams(model: PiAiModel): boolean {
  return isOpenAiFamilyApi(model) && isReasoningModelId(model.id);
}

export function buildCompleteRequestOptions(
  model: PiAiModel,
  options: CompleteTextOptions,
): Record<string, unknown> {
  const requestOptions: Record<string, unknown> = {
    apiKey: options.apiKey,
  };

  if (!shouldStripSamplingParams(model)) {
    if (options.temperature !== undefined) requestOptions.temperature = options.temperature;
    if (options.maxTokens !== undefined) requestOptions.maxTokens = options.maxTokens;
  }

  return requestOptions;
}

export async function completeText(
  model: PiAiModel,
  systemPrompt: string,
  userPrompt: string,
  options: CompleteTextOptions,
): Promise<string> {
  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
        timestamp: Date.now(),
      },
    ],
  };

  // OpenAI-family reasoning models do not accept temperature/maxTokens params.
  const streamOptions = buildCompleteRequestOptions(model, options);

  const response = await complete(model, context, streamOptions);

  const text = response.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

  if (!text) {
    const errorMsg = (response as any).errorMessage;
    throw new Error(errorMsg
      ? `Model returned no text output: ${errorMsg}`
      : "Model response did not contain text output");
  }

  return text;
}

function extractDelta(event: { delta?: string; text?: string; thinking?: string }): string {
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string") return event.text;
  if (typeof event.thinking === "string") return event.thinking;
  return "";
}

function addThinkingOptionsForStream(model: PiAiModel, streamOptions: Record<string, unknown>): void {
  switch (model.api) {
    case "openai-codex-responses":
      streamOptions.reasoningEffort = "high";
      streamOptions.reasoningSummary = "detailed";
      return;
    case "openai-responses":
    case "openai-completions":
    case "azure-openai-responses":
      // OpenAI-family providers only emit reasoning deltas when reasoning is explicitly enabled.
      streamOptions.reasoningEffort = "high";
      streamOptions.reasoningSummary = "detailed";
      return;
    case "anthropic-messages":
      // Anthropic emits thinking deltas only when extended thinking is enabled.
      streamOptions.thinkingEnabled = true;
      streamOptions.effort = "high";
      return;
    default:
      return;
  }
}

function isAnthropicThinkingStream(model: PiAiModel, streamOptions: Record<string, unknown>): boolean {
  return model.api === "anthropic-messages" && streamOptions.thinkingEnabled === true;
}

export function buildStreamRequestOptions(
  model: PiAiModel,
  options: StreamTextOptions,
): Record<string, unknown> {
  const streamOptions: Record<string, unknown> = {
    apiKey: options.apiKey,
  };
  addThinkingOptionsForStream(model, streamOptions);

  if (shouldStripSamplingParams(model)) {
    return streamOptions;
  }

  if (isAnthropicThinkingStream(model, streamOptions)) {
    // Anthropic extended thinking requires temperature=1 (or adaptive mode).
    streamOptions.temperature = 1;
  } else if (options.temperature !== undefined) {
    streamOptions.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) streamOptions.maxTokens = options.maxTokens;

  return streamOptions;
}

export async function streamText(
  model: PiAiModel,
  systemPrompt: string,
  userPrompt: string,
  options: StreamTextOptions,
): Promise<string> {
  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
        timestamp: Date.now(),
      },
    ],
  };

  // OpenAI-family reasoning models do not accept temperature/maxTokens params.
  const streamOptions = buildStreamRequestOptions(model, options);

  const eventStream = stream(model, context, streamOptions);
  const textByIndex = new Map<number, string>();
  const thinkingByIndex = new Map<number, string>();
  let doneMessageError: string | undefined;

  for await (const event of eventStream) {
    if (event.type === "thinking_delta") {
      const chunk = extractDelta(event as typeof event & { thinking?: string });
      if (chunk) {
        const existing = thinkingByIndex.get(event.contentIndex) ?? "";
        thinkingByIndex.set(event.contentIndex, `${existing}${chunk}`);
        options.onThinking(chunk);
      }
      continue;
    }

    if (event.type === "thinking_end" && !thinkingByIndex.has(event.contentIndex)) {
      thinkingByIndex.set(event.contentIndex, event.content);
      if (event.content) options.onThinking(event.content);
      continue;
    }

    if (event.type === "text_delta") {
      const chunk = extractDelta(event as typeof event & { text?: string });
      if (!chunk) continue;

      const existing = textByIndex.get(event.contentIndex) ?? "";
      textByIndex.set(event.contentIndex, `${existing}${chunk}`);
      options.onText(chunk);
      continue;
    }

    if (event.type === "text_end" && !textByIndex.has(event.contentIndex)) {
      textByIndex.set(event.contentIndex, event.content);
      if (event.content) options.onText(event.content);
      continue;
    }

    if (event.type === "done") {
      doneMessageError = event.message.errorMessage;
    }

    if (event.type === "error") {
      doneMessageError = event.error.errorMessage ?? "Model stream returned an error";
    }
  }

  const text = [...textByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(
      doneMessageError
        ? `Model returned no text output: ${doneMessageError}`
        : "Model response did not contain text output",
    );
  }

  return text;
}

export async function resolveOAuthApiKey(
  provider: OAuthProvider,
  credentials: OAuthCredentials,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  return getOAuthApiKey(provider, { [provider]: credentials });
}
