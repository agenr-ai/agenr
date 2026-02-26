import { resolveModelForTask, type ModelTask } from "../config.js";
import { resolveModel } from "../llm/models.js";
import type { AgenrConfig, LlmClient } from "../types.js";

interface ToolCallBlock {
  type: string;
  name?: string;
  arguments?: unknown;
}

interface ToolCallResponse {
  content: ToolCallBlock[];
}

export function clampConfidence(value: number, defaultOnNaN = 0.5): number {
  if (!Number.isFinite(value)) {
    return defaultOnNaN;
  }
  return Math.min(1, Math.max(0, value));
}

export function resolveModelForLlmClient(
  client: LlmClient,
  taskKey: ModelTask,
  model?: string,
  config?: AgenrConfig,
): ReturnType<typeof resolveModel>["model"] {
  const modelId = model?.trim() || resolveModelForTask(config ?? {}, taskKey);
  return resolveModel(client.resolvedModel.provider, modelId).model;
}

export function extractToolCallArgs<T extends Record<string, unknown>>(
  response: ToolCallResponse,
  toolName: string,
  requiredFields: string[],
): T | null {
  for (const block of response.content) {
    if (block.type !== "toolCall" || block.name !== toolName) {
      continue;
    }

    if (!block.arguments || typeof block.arguments !== "object") {
      return null;
    }

    const args = block.arguments as Record<string, unknown>;
    const hasRequired = requiredFields.every((field) => args[field] !== undefined);
    if (!hasRequired) {
      return null;
    }

    return args as T;
  }

  return null;
}
