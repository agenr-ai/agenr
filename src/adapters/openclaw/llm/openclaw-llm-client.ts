import { completeSimple, getModel, type Api, type Model } from "@mariozechner/pi-ai";

import type { LlmPort } from "../../../core/ports.js";
import { resolveOpenClawEmbeddedAgentExecution } from "../embedded-agent/task-runner.js";
import type { AgenrOpenClawHost } from "../types.js";

/** Stringly typed `getModel` signature used to avoid provider narrowing friction. */
type GetModelWithStrings = (provider: string, modelId: string) => Model<Api>;

const getModelWithStrings = getModel as unknown as GetModelWithStrings;

/**
 * Creates a lightweight pi-ai-backed LLM port using OpenClaw's credential system.
 *
 * The provider/model resolution follows the same override and default-agent
 * model behavior as the embedded-agent paths, but this client executes a direct
 * completion call without the heavier embedded-agent lifecycle.
 *
 * @param openClaw - OpenClaw host config and runtime helpers.
 * @param modelRef - Optional `provider/model` override from plugin config.
 * @param label - Caller-specific label used when reporting invalid overrides.
 * @returns LLM port backed by OpenClaw-resolved credentials.
 * @throws Error When the model override is invalid or OpenClaw cannot resolve
 *   an API-key-compatible credential for the selected provider.
 */
export async function createOpenClawLlmClient(openClaw: AgenrOpenClawHost, modelRef?: string, label = "model override"): Promise<LlmPort> {
  const execution = resolveOpenClawEmbeddedAgentExecution({
    openClaw,
    modelOverride: modelRef,
    invalidOverrideLabel: label,
  });
  const model = getModelWithStrings(execution.provider, execution.model);
  const auth = await openClaw.runtime.modelAuth.resolveApiKeyForProvider({
    provider: execution.provider,
    cfg: openClaw.config,
  });
  const apiKey = normalizeOptionalString(auth.apiKey);
  if (!apiKey) {
    throw new Error(`OpenClaw auth did not resolve an API-key-compatible credential for ${execution.provider} (source=${auth.source}, mode=${auth.mode}).`);
  }

  const complete = async (systemPrompt: string, userMessage: string): Promise<string> => {
    const response = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: userMessage,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
      },
    );

    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? `LLM completion failed for ${execution.provider}/${execution.model}.`);
    }

    return extractText(response);
  };

  return {
    complete,
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      const text = await complete(systemPrompt, userMessage);
      return JSON.parse(stripCodeFence(text)) as T;
    },
  };
}

/** Extracts assistant text blocks from one pi-ai response. */
function extractText(response: { content?: Array<{ type: string; text?: string }> }): string {
  if (!response.content) {
    return "";
  }

  return response.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text ?? "")
    .join("");
}

/** Removes one outer Markdown code fence from model output when present. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]+?)\s*```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** Trims optional strings and collapses empty values to `undefined`. */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
