import { createHash } from "node:crypto";

import type { IngestionLlmPort, UsageStats } from "../../ingestion/ports.js";
import type { EmbeddingPort, LlmPort } from "../../../core/ports.js";
import type { ClaimKeyScenarioClaimExtractionFixtureResponse, ClaimKeyScenarioExtractionFixtureResponse } from "./fixture-loader.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 16_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
const EMBEDDING_DIMENSIONS = 1024;

/**
 * Shared metadata exposed by fixture-backed LLM clients.
 */
interface FixtureLlmMetadata {
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  };
}

/**
 * Creates the deterministic embedding port used by claim-key scenarios.
 *
 * @returns Local embedding adapter that never performs network calls.
 */
export function createDeterministicEmbeddingPort(): EmbeddingPort {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => hashToVector(text, EMBEDDING_DIMENSIONS));
    },
  };
}

/**
 * Creates an ingestion-style LLM client backed by one ordered fixture response list.
 *
 * @param responses - Ordered parsed extraction responses consumed in call order.
 * @returns Ingestion LLM port with deterministic replay behavior.
 */
export function createFixtureIngestionLlm(responses: ClaimKeyScenarioExtractionFixtureResponse[]): IngestionLlmPort {
  const usage = createUsageStats();

  return {
    metadata: {
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      usage,
    },
    async complete(): Promise<string> {
      throw new Error("Fixture ingestion LLM does not support complete().");
    },
    async completeJson<T>(_systemPrompt: string, _userMessage: string): Promise<T> {
      const next = readFixtureResponse(responses, usage);
      return { durables: next.entries } as T;
    },
  };
}

/**
 * Creates a generic fixture-backed LLM client for claim extraction or surgeon use.
 *
 * @param responses - Ordered typed fixture responses consumed in call order.
 * @returns LLM port with deterministic replay behavior.
 */
export function createFixtureLlm(responses: ClaimKeyScenarioClaimExtractionFixtureResponse[]): LlmPort & { metadata: FixtureLlmMetadata } {
  const usage = createLlmUsage();

  return {
    metadata: {
      usage,
    },
    async complete(): Promise<string> {
      throw new Error("Fixture LLM does not support complete().");
    },
    async completeJson<T>(_systemPrompt: string, _userMessage: string): Promise<T> {
      const next = readFixtureResponse(responses, usage);
      return next as T;
    },
  };
}

/**
 * Creates an empty usage object for ingestion fixture metadata.
 *
 * @returns Zeroed usage stats.
 */
export function createUsageStats(): UsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

/**
 * Converts input text into a deterministic normalized vector.
 *
 * @param text - Input text used as the vector source.
 * @param dimensions - Output vector length.
 * @returns Stable normalized embedding vector.
 */
export function hashToVector(text: string, dimensions: number): number[] {
  const vector: number[] = [];
  let counter = 0;

  while (vector.length < dimensions) {
    const block = createHash("sha256").update(text).update(String(counter)).digest();

    for (let offset = 0; offset + 4 <= block.length && vector.length < dimensions; offset += 4) {
      vector.push(block.readInt32LE(offset) / 0x7fffffff);
    }

    counter += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) {
    return Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
  }

  return vector.map((value) => value / magnitude);
}

/**
 * Builds the mutable metadata object shared by fixture-backed LLMs.
 *
 * @returns Mutable call-accounting metadata.
 */
function createLlmUsage(): FixtureLlmMetadata["usage"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
  };
}

/**
 * Loads the next fixture response and advances call-accounting metadata.
 *
 * @param responses - Ordered fixture response list.
 * @param metadata - Mutable call-accounting metadata.
 * @returns Next fixture response value.
 */
function readFixtureResponse<TResponse>(
  responses: TResponse[],
  usage: Pick<UsageStats, "calls" | "inputTokens" | "outputTokens" | "totalTokens" | "totalCost"> | FixtureLlmMetadata["usage"],
): TResponse {
  const callIndex = usage.inputTokens;
  usage.inputTokens += 1;
  usage.outputTokens += 1;
  if ("calls" in usage) {
    usage.calls += 1;
    usage.totalTokens += 2;
  }

  const response = responses[callIndex];
  if (response === undefined) {
    throw new Error(`Fixture LLM exhausted responses after ${callIndex} calls.`);
  }

  if (isFixtureError(response)) {
    throw new Error(response.__error);
  }

  return response;
}

/**
 * Checks whether one fixture response should be surfaced as a thrown error.
 *
 * @param value - Typed fixture response candidate.
 * @returns True when the fixture represents a forced LLM error.
 */
function isFixtureError(value: unknown): value is { __error: string } {
  return typeof value === "object" && value !== null && "__error" in value && typeof value.__error === "string";
}
