import type { AgenrConfig } from "../../config.js";
import type { CrossEncoderPassage, CrossEncoderPort, CrossEncoderScore } from "../../core/ports.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
/**
 * Fallback cross-encoder model when callers construct the adapter without
 * a model. The runtime factories (CLI and OpenClaw) resolve the model
 * through `resolveModel(config, "cross_encoder")` which honors
 * `config.crossEncoderModel`. This constant exists so standalone uses of
 * the adapter still work; it mirrors the stage default.
 */
const DEFAULT_MODEL = "gpt-5.4-nano";
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Logit-bias hint for the `True` and `False` tokens. These IDs match the
 * OpenAI cl100k-style tokenizer shared by the gpt-4.1 and gpt-5.x families
 * `openai_reranker_client.py`. Holding them in a named constant keeps
 * the rest of the adapter declarative.
 */
const LOGIT_BIAS: Record<string, number> = {
  "6432": 1, // "True"
  "7983": 1, // "False"
};

const SYSTEM_PROMPT = "You are an expert tasked with determining whether the passage is relevant to the query";

/**
 * Optional runtime overrides accepted by `createOpenAICrossEncoder`.
 */
export interface OpenAICrossEncoderOptions {
  /** OpenAI API key. Required; inherited from config by the factory helper. */
  apiKey: string;
  /**
   * Chat-completions model used for the boolean classifier prompt.
   * Must be an OpenAI model that supports `logit_bias` and
   * `top_logprobs`. Defaults to the cross-encoder stage model resolved by
   * `resolveModel(config, "cross_encoder")` at the factory sites.
   */
  model?: string;
  /** Override for the OpenAI base URL (for example, Azure or proxy hosts). */
  baseUrl?: string;
  /** Maximum number of concurrent boolean-classifier calls. Defaults to 4. */
  maxConcurrency?: number;
  /**
   * Maximum retry count per passage on retryable network or rate-limit
   * failures. Defaults to two retries; the port fails closed beyond that.
   */
  maxRetries?: number;
  /**
   * Injectable fetch implementation. Exposed so tests can stub network calls
   * without monkey-patching globals.
   */
  fetchImpl?: typeof fetch;
  /**
   * Override for the per-request timeout in milliseconds. Defaults to 20000.
   */
  requestTimeoutMs?: number;
}

/** One top-logprob returned by the chat completions API. */
interface ChatCompletionTopLogProb {
  token?: string;
  logprob?: number;
}

/** Logprob payload attached to a chat completion choice. */
interface ChatCompletionLogProbs {
  content?: Array<{
    token?: string;
    logprob?: number;
    top_logprobs?: ChatCompletionTopLogProb[];
  }>;
}

/** One choice returned by the chat completions API. */
interface ChatCompletionChoice {
  message?: {
    content?: string;
  };
  logprobs?: ChatCompletionLogProbs;
}

/** Chat completions API response shape used by the reranker. */
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
    type?: string;
  };
}

/**
 * Creates an OpenAI-backed cross-encoder adapter.
 *
 * Issues one boolean-classifier chat completion per passage concurrently
 * (bounded by `maxConcurrency`) and extracts the `True`/`False`
 * top-logprob from the response to derive a relevance score in `[0, 1]`.
 *
 * Fails closed: when a passage's request throws, hits a non-retryable
 * status, or returns malformed logprobs, the passage is omitted from
 * the returned score list. The recall helper treats that as a
 * `provider_error` and short-circuits back to the input ordering, so a
 * broken provider can never drop recall below its pre-rerank baseline.
 *
 * @param options - Adapter configuration including the API key.
 * @returns `CrossEncoderPort` ready to be wired into recall.
 */
export function createOpenAICrossEncoder(options: OpenAICrossEncoderOptions): CrossEncoderPort {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error("OpenAI cross-encoder adapter requires a non-empty API key.");
  }

  const model = normalizeOptional(options.model) ?? DEFAULT_MODEL;
  const baseUrl = normalizeOptional(options.baseUrl) ?? OPENAI_CHAT_COMPLETIONS_URL;
  const maxConcurrency = clampPositiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
  const maxRetries = clampPositiveInteger(options.maxRetries, DEFAULT_MAX_RETRIES, { allowZero: true });
  const requestTimeoutMs = clampPositiveInteger(options.requestTimeoutMs, REQUEST_TIMEOUT_MS);
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;

  return {
    async rank(query: string, passages: readonly CrossEncoderPassage[]): Promise<CrossEncoderScore[]> {
      if (passages.length === 0) {
        return [];
      }

      const trimmedQuery = query.trim();
      if (trimmedQuery.length === 0) {
        return [];
      }

      const results = new Array<CrossEncoderScore | null>(passages.length).fill(null);
      let nextIndex = 0;
      const workerCount = Math.max(1, Math.min(maxConcurrency, passages.length));

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= passages.length) {
              return;
            }

            const passage = passages[index];
            const score = await rankSinglePassage({
              apiKey,
              baseUrl,
              model,
              query: trimmedQuery,
              passage,
              fetchImpl,
              maxRetries,
              requestTimeoutMs,
            });

            if (score !== null) {
              results[index] = { id: passage.id, score };
            }
          }
        }),
      );

      return results.filter((result): result is CrossEncoderScore => result !== null);
    },
  };
}

/**
 * Resolves the cross-encoder API key from an agenr configuration or
 * falls back to the `OPENAI_API_KEY` environment variable.
 *
 * @param config - Optional loaded agenr configuration.
 * @returns OpenAI API key usable by the cross-encoder.
 * @throws Error When no OpenAI credential is configured.
 */
export function resolveCrossEncoderApiKey(config?: AgenrConfig): string {
  const candidates = [config?.credentials?.openaiApiKey, process.env.OPENAI_API_KEY];
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized && normalized.length > 0) {
      return normalized;
    }
  }

  throw new Error("Cross-encoder API key is required. Set config.credentials.openaiApiKey or OPENAI_API_KEY.");
}

/**
 * Runs the boolean-classifier prompt for a single passage, with bounded
 * retries for retryable network or rate-limit errors.
 */
async function rankSinglePassage(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  query: string;
  passage: CrossEncoderPassage;
  fetchImpl: typeof fetch;
  maxRetries: number;
  requestTimeoutMs: number;
}): Promise<number | null> {
  const body = JSON.stringify({
    model: params.model,
    temperature: 0,
    max_tokens: 1,
    logit_bias: LOGIT_BIAS,
    logprobs: true,
    top_logprobs: 2,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildUserPrompt(params.query, params.passage.text),
      },
    ],
  });

  let attempt = 0;
  while (true) {
    const outcome = await performSingleRequest({
      ...params,
      body,
    });

    if (outcome.kind === "score") {
      return outcome.value;
    }

    if (outcome.kind === "fatal" || attempt >= params.maxRetries) {
      return null;
    }

    attempt += 1;
    await sleep(backoffMs(attempt));
  }
}

type RequestOutcome = { kind: "score"; value: number } | { kind: "fatal" } | { kind: "retryable" };

/**
 * Performs one HTTP round-trip and classifies the outcome as a score,
 * a retryable failure, or a fatal failure.
 */
async function performSingleRequest(params: {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  body: string;
  requestTimeoutMs: number;
}): Promise<RequestOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.requestTimeoutMs);
  try {
    const response = await params.fetchImpl(params.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: params.body,
      signal: controller.signal,
    });

    const rawBody = await response.text();
    if (!response.ok) {
      return isRetryableStatus(response.status) ? { kind: "retryable" } : { kind: "fatal" };
    }

    const score = parseRelevanceScore(rawBody);
    return score === null ? { kind: "fatal" } : { kind: "score", value: score };
  } catch {
    return { kind: "retryable" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extracts the normalized relevance score from a chat-completion response.
 *
 * - Reads the first top-logprob for the single generated token.
 * - If the token case-insensitively starts with `true`, the score is
 *   `exp(logprob)`. Otherwise the score is `1 - exp(logprob)`.
 * - Returns `null` on any malformed payload so the adapter can fail closed.
 */
function parseRelevanceScore(rawBody: string): number | null {
  let parsed: ChatCompletionResponse;
  try {
    parsed = JSON.parse(rawBody) as ChatCompletionResponse;
  } catch {
    return null;
  }

  const firstChoice = parsed.choices?.[0];
  const topLogprobs = firstChoice?.logprobs?.content?.[0]?.top_logprobs;
  if (!Array.isArray(topLogprobs) || topLogprobs.length === 0) {
    return null;
  }

  const top = topLogprobs[0];
  if (!top || typeof top.logprob !== "number" || !Number.isFinite(top.logprob) || typeof top.token !== "string") {
    return null;
  }

  const normalizedProb = Math.exp(top.logprob);
  const tokenFirstWord = top.token.trim().split(/\s+/)[0]?.toLowerCase();
  const score = tokenFirstWord === "true" ? normalizedProb : 1 - normalizedProb;

  if (!Number.isFinite(score)) {
    return null;
  }

  if (score <= 0) {
    return 0;
  }

  if (score >= 1) {
    return 1;
  }

  return score;
}

/**
 * Builds the per-passage classifier prompt
 * Literal XML-style tags keep the passage and query
 * clearly segmented even when either side contains incidental braces.
 */
function buildUserPrompt(query: string, passage: string): string {
  return `Respond with "True" if PASSAGE is relevant to QUERY and "False" otherwise.
<PASSAGE>
${passage}
</PASSAGE>
<QUERY>
${query}
</QUERY>`;
}

/** Checks whether an HTTP status should trigger a cross-encoder retry. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/** Clamps a positive integer with optional zero support. */
function clampPositiveInteger(value: number | undefined, fallback: number, opts?: { allowZero?: boolean }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 0) {
    return fallback;
  }

  if (floored === 0) {
    return opts?.allowZero === true ? 0 : fallback;
  }

  return floored;
}

/** Normalizes optional strings into trimmed non-empty values. */
function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Computes exponential backoff between cross-encoder retries. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 5_000);
}

/** Waits for the provided duration before retrying. */
async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
