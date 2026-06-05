import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  composeEmbeddingText,
  createEmbeddingClient,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  resolveEmbeddingApiKey,
  resolveEmbeddingModel,
} from "../../src/adapters/embeddings.js";
import { DURABLE_KINDS, type StoreDurableInput } from "../../src/core/types.js";

describe("composeEmbeddingText", () => {
  it("produces the expected format for each entry type", () => {
    for (const type of DURABLE_KINDS) {
      const entry: StoreDurableInput = {
        type,
        subject: "memory subject",
        content: "memory content",
      };

      expect(composeEmbeddingText(entry)).toBe(`${type}: memory subject - memory content`);
    }
  });
});

describe("resolveEmbeddingApiKey", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("prefers credentials.openaiApiKey over environment fallback", () => {
    process.env.OPENAI_API_KEY = "env-key";

    expect(
      resolveEmbeddingApiKey({
        credentials: {
          openaiApiKey: "embedding-key",
        },
      }),
    ).toBe("embedding-key");
  });

  it("falls back to OPENAI_API_KEY when config keys are missing", () => {
    process.env.OPENAI_API_KEY = "env-key";

    expect(resolveEmbeddingApiKey()).toBe("env-key");
  });

  it("throws when no embedding API key is available", () => {
    expect(() => resolveEmbeddingApiKey()).toThrow(/embedding api key is required/i);
  });
});

describe("resolveEmbeddingModel", () => {
  it("uses the configured embedding model when present", () => {
    expect(resolveEmbeddingModel({ embeddingModel: "text-embedding-custom" })).toBe("text-embedding-custom");
  });

  it("falls back to the default embedding model", () => {
    expect(resolveEmbeddingModel()).toBe(EMBEDDING_MODEL);
  });
});

describe("createEmbeddingClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("chunks 250 texts into two API calls", async () => {
    const requestBodies: Array<{ input: string[]; model: string; dimensions: number }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as { input: string[]; model: string; dimensions: number };
      requestBodies.push(requestBody);

      return new Response(
        JSON.stringify({
          data: requestBody.input.map((_, index) => ({
            index,
            embedding: [index, index + 1],
          })),
        }),
        { status: 200 },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createEmbeddingClient("test-key");
    const texts = Array.from({ length: 250 }, (_, index) => `text-${index}`);
    const embeddings = await client.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies).toEqual([
      {
        input: texts.slice(0, 200),
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      {
        input: texts.slice(200),
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
    ]);
    expect(embeddings).toHaveLength(250);
  });

  it("retries on 429 responses", async () => {
    vi.useFakeTimers();

    let attempt = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      attempt += 1;

      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
      }

      const requestBody = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: requestBody.input.map((_, index) => ({
            index,
            embedding: [index + 1, index + 2],
          })),
        }),
        { status: 200 },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createEmbeddingClient("test-key");
    const promise = client.embed(["retry-me"]);

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([[1, 2]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array for empty input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = createEmbeddingClient("test-key");

    await expect(client.embed([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the response length does not match the input length", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 2, 3] }],
        }),
        { status: 200 },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = createEmbeddingClient("test-key");

    await expect(client.embed(["a", "b"])).rejects.toThrow(/length mismatch/i);
  });
});
