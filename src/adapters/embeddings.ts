import type { AgenrConfig } from "../config.js";
import type { EmbeddingPort } from "../core/ports.js";
import { composeEmbeddingText } from "../core/store/embedding-text.js";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
/**
 * Default OpenAI embedding model used by agenr.
 */
const EMBEDDING_MODEL = "text-embedding-3-small";
/**
 * Embedding vector size produced by the default model.
 */
const EMBEDDING_DIMENSIONS = 1024;
const EMBEDDING_BATCH_SIZE = 200;
const EMBEDDING_MAX_CONCURRENCY = 3;
const EMBEDDING_MAX_RETRIES = 5;

/** Single embedding item returned by the OpenAI embeddings API. */
interface OpenAIEmbeddingItem {
  index: number;
  embedding: unknown;
}

/** OpenAI embeddings API response payload used by the adapter. */
interface OpenAIEmbeddingResponse {
  data?: OpenAIEmbeddingItem[];
  error?: {
    message?: string;
  };
}

/**
 * Creates an OpenAI-backed embedding client that implements the core embedding port.
 *
 * @param apiKey - OpenAI API key used for embedding requests.
 * @param model - Optional embedding model override. Defaults to the v1 baseline model.
 * @returns Embedding port implementation for batch embedding requests.
 */
export function createEmbeddingClient(apiKey: string, model = EMBEDDING_MODEL): EmbeddingPort {
  const normalizedApiKey = apiKey.trim();
  if (normalizedApiKey.length === 0) {
    throw new Error("Embedding API key must not be empty.");
  }

  const normalizedModel = model.trim().length > 0 ? model.trim() : EMBEDDING_MODEL;

  return {
    embed: async (texts: string[]): Promise<number[][]> => embedTexts(texts, normalizedApiKey, normalizedModel),
  };
}

/**
 * Resolves the API key used for embedding requests.
 *
 * @param config - Optional loaded agenr configuration.
 * @returns API key to use for the embedding provider.
 * @throws Error When no OpenAI embedding credential is configured.
 */
export function resolveEmbeddingApiKey(config?: AgenrConfig): string {
  const candidates = [config?.credentials?.openaiApiKey, process.env.OPENAI_API_KEY];

  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized && normalized.length > 0) {
      return normalized;
    }
  }

  throw new Error("Embedding API key is required. Set config.credentials.openaiApiKey or OPENAI_API_KEY.");
}

/**
 * Resolves the embedding model from config or falls back to the default model.
 *
 * @param config - Optional loaded agenr configuration.
 * @returns Embedding model name to send to OpenAI.
 */
export function resolveEmbeddingModel(config?: AgenrConfig): string {
  const configuredModel = config?.embeddingModel?.trim();
  return configuredModel && configuredModel.length > 0 ? configuredModel : EMBEDDING_MODEL;
}

export { composeEmbeddingText };
export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL };

/**
 * Wraps an embedding-client factory so the underlying client is constructed
 * only on the first non-empty embed call.
 *
 * This lets callers thread an embedding port into flows that may never embed
 * (for example dreaming dry runs) without forcing credential resolution up
 * front. Embedding an empty batch never constructs the client.
 *
 * @param createClient - Factory that builds the concrete embedding client.
 * @returns Embedding port that defers client construction until first use.
 */
export function createLazyEmbeddingClient(createClient: () => EmbeddingPort): EmbeddingPort {
  let cached: EmbeddingPort | null = null;
  return {
    embed: async (texts: string[]): Promise<number[][]> => {
      if (texts.length === 0) {
        return [];
      }
      cached ??= createClient();
      return cached.embed(texts);
    },
  };
}

/** Embeds a list of texts in bounded concurrent batches. */
async function embedTexts(texts: string[], apiKey: string, model: string): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const chunks = chunkValues(texts, EMBEDDING_BATCH_SIZE);
  const chunkResults = new Array<number[][]>(chunks.length);
  let nextChunkIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(EMBEDDING_MAX_CONCURRENCY, chunks.length) }, async () => {
      while (true) {
        const chunkIndex = nextChunkIndex;
        nextChunkIndex += 1;

        if (chunkIndex >= chunks.length) {
          return;
        }

        chunkResults[chunkIndex] = await requestEmbeddingBatch(chunks[chunkIndex], apiKey, model);
      }
    }),
  );

  return chunkResults.flat();
}

/** Sends one embedding batch request with retry handling. */
async function requestEmbeddingBatch(texts: string[], apiKey: string, model: string): Promise<number[][]> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= EMBEDDING_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          dimensions: EMBEDDING_DIMENSIONS,
          input: texts,
        }),
      });

      const rawBody = await response.text();
      if (!response.ok) {
        lastError = buildHttpError(response.status, rawBody);
        if (attempt < EMBEDDING_MAX_RETRIES && isRetryableStatus(response.status)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      return parseEmbeddingResponse(rawBody, texts.length);
    } catch (error) {
      lastError = normalizeFetchError(error);
      if (attempt < EMBEDDING_MAX_RETRIES && isRetryableError(lastError)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("OpenAI embeddings request failed.");
}

/** Parses and validates an embeddings API response body. */
function parseEmbeddingResponse(rawBody: string, expectedLength: number): number[][] {
  let parsed: OpenAIEmbeddingResponse;
  try {
    parsed = JSON.parse(rawBody) as OpenAIEmbeddingResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI embeddings response was not valid JSON: ${message}`, {
      cause: error,
    });
  }

  if (!Array.isArray(parsed.data)) {
    throw new Error("OpenAI embeddings response missing data array.");
  }

  const sorted = [...parsed.data].sort((left, right) => left.index - right.index);
  if (sorted.length !== expectedLength) {
    throw new Error(`OpenAI embeddings response length mismatch: expected ${expectedLength}, received ${sorted.length}.`);
  }

  return sorted.map((item) => {
    if (!Array.isArray(item.embedding)) {
      throw new Error("OpenAI embeddings response contained an item with no embedding array.");
    }

    if (!item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("OpenAI embeddings response contained a non-numeric embedding value.");
    }

    return [...item.embedding];
  });
}

/** Normalizes fetch failures into `Error` instances. */
function normalizeFetchError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/** Checks whether an HTTP status should trigger an embedding retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Checks whether a normalized fetch error should trigger a retry. */
function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("fetch failed")
  );
}

/** Builds a descriptive error for a failed embeddings HTTP response. */
function buildHttpError(status: number, rawBody: string): Error {
  const detail = getErrorSnippet(rawBody);

  if (status === 401) {
    return new Error(`OpenAI embeddings request failed (401): invalid API key. ${detail}`);
  }

  if (status === 429) {
    return new Error(`OpenAI embeddings request failed (429): rate limited. ${detail}`);
  }

  return new Error(`OpenAI embeddings request failed (${status}): ${detail}`);
}

/** Extracts a short human-readable snippet from an error response body. */
function getErrorSnippet(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) {
    return "unknown error";
  }

  try {
    const parsed = JSON.parse(trimmed) as OpenAIEmbeddingResponse;
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  } catch {
    // Fall back to the raw body snippet.
  }

  const maxLength = 200;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`;
}

/** Splits an array into fixed-size embedding request batches. */
function chunkValues<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

/** Computes exponential backoff for repeated embedding failures. */
function backoffMs(attempt: number): number {
  return Math.min(2000 * 2 ** (attempt - 1), 60_000);
}

/** Waits for the provided duration before retrying. */
async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
