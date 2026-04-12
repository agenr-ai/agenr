import { describe, expect, it, vi } from "vitest";

import { dedupBatch } from "../../../src/core/ingestion/dedup.js";
import type { EmbeddingPort, LlmPort } from "../../../src/core/ports.js";
import { composeEmbeddingText } from "../../../src/core/store/embedding-text.js";
import type { StoreEntryInput } from "../../../src/core/types.js";

describe("dedupBatch", () => {
  it("passes through entries with no similar neighbors", async () => {
    const entries = [
      createInput({ subject: "alpha", content: "alpha content" }),
      createInput({ subject: "beta", content: "beta content" }),
      createInput({ subject: "gamma", content: "gamma content" }),
    ];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0, 1],
        [-1, 0],
      ],
      entries,
    );
    const llm = new MockLlmPort([]);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual(entries);
    expect(result.embeddings).toEqual([
      [1, 0],
      [0, 1],
      [-1, 0],
    ]);
    expect(result.removedCount).toBe(0);
    expect(result.clustersArbitrated).toBe(0);
    expect(result.singletonsPassedThrough).toBe(3);
    expect(result.llmCalls).toBe(0);
  });

  it("removes a clear duplicate pair", async () => {
    const entries = [
      createInput({ subject: "architecture priority", content: "Jim wants architecture prioritized over churn." }),
      createInput({ subject: "architecture first", content: "Architecture should be treated as a first-class concern." }),
    ];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0.99, 0.01],
      ],
      entries,
    );
    const llm = new MockLlmPort(['{"keep":[0],"drop":[1]}']);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual([entries[0]]);
    expect(result.survivorIndices).toEqual([0]);
    expect(result.removedCount).toBe(1);
    expect(result.clustersArbitrated).toBe(1);
    expect(result.llmCalls).toBe(1);
    expect(result.clusterDetails[0]).toMatchObject({
      kept: [0],
      dropped: [1],
      merged: false,
    });
  });

  it("collapses a three-entry duplicate cluster into one survivor", async () => {
    const entries = [
      createInput({ subject: "architecture priority", content: "Jim wants architecture treated as a first-class concern." }),
      createInput({ subject: "architecture-first approach", content: "Jim prefers architecture work before feature churn." }),
      createInput({ subject: "system design priority", content: "System design should come before implementation rushes." }),
    ];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0.99, 0.01],
        [0.98, 0.02],
      ],
      entries,
    );
    const llm = new MockLlmPort(['{"keep":[1],"drop":[0,2]}']);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual([entries[1]]);
    expect(result.survivorIndices).toEqual([1]);
    expect(result.removedCount).toBe(2);
  });

  it("keeps non-duplicate knowledge inside a similar cluster", async () => {
    const entries = [
      createInput({ subject: "dedup pass", content: "Within-batch dedup should use a cheap classifier model." }),
      createInput({ subject: "dedup model", content: "Use a cheap model for within-batch dedup classification." }),
      createInput({ subject: "dedup threshold", content: "The clustering threshold should stay configurable." }),
    ];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0.97, 0.03],
        [0.93, 0.07],
      ],
      entries,
    );
    const llm = new MockLlmPort(['{"keep":[0,2],"drop":[1]}']);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual([entries[0], entries[2]]);
    expect(result.survivorIndices).toEqual([0, 2]);
    expect(result.clusterDetails[0]).toMatchObject({
      kept: [0, 2],
      dropped: [1],
    });
  });

  it("merges content into the kept survivor", async () => {
    const entries = [
      createInput({
        subject: "architecture priority",
        content: "Jim wants architecture treated as a first-class concern.",
        importance: 6,
        tags: ["architecture"],
      }),
      createInput({
        subject: "architecture-first approach",
        content: "Prioritize system boundaries before implementation churn.",
        importance: 8,
        tags: ["workflow"],
      }),
    ];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0.99, 0.01],
      ],
      entries,
    );
    const llm = new MockLlmPort([
      '{"keep":[0],"drop":[1],"merge_into":0,"merged_content":"Jim wants architecture treated as a first-class concern, with system boundaries prioritized before implementation churn."}',
    ]);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual([
      expect.objectContaining({
        subject: "architecture priority",
        content: "Jim wants architecture treated as a first-class concern, with system boundaries prioritized before implementation churn.",
        importance: 8,
        tags: ["architecture", "workflow"],
      }),
    ]);
    expect(result.clusterDetails[0]).toMatchObject({
      merged: true,
      mergeTarget: 0,
      mergedContent: "Jim wants architecture treated as a first-class concern, with system boundaries prioritized before implementation churn.",
    });
  });

  it("keeps the more accurate type when the cluster mixes entry types", async () => {
    const entries = [
      createInput({
        type: "preference",
        subject: "architecture preference",
        content: "Jim prefers architecture-first work.",
        importance: 6,
      }),
      createInput({
        type: "decision",
        subject: "architecture policy",
        content: "Architecture must be prioritized over implementation churn.",
        importance: 8,
      }),
    ];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0.99, 0.01],
      ],
      entries,
    );
    const llm = new MockLlmPort(['{"keep":[1],"drop":[0],"merge_into":1,"merged_content":"Architecture must be prioritized over implementation churn."}']);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual([
      expect.objectContaining({
        type: "decision",
        subject: "architecture policy",
        importance: 8,
        content: "Architecture must be prioritized over implementation churn.",
      }),
    ]);
  });

  it("passes all entries through in skip mode", async () => {
    const entries = [createInput({ subject: "alpha" }), createInput({ subject: "beta" })];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0, 1],
      ],
      entries,
    );
    const llm = new MockLlmPort(['{"keep":[0],"drop":[1]}']);

    const result = await dedupBatch(entries, llm, embedding, { skip: true });

    expect(result.survivors).toEqual(entries);
    expect(result.removedCount).toBe(0);
    expect(result.llmCalls).toBe(0);
    expect(llm.completeCalls).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("returns an empty result for empty input", async () => {
    const embedding = new MockEmbeddingPort([], []);
    const llm = new MockLlmPort([]);

    await expect(dedupBatch([], llm, embedding)).resolves.toEqual({
      survivors: [],
      survivorIndices: [],
      embeddings: [],
      inputCount: 0,
      removedCount: 0,
      clustersArbitrated: 0,
      singletonsPassedThrough: 0,
      llmCalls: 0,
      clusterDetails: [],
      warnings: [],
      similarityThreshold: 0.75,
    });
    expect(embedding.calls).toEqual([]);
    expect(llm.completeCalls).toBe(0);
  });

  it("passes a single entry through without an LLM call", async () => {
    const entries = [createInput({ subject: "alpha" })];
    const embedding = new MockEmbeddingPort([[1, 0]], entries);
    const llm = new MockLlmPort(['{"keep":[0],"drop":[]}']);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual(entries);
    expect(result.singletonsPassedThrough).toBe(1);
    expect(result.llmCalls).toBe(0);
    expect(llm.completeCalls).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("keeps every entry when the LLM response cannot be parsed", async () => {
    const entries = [createInput({ subject: "alpha", content: "alpha content" }), createInput({ subject: "beta", content: "beta content" })];
    const embedding = new MockEmbeddingPort(
      [
        [1, 0],
        [0.99, 0.01],
      ],
      entries,
    );
    const llm = new MockLlmPort(["not valid json"]);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual(entries);
    expect(result.removedCount).toBe(0);
    expect(result.clusterDetails[0]).toMatchObject({
      kept: [0, 1],
      dropped: [],
      merged: false,
    });
    expect(result.warnings).toEqual(["Cluster 1: dedup arbitration failed, keeping all entries (Dedup response did not contain a JSON object.)."]);
  });

  it("returns survivor embeddings aligned with the surviving entries", async () => {
    const entries = [
      createInput({ subject: "first", content: "first content" }),
      createInput({ subject: "second", content: "second content" }),
      createInput({ subject: "third", content: "third content" }),
    ];
    const vectors = [
      [1, 0],
      [0.99, 0.01],
      [0, 1],
    ];
    const embedding = new MockEmbeddingPort(vectors, entries);
    const llm = new MockLlmPort(['{"keep":[1],"drop":[0]}']);

    const result = await dedupBatch(entries, llm, embedding);

    expect(result.survivors).toEqual([entries[1], entries[2]]);
    expect(result.survivorIndices).toEqual([1, 2]);
    expect(result.embeddings).toEqual([
      [0.99, 0.01],
      [0, 1],
    ]);
  });

  it("honors the configured arbitration concurrency", async () => {
    const { entries, vectors } = createPairedClusterScenario(3);
    const responses = [deferred<string>(), deferred<string>(), deferred<string>()];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const llm = new MockLlmPort((callIndex) => {
      const response = responses[callIndex];
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      return response.promise.finally(() => {
        activeRequests -= 1;
      });
    });
    const embedding = new MockEmbeddingPort(vectors, entries);

    const dedupPromise = dedupBatch(entries, llm, embedding, { concurrency: 2 });

    await vi.waitFor(() => {
      expect(llm.completeCalls).toBe(2);
    });
    expect(maxActiveRequests).toBe(2);

    responses[0].resolve('{"keep":[0],"drop":[1]}');
    await vi.waitFor(() => {
      expect(llm.completeCalls).toBe(3);
    });
    expect(maxActiveRequests).toBe(2);

    responses[1].resolve('{"keep":[0],"drop":[1]}');
    responses[2].resolve('{"keep":[0],"drop":[1]}');
    await dedupPromise;

    expect(maxActiveRequests).toBe(2);
  });

  it("reports arbitration progress using only multi-entry clusters", async () => {
    const entries = [
      createInput({ subject: "cluster-0 primary", content: "cluster-0 primary" }),
      createInput({ subject: "cluster-0 secondary", content: "cluster-0 secondary" }),
      createInput({ subject: "cluster-1 primary", content: "cluster-1 primary" }),
      createInput({ subject: "cluster-1 secondary", content: "cluster-1 secondary" }),
      createInput({ subject: "singleton", content: "singleton" }),
    ];
    const vectors = [
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const events: Array<{ completedClusters: number; totalClusters: number; completedEntries: number; totalEntries: number }> = [];

    await dedupBatch(entries, new MockLlmPort(['{"keep":[0],"drop":[1]}', '{"keep":[1],"drop":[0]}']), new MockEmbeddingPort(vectors, entries), {
      onProgress: (event) => {
        events.push({ ...event });
      },
    });

    expect(events).toEqual([
      {
        completedClusters: 1,
        totalClusters: 2,
        completedEntries: 2,
        totalEntries: 4,
      },
      {
        completedClusters: 2,
        totalClusters: 2,
        completedEntries: 4,
        totalEntries: 4,
      },
    ]);
  });

  it("matches the sequential baseline under parallel arbitration", async () => {
    const { entries, vectors } = createPairedClusterScenario(3);
    const responses = ['{"keep":[0],"drop":[1]}', '{"keep":[1],"drop":[0]}', '{"keep":[0,1],"drop":[]}'];

    const sequentialResult = await dedupBatch(entries, new MockLlmPort(responses), new MockEmbeddingPort(vectors, entries), {
      concurrency: 1,
    });
    const parallelResult = await dedupBatch(entries, new MockLlmPort(responses), new MockEmbeddingPort(vectors, entries), {
      concurrency: 2,
    });

    expect(parallelResult).toEqual(sequentialResult);
  });

  it("keeps cluster details and warnings in original cluster order when arbitration resolves out of order", async () => {
    const { entries, vectors } = createPairedClusterScenario(3);
    const responses = [deferred<string>(), deferred<string>(), deferred<string>()];
    const llm = new MockLlmPort((callIndex) => responses[callIndex]?.promise ?? '{"keep":[0],"drop":[1]}');
    const embedding = new MockEmbeddingPort(vectors, entries);

    const dedupPromise = dedupBatch(entries, llm, embedding, { concurrency: 3 });

    await vi.waitFor(() => {
      expect(llm.completeCalls).toBe(3);
    });

    responses[2].resolve("not valid json");
    responses[0].resolve("not valid json");
    responses[1].resolve('{"keep":[0],"drop":[1]}');

    const result = await dedupPromise;

    expect(result.clusterDetails.map((detail) => detail.entryIndices)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(result.warnings).toEqual([
      "Cluster 1: dedup arbitration failed, keeping all entries (Dedup response did not contain a JSON object.).",
      "Cluster 3: dedup arbitration failed, keeping all entries (Dedup response did not contain a JSON object.).",
    ]);
  });

  it("reports monotonic arbitration progress when clusters resolve out of order", async () => {
    const { entries, vectors } = createPairedClusterScenario(3);
    const responses = [deferred<string>(), deferred<string>(), deferred<string>()];
    const progressEvents: Array<{ completedClusters: number; totalClusters: number; completedEntries: number; totalEntries: number }> = [];
    const llm = new MockLlmPort((callIndex) => responses[callIndex]?.promise ?? '{"keep":[0],"drop":[1]}');
    const embedding = new MockEmbeddingPort(vectors, entries);

    const dedupPromise = dedupBatch(entries, llm, embedding, {
      concurrency: 3,
      onProgress: (event) => {
        progressEvents.push({ ...event });
      },
    });

    await vi.waitFor(() => {
      expect(llm.completeCalls).toBe(3);
    });

    responses[2].resolve('{"keep":[0],"drop":[1]}');
    responses[0].resolve('{"keep":[0],"drop":[1]}');
    responses[1].resolve('{"keep":[0],"drop":[1]}');

    await dedupPromise;

    expect(progressEvents).toEqual([
      {
        completedClusters: 1,
        totalClusters: 3,
        completedEntries: 2,
        totalEntries: 6,
      },
      {
        completedClusters: 2,
        totalClusters: 3,
        completedEntries: 4,
        totalEntries: 6,
      },
      {
        completedClusters: 3,
        totalClusters: 3,
        completedEntries: 6,
        totalEntries: 6,
      },
    ]);
  });

  it("preserves survivor order when cluster arbitration completes out of order", async () => {
    const entries = [
      createInput({ subject: "cluster-0 primary", content: "cluster-0 primary" }),
      createInput({ subject: "cluster-0 secondary", content: "cluster-0 secondary" }),
      createInput({ subject: "singleton", content: "singleton" }),
      createInput({ subject: "cluster-1 primary", content: "cluster-1 primary" }),
      createInput({ subject: "cluster-1 secondary", content: "cluster-1 secondary" }),
    ];
    const vectors = [
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 0, 1],
    ];
    const responses = [deferred<string>(), deferred<string>()];
    const llm = new MockLlmPort((callIndex) => responses[callIndex]?.promise ?? '{"keep":[0],"drop":[1]}');
    const embedding = new MockEmbeddingPort(vectors, entries);

    const dedupPromise = dedupBatch(entries, llm, embedding, { concurrency: 2 });

    await vi.waitFor(() => {
      expect(llm.completeCalls).toBe(2);
    });

    responses[1].resolve('{"keep":[0],"drop":[1]}');
    responses[0].resolve('{"keep":[1],"drop":[0]}');

    const result = await dedupPromise;

    expect(result.survivors).toEqual([entries[1], entries[2], entries[3]]);
    expect(result.survivorIndices).toEqual([1, 2, 3]);
    expect(result.embeddings).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });
});

class MockEmbeddingPort implements EmbeddingPort {
  public readonly calls: string[][] = [];
  private readonly vectorsByText: Map<string, number[]>;

  public constructor(vectors: number[][], entries: StoreEntryInput[]) {
    this.vectorsByText = new Map(entries.map((entry, index) => [composeEmbeddingText(entry), vectors[index] ?? []]));
  }

  public async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((text) => {
      const vector = this.vectorsByText.get(text);
      if (!vector) {
        throw new Error(`No mock embedding configured for ${text}.`);
      }

      return vector;
    });
  }
}

type MockLlmResponse = string | Error | Promise<string>;

class MockLlmPort implements LlmPort {
  public readonly calls: Array<{ systemPrompt: string; userMessage: string }> = [];
  public completeCalls = 0;

  public constructor(private readonly responses: MockLlmResponse[] | ((callIndex: number, systemPrompt: string, userMessage: string) => MockLlmResponse)) {}

  public async complete(systemPrompt: string, userMessage: string): Promise<string> {
    this.calls.push({ systemPrompt, userMessage });
    const response =
      typeof this.responses === "function"
        ? this.responses(this.completeCalls, systemPrompt, userMessage)
        : (this.responses[this.completeCalls] ?? this.responses.at(-1) ?? '{"keep":[],"drop":[]}');
    this.completeCalls += 1;

    if (response instanceof Error) {
      throw response;
    }

    return await response;
  }

  public async completeJson<T>(): Promise<T> {
    throw new Error("completeJson should not be used by dedupBatch tests.");
  }
}

function createPairedClusterScenario(clusterCount: number): { entries: StoreEntryInput[]; vectors: number[][] } {
  const entries: StoreEntryInput[] = [];
  const vectors: number[][] = [];

  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
    const vector = Array.from({ length: clusterCount }, (_, index) => (index === clusterIndex ? 1 : 0));
    entries.push(
      createInput({
        subject: `cluster-${clusterIndex}-primary`,
        content: `cluster-${clusterIndex}-primary content`,
      }),
      createInput({
        subject: `cluster-${clusterIndex}-secondary`,
        content: `cluster-${clusterIndex}-secondary content`,
      }),
    );
    vectors.push([...vector], [...vector]);
  }

  return { entries, vectors };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function createInput(overrides: Partial<StoreEntryInput> = {}): StoreEntryInput {
  return {
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "subject",
    content: overrides.content ?? "content",
    importance: overrides.importance,
    expiry: overrides.expiry,
    tags: overrides.tags,
    source_file: overrides.source_file,
    source_context: overrides.source_context,
  };
}
