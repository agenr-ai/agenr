import type { AgenrConfig, KnowledgeEntry } from "../types.js";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 512;
export const EMBEDDING_BATCH_SIZE = 200;
export const EMBEDDING_MAX_CONCURRENCY = 3;

interface OpenAIEmbeddingItem {
  index: number;
  embedding: number[];
}

interface OpenAIEmbeddingResponse {
  data?: OpenAIEmbeddingItem[];
  error?: {
    message?: string;
  };
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    out.push(values.slice(i, i + chunkSize));
  }
  return out;
}

function getErrorSnippet(rawBody: string, fallbackMessage = "unknown error"): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(trimmed) as OpenAIEmbeddingResponse;
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  } catch {
    // Fall through to raw text truncation.
  }

  const maxLength = 200;
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

function buildHttpError(status: number, body: string): Error {
  const detail = getErrorSnippet(body);

  if (status === 401) {
    return new Error(`OpenAI embeddings request failed (401): invalid API key. ${detail}`);
  }

  if (status === 429) {
    return new Error(`OpenAI embeddings request failed (429): rate limited. ${detail}`);
  }

  return new Error(`OpenAI embeddings request failed (${status}): ${detail}`);
}

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: texts,
      }),
    });
  } catch (error) {
    throw new Error(
      `Failed to call OpenAI embeddings API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rawBody = await response.text();
  if (!response.ok) {
    throw buildHttpError(response.status, rawBody);
  }

  let parsed: OpenAIEmbeddingResponse;
  try {
    parsed = JSON.parse(rawBody) as OpenAIEmbeddingResponse;
  } catch (error) {
    throw new Error(
      `OpenAI embeddings response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed.data)) {
    throw new Error("OpenAI embeddings response missing data array.");
  }

  const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
  if (sorted.length !== texts.length) {
    throw new Error(
      `OpenAI embeddings response length mismatch: expected ${texts.length}, received ${sorted.length}.`,
    );
  }

  const embeddings: number[][] = [];
  for (const item of sorted) {
    if (!Array.isArray(item.embedding)) {
      throw new Error("OpenAI embeddings response contained an item with no embedding array.");
    }
    if (!item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("OpenAI embeddings response contained a non-numeric embedding value.");
    }
    embeddings.push(item.embedding);
  }

  return embeddings;
}

export function composeEmbeddingText(entry: KnowledgeEntry): string {
  return `${entry.type}: ${entry.subject} - ${entry.content}`;
}

export async function embed(texts: string[], apiKey: string): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new Error("OpenAI API key is required for embeddings.");
  }

  const batches = chunkArray(texts, EMBEDDING_BATCH_SIZE);
  const out = new Array<number[]>(texts.length);

  let nextBatchIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;

      if (batchIndex >= batches.length) {
        return;
      }

      const batch = batches[batchIndex];
      const batchEmbeddings = await embedBatch(batch, normalizedApiKey);
      const offset = batchIndex * EMBEDDING_BATCH_SIZE;
      for (let i = 0; i < batchEmbeddings.length; i += 1) {
        out[offset + i] = batchEmbeddings[i];
      }
    }
  };

  const workerCount = Math.min(EMBEDDING_MAX_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (out.some((item) => item === undefined)) {
    throw new Error("Embedding generation failed to return all vectors.");
  }

  return out;
}

export function resolveEmbeddingApiKey(
  config: AgenrConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEmbeddingConfig = config?.embedding?.apiKey?.trim();
  if (fromEmbeddingConfig) {
    return fromEmbeddingConfig;
  }

  const fromStoredCredentials = config?.credentials?.openaiApiKey?.trim();
  if (fromStoredCredentials) {
    return fromStoredCredentials;
  }

  const fromEnv = env.OPENAI_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error(
    "OpenAI API key is required for embeddings. Set config.embedding.apiKey, config.credentials.openaiApiKey, or OPENAI_API_KEY.",
  );
}
