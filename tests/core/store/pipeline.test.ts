import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { composeEmbeddingText } from "../../../src/adapters/embeddings.js";
import { annotateExplicitClaimKeyEntry } from "../../../src/core/ingestion/claim-key-preservation.js";
import type { DatabasePort, EmbeddingPort, LlmPort } from "../../../src/core/ports.js";
import { computeContentHash, computeNormContentHash } from "../../../src/core/store/hashing.js";
import { storeEntries } from "../../../src/core/store/pipeline.js";
import type { Entry, StoreEntryInput } from "../../../src/core/types.js";

describe("storeEntries", () => {
  it("stores a single entry successfully", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([createInput()], db, embedding);

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.insertions).toHaveLength(1);
    expect(db.claimKeyLookupCalls).toEqual([]);
    expect(db.supersedeCalls).toEqual([]);
  });

  it("skips entries whose content hash already exists", async () => {
    const input = createInput();
    const db = new MockDatabase({
      existingHashes: new Set([computeContentHash(input.content, input.source_file)]),
    });
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([input], db, embedding);

    expect(result).toEqual({ stored: 0, skipped: 1, rejected: 0 });
    expect(db.insertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
  });

  it("skips entries whose normalized content hash already exists", async () => {
    const input = createInput({
      content: "Hello,   WORLD!",
      source_file: "/tmp/source-a.md",
    });
    const db = new MockDatabase({
      existingNormHashes: new Set([computeNormContentHash(input.content)]),
    });
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([input], db, embedding);

    expect(result).toEqual({ stored: 0, skipped: 1, rejected: 0 });
    expect(db.insertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
  });

  it("stores three entries and skips two duplicates in a batch of five", async () => {
    const inputs = [
      createInput({ subject: "one", content: "content-one" }),
      createInput({ subject: "two", content: "content-two" }),
      createInput({ subject: "three", content: "content-three" }),
      createInput({ subject: "four", content: "content-four" }),
      createInput({ subject: "five", content: "content-five" }),
    ];
    const db = new MockDatabase({
      existingHashes: new Set([computeContentHash(inputs[1].content, inputs[1].source_file), computeContentHash(inputs[4].content, inputs[4].source_file)]),
    });
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries(inputs, db, embedding);

    expect(result).toEqual({ stored: 3, skipped: 2, rejected: 0 });
    expect(db.insertions).toHaveLength(3);
    expect(db.transactionCount).toBe(1);
  });

  it("stores only the first entry when a batch contains duplicate normalized content hashes", async () => {
    const inputs = [
      createInput({
        subject: "one",
        content: "Normalize me",
        source_file: "/tmp/source-a.md",
      }),
      createInput({
        subject: "two",
        content: " normalize   me ",
        source_file: "/tmp/source-b.md",
      }),
    ];
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries(inputs, db, embedding);

    expect(result).toEqual({ stored: 1, skipped: 1, rejected: 0 });
    expect(db.insertions).toHaveLength(1);
    expect(db.insertions[0]?.entry.source_file).toBe("/tmp/source-a.md");
  });

  it("returns zero counts for empty input", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    await expect(storeEntries([], db, embedding)).resolves.toEqual({
      stored: 0,
      skipped: 0,
      rejected: 0,
    });
  });

  it("rejects invalid entries while still storing valid ones", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([createInput({ subject: "valid" }), createInput({ subject: "   " })], db, embedding);

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 1 });
    expect(db.insertions).toHaveLength(1);
  });

  it("does not insert entries during a dry run", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries([createInput()], db, embedding, { dryRun: true });

    expect(result).toEqual({ stored: 0, skipped: 0, rejected: 0 });
    expect(db.insertions).toEqual([]);
    expect(embedding.calls).toEqual([]);
  });

  it("calls the embedding port with composed entry texts", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const inputs = [
      createInput({ type: "decision", subject: "subject-a", content: "content-a" }),
      createInput({ type: "lesson", subject: "subject-b", content: "content-b" }),
    ];

    await storeEntries(inputs, db, embedding);

    expect(embedding.calls).toEqual([inputs.map((input) => composeEmbeddingText(input))]);
  });

  it("sets content hash and normalized content hash on persisted entries", async () => {
    const input = createInput({
      content: "Hello,   WORLD!",
      source_file: "/tmp/source.md",
    });
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    await storeEntries([input], db, embedding);

    expect(db.insertions[0]?.entry.content_hash).toBe(computeContentHash(input.content, input.source_file));
    expect(db.insertions[0]?.entry.norm_content_hash).toBe(computeNormContentHash(input.content));
  });

  it("reuses precomputed embeddings instead of calling the embedding port", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const inputs = [createInput({ subject: "one", content: "content-one" }), createInput({ subject: "two", content: "content-two" })];
    const precomputedEmbeddings = [
      [10, 11],
      [20, 21],
    ];

    const result = await storeEntries(inputs, db, embedding, { precomputedEmbeddings });

    expect(result).toEqual({ stored: 2, skipped: 0, rejected: 0 });
    expect(embedding.calls).toEqual([]);
    expect(db.insertions.map(({ embedding: vector }) => vector)).toEqual(precomputedEmbeddings);
  });

  it("keeps precomputed embeddings aligned after hash dedup filters inputs", async () => {
    const inputs = [
      createInput({ subject: "one", content: "content-one" }),
      createInput({ subject: "two", content: "content-two" }),
      createInput({ subject: "three", content: "content-three" }),
    ];
    const db = new MockDatabase({
      existingHashes: new Set([computeContentHash(inputs[1].content, inputs[1].source_file)]),
    });
    const embedding = new MockEmbeddingPort();
    const precomputedEmbeddings = [
      [10, 11],
      [20, 21],
      [30, 31],
    ];

    const result = await storeEntries(inputs, db, embedding, { precomputedEmbeddings });

    expect(result).toEqual({ stored: 2, skipped: 1, rejected: 0 });
    expect(embedding.calls).toEqual([]);
    expect(db.insertions.map(({ entry }) => entry.subject)).toEqual(["one", "three"]);
    expect(db.insertions.map(({ embedding: vector }) => vector)).toEqual([
      [10, 11],
      [30, 31],
    ]);
  });

  it("uses the input created_at while keeping updated_at at write time", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const createdAt = "2026-03-01T10:00:00.000Z";

    await storeEntries([createInput({ created_at: createdAt })], db, embedding);

    const inserted = db.insertions[0]?.entry;
    expect(inserted?.created_at).toBe(createdAt);
    expect(inserted?.updated_at).toMatch(/^20\d\d-/);
    expect(inserted?.updated_at).not.toBe(createdAt);
  });

  it("extracts a claim key before persistence when configured", async () => {
    const db = new MockDatabase({
      claimKeyPrefixes: ["jim", "agenr"],
    });
    const embedding = new MockEmbeddingPort();
    const llm = new MockLlmPort({
      entity: "Jim",
      attribute: "home city",
      confidence: 0.93,
    });

    await storeEntries(
      [
        createInput({
          subject: "Jim's home city",
          content: "Jim lives in Denver, Colorado.",
        }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision"],
          },
        },
      },
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim/home city",
      claim_key_status: "trusted",
      claim_key_source: "model",
      claim_key_confidence: 0.93,
      claim_key_rationale: "claim key extracted from model output",
    });
    expect(llm.calls).toHaveLength(1);
  });

  it("propagates configured claim extraction concurrency through the store pipeline", async () => {
    const db = new MockDatabase({
      claimKeyPrefixes: ["jim"],
    });
    const embedding = new MockEmbeddingPort();
    const responses = [
      deferred<{ entity: string; attribute: string; confidence: number }>(),
      deferred<{ entity: string; attribute: string; confidence: number }>(),
      deferred<{ entity: string; attribute: string; confidence: number }>(),
    ];
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

    const storePromise = storeEntries(
      [
        createInput({ subject: "Jim timezone", content: "Jim's timezone is America/Chicago." }),
        createInput({ subject: "Jim city", content: "Jim lives in Denver, Colorado." }),
        createInput({ subject: "Jim employer", content: "Jim works at Agenr." }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision"],
            concurrency: 2,
          },
        },
      },
    );

    await vi.waitFor(() => {
      expect(llm.calls).toHaveLength(2);
    });
    expect(maxActiveRequests).toBe(2);

    responses[0].resolve({ entity: "Jim", attribute: "timezone", confidence: 0.95 });
    await vi.waitFor(() => {
      expect(llm.calls).toHaveLength(2);
    });

    responses[1].resolve({ entity: "Jim", attribute: "home city", confidence: 0.95 });
    await vi.waitFor(() => {
      expect(llm.calls).toHaveLength(3);
    });

    responses[2].resolve({ entity: "Jim", attribute: "employer", confidence: 0.95 });
    await storePromise;

    expect(maxActiveRequests).toBe(2);
  });

  it("defaults store-pipeline claim extraction concurrency to 10 when unset", async () => {
    const db = new MockDatabase({
      claimKeyPrefixes: ["jim"],
    });
    const embedding = new MockEmbeddingPort();
    const responses = [
      deferred<{ entity: string; attribute: string; confidence: number }>(),
      deferred<{ entity: string; attribute: string; confidence: number }>(),
    ];
    const llm = new MockLlmPort((callIndex) => responses[callIndex]?.promise);

    const storePromise = storeEntries(
      [
        createInput({ subject: "Jim timezone", content: "Jim's timezone is America/Chicago." }),
        createInput({ subject: "Jim city", content: "Jim lives in Denver, Colorado." }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision"],
          },
        },
      },
    );

    await vi.waitFor(() => {
      expect(llm.calls).toHaveLength(2);
    });

    responses[0].resolve({ entity: "Jim", attribute: "timezone", confidence: 0.95 });
    responses[1].resolve({ entity: "Jim", attribute: "home city", confidence: 0.95 });
    await storePromise;
  });

  it("assigns trusted lifecycle metadata when extraction succeeds after a json retry", async () => {
    const db = new MockDatabase({
      claimKeyPrefixes: ["jim"],
    });
    const embedding = new MockEmbeddingPort();
    const llm = new MockLlmPort((callIndex) =>
      callIndex === 0
        ? new Error("Unexpected token 'J' in JSON at position 0")
        : {
            entity: "Jim",
            attribute: "timezone",
            confidence: 0.92,
          },
    );

    await storeEntries(
      [
        createInput({
          subject: "Jim's timezone",
          content: "Jim's timezone is America/Chicago.",
        }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision"],
          },
        },
      },
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "json_retry",
      claim_key_confidence: 0.92,
      claim_key_rationale: "claim key extracted from json_retry output",
    });
    expect(llm.calls).toHaveLength(2);
  });

  it("preserves an agent-provided claim key and skips extraction", async () => {
    const db = new MockDatabase({
      claimKeyPrefixes: ["jim"],
    });
    const embedding = new MockEmbeddingPort();
    const llm = new MockLlmPort({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.93,
    });

    await storeEntries(
      [
        createInput({
          subject: "Jim's home city",
          content: "Jim lives in Denver, Colorado.",
          claim_key: "jim/home_city",
        }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision"],
          },
        },
      },
    );

    expect(db.insertions[0]?.entry.claim_key).toBe("jim/home_city");
    expect(llm.calls).toEqual([]);
  });

  it("keeps explicit-key lifecycle fields aligned between direct store and ingest preservation paths", async () => {
    const directDb = new MockDatabase();
    const ingestDb = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const baseInput = createInput({
      subject: "Jim timezone",
      content: "Jim uses America/Chicago.",
      claim_key: " Jim / Timezone ",
    });

    await storeEntries([baseInput], directDb, embedding);
    await storeEntries(
      [
        annotateExplicitClaimKeyEntry(
          { ...baseInput },
          {
            sourceKind: "tool_call",
            locator: "/tmp/session.jsonl#entry:1",
            observedAt: "2026-04-01T10:00:00.000Z",
            mode: "explicit",
          },
        ),
      ],
      ingestDb,
      embedding,
    );

    expect(directDb.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim / Timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
    });
    expect(ingestDb.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim / Timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
    });
  });

  it("normalizes valid manual claim keys before persistence", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    await storeEntries(
      [
        createInput({
          subject: "Jim's home city",
          content: "Jim lives in Denver, Colorado.",
          claim_key: " Jim / Home City ",
        }),
      ],
      db,
      embedding,
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
    });
  });

  it("drops malformed manual claim keys while the store still succeeds", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();
    const warnings: string[] = [];

    const result = await storeEntries(
      [
        createInput({
          subject: "Jim timezone",
          content: "Jim's timezone is America/Chicago.",
          claim_key: "timezone",
        }),
      ],
      db,
      embedding,
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: undefined,
      claim_key_raw: undefined,
      claim_key_status: undefined,
      claim_key_source: undefined,
      claim_key_confidence: undefined,
      claim_key_rationale: undefined,
    });
    expect(warnings[0]).toMatch(/invalid claim key/i);
    expect(db.claimKeyLookupCalls).toEqual([]);
    expect(db.supersedeCalls).toEqual([]);
  });

  it("preserves precomputed extracted lifecycle metadata instead of reclassifying it as manual", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    await storeEntries(
      [
        createInput({
          subject: "Project X status",
          content: "Project X is active.",
          claim_key: "project_x/status",
          claim_key_raw: "Project X/status",
          claim_key_status: "trusted",
          claim_key_source: "model",
          claim_key_confidence: 0.95,
          claim_key_rationale: "claim key extracted from model output",
        }),
      ],
      db,
      embedding,
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "project_x/status",
      claim_key_raw: "Project X/status",
      claim_key_status: "trusted",
      claim_key_source: "model",
      claim_key_confidence: 0.95,
      claim_key_rationale: "claim key extracted from model output",
    });
  });

  it("rejects partial lifecycle bundles instead of silently storing them as manual claim keys", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries(
      [
        createInput({
          subject: "Project X status",
          content: "Project X is active.",
          claim_key: "project_x/status",
          claim_key_status: "trusted",
        }),
      ],
      db,
      embedding,
    );

    expect(result).toEqual({ stored: 0, skipped: 0, rejected: 1 });
    expect(db.insertions).toEqual([]);
  });

  it("keeps manual claim keys on the manual path when only support metadata is supplied", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    await storeEntries(
      [
        createInput({
          subject: "Jim timezone",
          content: "Jim uses America/Chicago.",
          claim_key: "jim/timezone",
          claim_support_source_kind: "tool_call",
          claim_support_locator: "session.jsonl#entry:1",
          claim_support_observed_at: "2026-04-01T10:00:00.000Z",
          claim_support_mode: "explicit",
        }),
      ],
      db,
      embedding,
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "session.jsonl#entry:1",
      claim_support_observed_at: "2026-04-01T10:00:00.000Z",
      claim_support_mode: "explicit",
    });
  });

  it("auto-supersedes a manual claim key when exactly one active sibling exists", async () => {
    const activeSibling = createExistingEntry({
      claim_key: "jim/home_city",
      subject: "Jim home city",
      content: "Jim lived in Seattle, Washington.",
    });
    const db = new MockDatabase({
      activeEntriesByClaimKey: {
        "jim/home_city": [activeSibling],
      },
    });
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries(
      [
        createInput({
          subject: "Jim's home city",
          content: "Jim now lives in Denver, Colorado.",
          claim_key: "Jim / Home City",
        }),
      ],
      db,
      embedding,
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.claimKeyLookupCalls).toEqual(["jim/home_city"]);
    expect(db.supersedeCalls).toEqual([
      {
        oldId: activeSibling.id,
        newId: db.insertions[0]?.entry.id ?? "",
        kind: "update",
        reason: undefined,
      },
    ]);
  });

  it("auto-supersedes a high-confidence extracted claim key when exactly one active sibling exists", async () => {
    const activeSibling = createExistingEntry({
      claim_key: "jim/timezone",
      subject: "Jim timezone",
      content: "Jim's timezone was America/Denver.",
    });
    const db = new MockDatabase({
      claimKeyPrefixes: ["jim"],
      activeEntriesByClaimKey: {
        "jim/timezone": [activeSibling],
      },
    });
    const embedding = new MockEmbeddingPort();
    const llm = new MockLlmPort({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.96,
    });

    const result = await storeEntries(
      [
        createInput({
          subject: "Jim's timezone",
          content: "Jim's timezone is America/Chicago.",
        }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision"],
          },
        },
      },
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.insertions[0]?.entry.claim_key).toBe("jim/timezone");
    expect(db.claimKeyLookupCalls).toEqual(["jim/timezone"]);
    expect(db.supersedeCalls).toEqual([
      {
        oldId: activeSibling.id,
        newId: db.insertions[0]?.entry.id ?? "",
        kind: "update",
        reason: undefined,
      },
    ]);
  });

  it("stores normally without supersession when a claim key has no active sibling", async () => {
    const db = new MockDatabase();
    const embedding = new MockEmbeddingPort();

    const result = await storeEntries(
      [
        createInput({
          subject: "Jim's home city",
          content: "Jim lives in Denver, Colorado.",
          claim_key: "jim/home_city",
        }),
      ],
      db,
      embedding,
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.claimKeyLookupCalls).toEqual(["jim/home_city"]);
    expect(db.supersedeCalls).toEqual([]);
  });

  it("skips auto-supersession and warns when multiple active siblings share the claim key", async () => {
    const db = new MockDatabase({
      activeEntriesByClaimKey: {
        "jim/home_city": [
          createExistingEntry({ claim_key: "jim/home_city", subject: "Jim home city v1" }),
          createExistingEntry({ claim_key: "jim/home_city", subject: "Jim home city v2" }),
        ],
      },
    });
    const embedding = new MockEmbeddingPort();
    const warnings: string[] = [];

    const result = await storeEntries(
      [
        createInput({
          subject: "Jim's home city",
          content: "Jim now lives in Denver, Colorado.",
          claim_key: "jim/home_city",
        }),
      ],
      db,
      embedding,
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.supersedeCalls).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/2 active siblings/i)]);
  });

  it("skips auto-supersession for deterministic-repair claim keys even when one active sibling matches", async () => {
    const activeSibling = createExistingEntry({
      claim_key: "jim/timezone",
      subject: "Jim timezone",
    });
    const db = new MockDatabase({
      claimKeyPrefixes: ["jim"],
      activeEntriesByClaimKey: {
        "jim/timezone": [activeSibling],
      },
    });
    const embedding = new MockEmbeddingPort();
    const llm = new MockLlmPort({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.89,
    });
    const warnings: string[] = [];

    const result = await storeEntries(
      [
        createInput({
          subject: "Jim's timezone",
          content: "Jim's timezone is America/Chicago.",
        }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.95,
            eligibleTypes: ["fact", "preference", "decision"],
          },
        },
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim/timezone",
      claim_key_status: "tentative",
      claim_key_source: "deterministic_repair",
      claim_key_confidence: 0.86,
    });
    expect(db.insertions[0]?.entry.claim_key_rationale).toMatch(/deterministic/i);
    expect(db.supersedeCalls).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/deterministic_repair/i)]);
  });

  it("persists compaction rationale when a verbose extracted claim key is rewritten", async () => {
    const db = new MockDatabase({
      claimKeyPrefixes: ["openclaw_before_prompt_build_hook"],
    });
    const embedding = new MockEmbeddingPort();
    const llm = new MockLlmPort({
      entity: "OpenClaw before prompt build hook",
      attribute: "requires real agent turn or message to trigger",
      confidence: 0.92,
    });

    await storeEntries(
      [
        createInput({
          type: "decision",
          subject: "Before-prompt-build trigger contract",
          content: "The before-prompt-build hook only triggers after a real agent turn or message.",
        }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision"],
          },
        },
      },
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "openclaw_before_prompt_build_hook/trigger_condition",
      claim_key_raw: "OpenClaw before prompt build hook/requires real agent turn or message to trigger",
      claim_key_status: "trusted",
      claim_key_source: "model",
    });
    expect(db.insertions[0]?.entry.claim_key_rationale).toContain("collapsed a sentence-like trigger requirement into a stable condition slot");
  });

  it("accepts a supported below-threshold candidate when trusted claim-key examples strongly match the same slot", async () => {
    const db = new MockDatabase({
      claimKeyPrefixes: ["repo_workflow"],
      claimKeyExamples: ["repo_workflow/source_of_truth"],
    });
    const embedding = new MockEmbeddingPort();
    const llm = new MockLlmPort({
      entity: "Repo workflow",
      attribute: "source of truth",
      confidence: 0.74,
    });

    await storeEntries(
      [
        createInput({
          type: "decision",
          subject: "Repo workflow docs",
          content: "AGENTS.md is the source of truth for the repo workflow, even when older notes disagree.",
        }),
      ],
      db,
      embedding,
      {
        claimExtraction: {
          llm,
          db,
          config: {
            enabled: true,
            confidenceThreshold: 0.8,
            eligibleTypes: ["fact", "preference", "decision", "lesson"],
          },
        },
      },
    );

    expect(db.insertions[0]?.entry).toMatchObject({
      claim_key: "repo_workflow/source_of_truth",
      claim_key_status: "trusted",
      claim_key_source: "model",
      claim_key_confidence: 0.74,
    });
    expect(db.insertions[0]?.entry.claim_key_rationale).toContain("trusted exact-key reuse");
  });

  it("skips auto-supersession when the matching sibling has an incompatible type", async () => {
    const activeSibling = createExistingEntry({
      type: "fact",
      claim_key: "jim/home_city",
      subject: "Jim home city",
    });
    const db = new MockDatabase({
      activeEntriesByClaimKey: {
        "jim/home_city": [activeSibling],
      },
    });
    const embedding = new MockEmbeddingPort();
    const warnings: string[] = [];

    const result = await storeEntries(
      [
        createInput({
          type: "decision",
          subject: "Jim home city policy",
          content: "Use Jim's current home city for tax withholding.",
          claim_key: "jim/home_city",
        }),
      ],
      db,
      embedding,
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.supersedeCalls).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/same type/i)]);
  });

  it("links explicit supersession after storing a replacement entry even when a claim-key sibling also exists", async () => {
    const sameClaimKeySibling = createExistingEntry({
      claim_key: "jim/home_city",
      subject: "Jim home city",
    });
    const db = new MockDatabase({
      activeEntriesByClaimKey: {
        "jim/home_city": [sameClaimKeySibling],
      },
    });
    const embedding = new MockEmbeddingPort();
    const supersededId = randomUUID();

    const result = await storeEntries(
      [
        createInput({
          subject: "new home city",
          content: "Jim now lives in Denver, Colorado.",
          supersedes: supersededId,
          claim_key: "jim/home_city",
        }),
      ],
      db,
      embedding,
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.supersedeCalls).toEqual([
      {
        oldId: supersededId,
        newId: db.insertions[0]?.entry.id ?? "",
        kind: "update",
        reason: undefined,
      },
    ]);
    expect(db.transactionCount).toBe(1);
  });

  it("stores successfully and emits a warning when supersedes points to an inactive or missing entry", async () => {
    const db = new MockDatabase({
      supersedeResult: false,
    });
    const embedding = new MockEmbeddingPort();
    const warnings: string[] = [];

    const result = await storeEntries(
      [
        createInput({
          subject: "replacement entry",
          content: "This entry should still store even when supersession fails.",
          supersedes: randomUUID(),
        }),
      ],
      db,
      embedding,
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toEqual({ stored: 1, skipped: 0, rejected: 0 });
    expect(db.insertions).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not supersede/i);
  });
});

class MockDatabase implements DatabasePort {
  public readonly insertions: Array<{ entry: Entry; embedding: number[]; contentHash: string }> = [];
  public readonly existingHashes: Set<string>;
  public readonly existingNormHashes: Set<string>;
  public readonly claimKeyPrefixes: string[];
  public readonly claimKeyExamples: string[];
  public readonly activeEntriesByClaimKey: Record<string, Entry[]>;
  public readonly claimKeyLookupCalls: string[] = [];
  public readonly supersedeCalls: Array<{ oldId: string; newId: string; kind?: string; reason?: string }> = [];
  public transactionCount = 0;
  private readonly supersedeResult: boolean;

  public constructor(
    options: {
      existingHashes?: Set<string>;
      existingNormHashes?: Set<string>;
      claimKeyPrefixes?: string[];
      claimKeyExamples?: string[];
      activeEntriesByClaimKey?: Record<string, Entry[]>;
      supersedeResult?: boolean;
    } = {},
  ) {
    this.existingHashes = options.existingHashes ?? new Set();
    this.existingNormHashes = options.existingNormHashes ?? new Set();
    this.claimKeyPrefixes = options.claimKeyPrefixes ?? [];
    this.claimKeyExamples = options.claimKeyExamples ?? [];
    this.activeEntriesByClaimKey = options.activeEntriesByClaimKey ?? {};
    this.supersedeResult = options.supersedeResult ?? true;
  }

  public async insertEntry(entry: Entry, embedding: number[], contentHash: string): Promise<string> {
    this.insertions.push({
      entry,
      embedding,
      contentHash,
    });
    return entry.id;
  }

  public async prepareForBulkWrites(): Promise<void> {}

  public async finalizeBulkWrites(): Promise<void> {}

  public async getEntries(): Promise<Entry[]> {
    return [];
  }

  public async getEntry(): Promise<Entry | null> {
    return null;
  }

  public async findExistingHashes(hashes: string[]): Promise<Set<string>> {
    return new Set(hashes.filter((hash) => this.existingHashes.has(hash)));
  }

  public async findExistingNormHashes(hashes: string[]): Promise<Set<string>> {
    return new Set(hashes.filter((hash) => this.existingNormHashes.has(hash)));
  }

  public async retireEntry(): Promise<boolean> {
    return false;
  }

  public async supersedeEntry(oldId: string, newId: string, kind?: string, reason?: string): Promise<boolean> {
    this.supersedeCalls.push({ oldId, newId, kind, reason });
    return this.supersedeResult;
  }

  public async findActiveEntriesByClaimKey(claimKey: string): Promise<Entry[]> {
    this.claimKeyLookupCalls.push(claimKey);
    return this.activeEntriesByClaimKey[claimKey] ?? [];
  }

  public async getDistinctClaimKeyPrefixes(): Promise<string[]> {
    return this.claimKeyPrefixes;
  }

  public async getClaimKeyExamples(limit?: number): Promise<string[]> {
    return this.claimKeyExamples.slice(0, limit ?? this.claimKeyExamples.length);
  }

  public async updateEntry(): Promise<boolean> {
    return false;
  }

  public async getIngestLogEntry(): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return null;
  }

  public async insertIngestLogEntry(): Promise<void> {}

  public async init(): Promise<void> {}

  public async close(): Promise<void> {}

  public async withTransaction<T>(fn: (db: DatabasePort) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return fn(this);
  }
}

class MockEmbeddingPort implements EmbeddingPort {
  public readonly calls: string[][] = [];

  public async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((_, index) => [index + 1, index + 2]);
  }
}

class MockLlmPort implements LlmPort {
  public readonly calls: Array<{ systemPrompt: string; userMessage: string }> = [];

  public constructor(private readonly response: Record<string, unknown> | ((callIndex: number, systemPrompt: string, userMessage: string) => unknown)) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used in these tests.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    const callIndex = this.calls.length;
    this.calls.push({ systemPrompt, userMessage });
    const response = typeof this.response === "function" ? this.response(callIndex, systemPrompt, userMessage) : this.response;
    if (response instanceof Error) {
      throw response;
    }

    return response as T;
  }
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
    created_at: overrides.created_at,
    supersedes: overrides.supersedes,
    claim_key: overrides.claim_key,
    claim_key_raw: overrides.claim_key_raw,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_key_confidence: overrides.claim_key_confidence,
    claim_key_rationale: overrides.claim_key_rationale,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
  };
}

function createExistingEntry(overrides: Partial<Entry> & Pick<Entry, "claim_key">): Entry {
  const now = "2026-04-04T12:00:00.000Z";

  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "existing subject",
    content: overrides.content ?? "existing content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "temporary",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}
