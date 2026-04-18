import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../../../src/adapters/cross-encoder/openai-cross-encoder.js";

describe("resolveCrossEncoderApiKey", () => {
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

  it("prefers credentials.openaiApiKey over the environment fallback", () => {
    process.env.OPENAI_API_KEY = "env-key";

    expect(
      resolveCrossEncoderApiKey({
        credentials: { openaiApiKey: "config-key" },
      }),
    ).toBe("config-key");
  });

  it("falls back to OPENAI_API_KEY when the config secret is missing", () => {
    process.env.OPENAI_API_KEY = "env-key";

    expect(resolveCrossEncoderApiKey()).toBe("env-key");
  });

  it("throws when no cross-encoder credential is configured", () => {
    expect(() => resolveCrossEncoderApiKey()).toThrow(/cross-encoder api key is required/i);
  });
});

describe("createOpenAICrossEncoder", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects an empty API key", () => {
    expect(() => createOpenAICrossEncoder({ apiKey: "  " })).toThrow(/non-empty api key/i);
  });

  it("returns empty scores when called with no passages", async () => {
    const fetchMock = vi.fn();
    const port = createOpenAICrossEncoder({
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(port.rank("query", [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty scores when the query trims to empty", async () => {
    const fetchMock = vi.fn();
    const port = createOpenAICrossEncoder({
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(port.rank("   ", [{ id: "alpha", text: "body" }])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives the relevance score from the `True` top-logprob", async () => {
    const logProbFor05 = Math.log(0.5);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: { content: "True" },
            logprobs: {
              content: [
                {
                  token: "True",
                  logprob: logProbFor05,
                  top_logprobs: [
                    { token: "True", logprob: logProbFor05 },
                    { token: "False", logprob: Math.log(0.5) },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const port = createOpenAICrossEncoder({ apiKey: "test-key" });
    const scores = await port.rank("query", [{ id: "alpha", text: "body" }]);

    expect(scores).toEqual([{ id: "alpha", score: 0.5 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("inverts the score when the generated token is `False`", async () => {
    const logProbFor08 = Math.log(0.8);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            logprobs: {
              content: [
                {
                  token: "False",
                  logprob: logProbFor08,
                  top_logprobs: [
                    { token: "False", logprob: logProbFor08 },
                    { token: "True", logprob: Math.log(0.2) },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const port = createOpenAICrossEncoder({ apiKey: "test-key" });
    const scores = await port.rank("query", [{ id: "alpha", text: "body" }]);

    expect(scores[0]?.score).toBeCloseTo(1 - 0.8, 6);
  });

  it("sends `logit_bias`, `logprobs`, and `top_logprobs` with the configured model", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(buildTrueResponse(1));
    });
    vi.stubGlobal("fetch", fetchMock);

    const port = createOpenAICrossEncoder({
      apiKey: "test-key",
      model: "gpt-5.4-nano",
    });
    await port.rank("query", [{ id: "alpha", text: "body" }]);

    expect(bodies).toHaveLength(1);
    const request = bodies[0] as {
      model: string;
      temperature: number;
      max_tokens: number;
      logit_bias: Record<string, number>;
      logprobs: boolean;
      top_logprobs: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.model).toBe("gpt-5.4-nano");
    expect(request.temperature).toBe(0);
    expect(request.max_tokens).toBe(1);
    expect(request.logprobs).toBe(true);
    expect(request.top_logprobs).toBe(2);
    expect(request.logit_bias).toMatchObject({ "6432": 1, "7983": 1 });
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[1]?.content).toContain("<PASSAGE>");
    expect(request.messages[1]?.content).toContain("<QUERY>");
  });

  it("omits malformed payloads from the returned score list", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const port = createOpenAICrossEncoder({ apiKey: "test-key", maxRetries: 0 });
    const scores = await port.rank("query", [
      { id: "alpha", text: "body" },
      { id: "beta", text: "body" },
    ]);

    expect(scores).toEqual([]);
  });

  it("retries on 429 responses and returns the final score", async () => {
    const logProb = Math.log(0.75);
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({ error: { message: "slow down" } }, 429);
      }

      return jsonResponse(buildTrueLogProbResponse(logProb));
    });

    const port = createOpenAICrossEncoder({
      apiKey: "test-key",
      maxRetries: 2,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const scores = await port.rank("query", [{ id: "alpha", text: "body" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(scores).toHaveLength(1);
    expect(scores[0]?.score).toBeCloseTo(0.75, 6);
  }, 10_000);

  it("fails closed on non-retryable HTTP errors", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const port = createOpenAICrossEncoder({ apiKey: "test-key", maxRetries: 3 });
    const scores = await port.rank("query", [{ id: "alpha", text: "body" }]);

    expect(scores).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrency to the configured worker count", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      inFlight -= 1;
      return jsonResponse(buildTrueResponse(1));
    });
    vi.stubGlobal("fetch", fetchMock);

    const port = createOpenAICrossEncoder({
      apiKey: "test-key",
      maxConcurrency: 2,
    });
    await port.rank(
      "query",
      Array.from({ length: 6 }, (_value, index) => ({
        id: `id-${index}`,
        text: "body",
      })),
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("returns empty when the fetch implementation throws and retries are exhausted", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });

    const port = createOpenAICrossEncoder({
      apiKey: "test-key",
      maxRetries: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const scores = await port.rank("query", [{ id: "alpha", text: "body" }]);

    expect(scores).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);
});

/** Builds a JSON `Response` compatible with the fetch API for stubs. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Builds a valid `True`-token chat-completion payload for the adapter to parse. */
function buildTrueResponse(probability: number): unknown {
  return buildTrueLogProbResponse(Math.log(probability));
}

/** Builds a chat-completion payload scoring `True` at the provided logprob. */
function buildTrueLogProbResponse(logProb: number): unknown {
  return {
    choices: [
      {
        logprobs: {
          content: [
            {
              token: "True",
              logprob: logProb,
              top_logprobs: [
                { token: "True", logprob: logProb },
                { token: "False", logprob: Math.log(Math.max(0.0001, 1 - Math.exp(logProb))) },
              ],
            },
          ],
        },
      },
    ],
  };
}
