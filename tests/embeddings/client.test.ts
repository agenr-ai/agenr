import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingCache } from "../../src/embeddings/cache.js";
import {
  composeEmbeddingText,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_CONCURRENCY,
  embed,
  resolveEmbeddingApiKey,
} from "../../src/embeddings/client.js";

function makeEmbeddingResponse(input: string[]): Response {
  return new Response(
    JSON.stringify({
      data: input.map((text, index) => {
        const numericSuffix = Number(text.split("-").at(-1));
        return {
          index,
          embedding: [Number.isNaN(numericSuffix) ? index : numericSuffix],
        };
      }),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("embeddings client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("composeEmbeddingText formats type, subject, and content", () => {
    const text = composeEmbeddingText({
      type: "preference",
      subject: "Jim",
      content: "prefers pnpm",
      importance: 8,
      expiry: "permanent",
      tags: ["tooling"],
      source: {
        file: "x.json",
        context: "test",
      },
    });

    expect(text).toBe("preference: Jim - prefers pnpm");
  });

  it("splits large input into batches and preserves output order", async () => {
    const inputs = Array.from({ length: 250 }, (_, index) => `item-${index}`);
    const batchSizes: number[] = [];
    const seenDimensions: number[] = [];

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; dimensions?: number };
      batchSizes.push(body.input.length);
      seenDimensions.push(body.dimensions ?? -1);
      return makeEmbeddingResponse(body.input);
    }) as typeof fetch;

    const vectors = await embed(inputs, "sk-test");

    expect(batchSizes).toEqual([EMBEDDING_BATCH_SIZE, 50]);
    expect(seenDimensions.every((value) => value === EMBEDDING_DIMENSIONS)).toBe(true);
    expect(vectors).toHaveLength(250);
    expect(vectors[0]).toEqual([0]);
    expect(vectors[125]).toEqual([125]);
    expect(vectors[249]).toEqual([249]);
  });

  it("caps concurrent batch requests at 3", async () => {
    const inputs = Array.from({ length: 650 }, (_, index) => `item-${index}`);
    let inFlight = 0;
    let maxInFlight = 0;

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      try {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        await new Promise((resolve) => setTimeout(resolve, 15));
        return makeEmbeddingResponse(body.input);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;

    await embed(inputs, "sk-test");

    expect(maxInFlight).toBeLessThanOrEqual(EMBEDDING_MAX_CONCURRENCY);
  });

  it("throws a descriptive error for 401 responses", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(embed(["item-1"], "sk-test")).rejects.toThrow("401");
    await expect(embed(["item-1"], "sk-test")).rejects.toThrow("invalid API key");
  });

  it("throws a descriptive error for 429 responses", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const promise = embed(["item-1"], "sk-test");
      const assertion = expect(promise).rejects.toThrow(/429.*rate limited/i);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock.mock.calls.length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries embeddings on 429 and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      let callCount = 0;

      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: { message: "slow down" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }

        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return makeEmbeddingResponse(body.input);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const promise = embed(["item-12"], "sk-test");
      await vi.runAllTimersAsync();
      const vectors = await promise;

      expect(callCount).toBe(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
      expect(vectors).toEqual([[12]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on malformed success payloads", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ nope: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(embed(["item-1"], "sk-test")).rejects.toThrow("missing data array");
  });

  it("resolves embedding API key by configured priority", () => {
    expect(
      resolveEmbeddingApiKey({
        embedding: { apiKey: "sk-embed" },
        credentials: { openaiApiKey: "sk-cred" },
      }),
    ).toBe("sk-embed");

    expect(
      resolveEmbeddingApiKey(
        {
          credentials: { openaiApiKey: "sk-cred" },
        },
        {
          ...process.env,
          OPENAI_API_KEY: "sk-env",
        },
      ),
    ).toBe("sk-cred");

    expect(
      resolveEmbeddingApiKey(
        {},
        {
          ...process.env,
          OPENAI_API_KEY: "sk-env",
        },
      ),
    ).toBe("sk-env");
  });

  it("EmbeddingCache supports hit and miss lookups", () => {
    const cache = new EmbeddingCache();

    expect(cache.get("missing")).toBeUndefined();

    const embedding = [0.1, 0.2, 0.3];
    cache.set("fact: Jim - uses pnpm", embedding);

    expect(cache.get("fact: Jim - uses pnpm")).toEqual(embedding);
  });
});
