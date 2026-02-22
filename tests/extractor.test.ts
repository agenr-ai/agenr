import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_PLATFORM_ADDENDUM,
  MAX_PREFETCH_RESULTS,
  OPENCLAW_CONFIDENCE_ADDENDUM,
  PLAUD_PLATFORM_ADDENDUM,
  PREFETCH_TIMEOUT_MS,
  SYSTEM_PROMPT,
  applyConfidenceCap,
  buildExtractionSystemPrompt,
  buildUserPrompt,
  extractKnowledgeFromChunks,
  preFetchRelated,
  validateEntry,
} from "../src/extractor.js";
import { initDb } from "../src/db/client.js";
import { renderTranscriptLine } from "../src/parser.js";
import { requestShutdown, resetShutdownForTests } from "../src/shutdown.js";
import { KNOWLEDGE_PLATFORMS } from "../src/types.js";
import type { KnowledgeEntry, LlmClient, StoredEntry, TranscriptChunk, TranscriptMessage } from "../src/types.js";

function fakeModel(): Model<Api> {
  return {
    id: "claude-opus-4-6",
    name: "Claude Opus",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function fakeClient(): LlmClient {
  return {
    auth: "anthropic-api-key",
    resolvedModel: {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: fakeModel(),
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

function fakeClientWithModelId(modelId: string): LlmClient {
  const base = fakeClient();
  return {
    ...base,
    resolvedModel: {
      ...base.resolvedModel,
      modelId,
    },
  };
}

function fakeChunk(): TranscriptChunk {
  return {
    chunk_index: 0,
    message_start: 0,
    message_end: 2,
    text: "[m00000][user] hello",
    context_hint: "m00000 hello",
  };
}

function fakeChunkAt(index: number): TranscriptChunk {
  return {
    chunk_index: index,
    message_start: index * 2,
    message_end: index * 2 + 1,
    text: `[m${String(index).padStart(5, "0")}][user] hello ${index}`,
    context_hint: `m${String(index).padStart(5, "0")} hello ${index}`,
  };
}

function fakeChunkWithTimestamp(index: number, timestampEnd: string): TranscriptChunk {
  return {
    chunk_index: index,
    message_start: index * 2,
    message_end: index * 2 + 1,
    text: `[m${String(index).padStart(5, "0")}][user] hello ${index}`,
    context_hint: `m${String(index).padStart(5, "0")} hello ${index}`,
    timestamp_start: timestampEnd,
    timestamp_end: timestampEnd,
  };
}

function fakeMessages(): TranscriptMessage[] {
  return [
    {
      index: 0,
      role: "user",
      text: "First whole-file message",
      timestamp: "2026-02-21T10:00:00.000Z",
    },
    {
      index: 1,
      role: "assistant",
      text: "Second whole-file message",
      timestamp: "2026-02-21T10:01:00.000Z",
    },
  ];
}

function assistantMessageWithContent(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function assistantMessage(text: string): AssistantMessage {
  return assistantMessageWithContent([{ type: "text", text }]);
}

function streamWithResult(result: Promise<AssistantMessage>, events: AssistantMessageEvent[] = []) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: () => result,
  };
}

const openDbs: Client[] = [];

async function makeDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  openDbs.push(db);
  await initDb(db);
  return db;
}

function unitVector(similarity: number): number[] {
  const vec = Array.from({ length: 1024 }, () => 0);
  vec[0] = similarity;
  vec[1] = Math.sqrt(Math.max(0, 1 - similarity ** 2));
  return vec;
}

async function insertEntryWithEmbedding(
  db: Client,
  id: string,
  similarity: number,
  overrides: Partial<StoredEntry> = {},
): Promise<void> {
  const now = "2026-02-19T00:00:00.000Z";
  const embedding = unitVector(similarity);
  await db.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context,
        embedding, created_at, updated_at, recall_count, confirmations, contradictions
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?, ?, 0, 0, 0)
    `,
    args: [
      id,
      overrides.type ?? "fact",
      overrides.subject ?? `subject-${id}`,
      overrides.content ?? `content-${id}`,
      overrides.importance ?? 7,
      overrides.expiry ?? "temporary",
      overrides.scope ?? "private",
      overrides.source?.file ?? "test.jsonl",
      overrides.source?.context ?? "test",
      JSON.stringify(embedding),
      now,
      now,
    ],
  });
}

async function seedEntries(db: Client, count: number, similarity = 0): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await insertEntryWithEmbedding(db, `seed-${i}`, similarity);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of openDbs.splice(0)) {
    db.close();
  }
});

describe("SYSTEM_PROMPT", () => {
  it("includes explicit memory request guidance and trigger phrases", () => {
    expect(SYSTEM_PROMPT).toContain("Explicit Memory Requests");
    expect(SYSTEM_PROMPT).toContain("\"remember this\"");
    expect(SYSTEM_PROMPT).toContain("\"remember that\"");
    expect(SYSTEM_PROMPT).not.toContain('- "important:"');
  });

  it("documents assistant-side 'remember this' as a non-trigger (prompt-only)", () => {
    // This suite uses mocked model outputs, so we validate policy text in the prompt itself.
    expect(SYSTEM_PROMPT).toContain("Assistant messages don't constitute memory requests.");
  });

  it("includes Todo Completion Detection guidance", () => {
    expect(SYSTEM_PROMPT).toContain("Todo Completion Detection");
    expect(SYSTEM_PROMPT).toContain("Emit an \"event\" entry describing the completion");
  });

  it("lists expected todo completion keywords", () => {
    expect(SYSTEM_PROMPT).toMatch(/\bdone\b/i);
    expect(SYSTEM_PROMPT).toMatch(/\bfixed\b/i);
    expect(SYSTEM_PROMPT).toMatch(/\bresolved\b/i);
    expect(SYSTEM_PROMPT).toMatch(/\bcompleted\b/i);
    expect(SYSTEM_PROMPT).toMatch(/\bshipped\b/i);
    expect(SYSTEM_PROMPT).toMatch(/\bclosed\b/i);
    expect(SYSTEM_PROMPT).toMatch(/\bmerged\b/i);
  });

  it("reinforces that related memories do not lower threshold", () => {
    expect(SYSTEM_PROMPT).toContain("they are reference material only");
    expect(SYSTEM_PROMPT).toContain("do not lower the emission threshold");
  });
});

describe("buildExtractionSystemPrompt", () => {
  it("plaud is in KNOWLEDGE_PLATFORMS", () => {
    expect(KNOWLEDGE_PLATFORMS).toContain("plaud");
  });

  it("codex platform includes CODE_PLATFORM_ADDENDUM and starts with SYSTEM_PROMPT", () => {
    const result = buildExtractionSystemPrompt("codex", false);
    expect(result.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(result).toContain(CODE_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain(OPENCLAW_CONFIDENCE_ADDENDUM.trim());
    expect(result).not.toContain(PLAUD_PLATFORM_ADDENDUM.trim());
  });

  it("claude-code platform includes CODE_PLATFORM_ADDENDUM, not openclaw addendum", () => {
    const result = buildExtractionSystemPrompt("claude-code", false);
    expect(result.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(result).toContain(CODE_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain(OPENCLAW_CONFIDENCE_ADDENDUM.trim());
  });

  it("plaud platform includes PLAUD_PLATFORM_ADDENDUM only", () => {
    const result = buildExtractionSystemPrompt("plaud", false);
    expect(result.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(result).toContain(PLAUD_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain(CODE_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain(OPENCLAW_CONFIDENCE_ADDENDUM.trim());
  });

  it("openclaw platform still includes OPENCLAW_CONFIDENCE_ADDENDUM", () => {
    const result = buildExtractionSystemPrompt("openclaw", false);
    expect(result.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(result).toContain(OPENCLAW_CONFIDENCE_ADDENDUM.trim());
    expect(result).not.toContain(CODE_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain(PLAUD_PLATFORM_ADDENDUM.trim());
  });

  it("undefined platform returns base SYSTEM_PROMPT with no addenda", () => {
    const result = buildExtractionSystemPrompt(undefined, false);
    expect(result).toBe(SYSTEM_PROMPT);
    expect(result).not.toContain(OPENCLAW_CONFIDENCE_ADDENDUM.trim());
    expect(result).not.toContain(CODE_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain(PLAUD_PLATFORM_ADDENDUM.trim());
    expect(result).toContain("Max 8 entries");
  });

  it("unknown platform string returns base prompt only", () => {
    const result = buildExtractionSystemPrompt("zoom", false);
    expect(result).toBe(SYSTEM_PROMPT);
    expect(result).not.toContain(OPENCLAW_CONFIDENCE_ADDENDUM.trim());
    expect(result).not.toContain(CODE_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain(PLAUD_PLATFORM_ADDENDUM.trim());
  });

  it("whole-file mode removes max-entry chunk cap and uses whole-file calibration text", () => {
    const prompt = buildExtractionSystemPrompt("codex", true);
    expect(prompt).not.toContain("Max 8 entries; prefer 0-3.");
    expect(prompt).toContain("Calibration (whole-file mode - you have the FULL session context, not a fragment):");
  });

  it("chunked mode keeps max-entry chunk cap text", () => {
    const prompt = buildExtractionSystemPrompt("codex", false);
    expect(prompt).toContain("Max 8 entries; prefer 0-3.");
  });

  it("wholeFile + codex: calibration replaced and CODE_PLATFORM_ADDENDUM present", () => {
    const result = buildExtractionSystemPrompt("codex", true);
    expect(result).toContain(CODE_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain("Max 8 entries");
    expect(result).not.toContain("Typical chunk: 0-3 entries");
    expect(result).toContain("whole-file mode");
    expect(result).toContain("Typical session:");
  });

  it("wholeFile + openclaw: calibration replaced and OPENCLAW_CONFIDENCE_ADDENDUM present", () => {
    const result = buildExtractionSystemPrompt("openclaw", true);
    expect(result).toContain(OPENCLAW_CONFIDENCE_ADDENDUM.trim());
    expect(result).not.toContain("Max 8 entries");
    expect(result).toContain("whole-file mode");
  });

  it("wholeFile + plaud: calibration replaced and PLAUD_PLATFORM_ADDENDUM present", () => {
    const result = buildExtractionSystemPrompt("plaud", true);
    expect(result).toContain(PLAUD_PLATFORM_ADDENDUM.trim());
    expect(result).not.toContain("Max 8 entries");
    expect(result).toContain("whole-file mode");
    expect(result).not.toContain(CODE_PLATFORM_ADDENDUM.trim());
  });

  it("openclaw addendum instructs capping hedged claims", () => {
    expect(OPENCLAW_CONFIDENCE_ADDENDUM).toMatch(/unverified/i);
    expect(OPENCLAW_CONFIDENCE_ADDENDUM).toMatch(/I think|I believe|probably/);
    expect(OPENCLAW_CONFIDENCE_ADDENDUM).toMatch(/cap.*5|min.*5/i);
  });
});

describe("applyConfidenceCap", () => {
  function makeEntry(overrides: Partial<KnowledgeEntry>): KnowledgeEntry {
    return {
      type: "fact",
      content: "test content for confidence cap checks",
      subject: "test subject",
      importance: 7,
      tags: [],
      expiry: "temporary",
      source: { file: "test.jsonl", context: "test" },
      ...overrides,
    } as KnowledgeEntry;
  }

  it("caps importance from 8 to 5 for unverified entry on openclaw", () => {
    const entry = makeEntry({ importance: 8, tags: ["unverified", "agenr"] });
    const result = applyConfidenceCap(entry, "openclaw");
    expect(result.importance).toBe(5);
    expect(result.tags).toContain("unverified");
  });

  it("caps when platform is codex", () => {
    const entry = makeEntry({ importance: 8, tags: ["unverified"] });
    const result = applyConfidenceCap(entry, "codex");
    expect(result.importance).toBe(5);
  });

  it("caps when platform is claude-code", () => {
    const entry = makeEntry({ importance: 8, tags: ["unverified"] });
    const result = applyConfidenceCap(entry, "claude-code");
    expect(result.importance).toBe(5);
  });

  it("does not cap when platform is plaud", () => {
    const entry = makeEntry({ importance: 8, tags: ["unverified"] });
    const result = applyConfidenceCap(entry, "plaud");
    expect(result.importance).toBe(8);
  });

  it("does not cap when platform is undefined", () => {
    const entry = makeEntry({ importance: 8, tags: ["unverified"] });
    const result = applyConfidenceCap(entry, undefined);
    expect(result.importance).toBe(8);
  });

  it("does not cap codex entry without unverified tag", () => {
    const entry = makeEntry({ importance: 8, tags: [] });
    const result = applyConfidenceCap(entry, "codex");
    expect(result.importance).toBe(8);
  });

  it("does not cap entry without unverified tag", () => {
    const entry = makeEntry({ importance: 8, tags: ["agenr"] });
    const result = applyConfidenceCap(entry, "openclaw");
    expect(result.importance).toBe(8);
  });

  it("does not push down importance already at 5", () => {
    const entry = makeEntry({ importance: 5, tags: ["unverified"] });
    const result = applyConfidenceCap(entry, "openclaw");
    expect(result.importance).toBe(5);
  });

  it("does not push down importance below 5", () => {
    const entry = makeEntry({ importance: 3, tags: ["unverified"] });
    const result = applyConfidenceCap(entry, "openclaw");
    expect(result.importance).toBe(3);
  });

  it("preserves all tags when capping", () => {
    const entry = makeEntry({ importance: 9, tags: ["agenr", "unverified", "memory"] });
    const result = applyConfidenceCap(entry, "openclaw");
    expect(result.importance).toBe(5);
    expect(result.tags).toEqual(["agenr", "unverified", "memory"]);
  });

  it("returns a new object, does not mutate the original", () => {
    const entry = makeEntry({ importance: 8, tags: ["unverified"] });
    const result = applyConfidenceCap(entry, "openclaw");
    expect(result).not.toBe(entry);
    expect(entry.importance).toBe(8);
  });
});

describe("pre-fetch", () => {
  function emptyToolCallStream(_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) {
    return streamWithResult(
      Promise.resolve(
        assistantMessageWithContent(
          [{ type: "toolCall", id: "call_empty", name: "submit_knowledge", arguments: { entries: [] } }],
          "toolUse",
        ),
      ),
    );
  }

  it("skips embedding when db is not provided", async () => {
    const embedFn = vi.fn(async () => [unitVector(1)]);
    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl: emptyToolCallStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      embedFn,
    });

    expect(embedFn).not.toHaveBeenCalled();
    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
  });

  it("skips when db entry count is below threshold and proceeds at threshold", async () => {
    const dbBelow = await makeDb();
    await seedEntries(dbBelow, 19, 0.2);
    const embedBelow = vi.fn(async () => [unitVector(1)]);
    const below = await preFetchRelated("chunk text", dbBelow, "sk-test", embedBelow);
    expect(below).toEqual([]);
    expect(embedBelow).not.toHaveBeenCalled();

    const dbAt = await makeDb();
    await seedEntries(dbAt, 20, 0.2);
    const embedAt = vi.fn(async () => [unitVector(1)]);
    await preFetchRelated("chunk text", dbAt, "sk-test", embedAt);
    expect(embedAt).toHaveBeenCalledTimes(1);
  });

  it("filters by similarity threshold with boundary handling", async () => {
    const db = await makeDb();
    await seedEntries(db, 15, 0.1);
    await insertEntryWithEmbedding(db, "sim-080", 0.8, { subject: "sim-080", content: "sim-080" });
    await insertEntryWithEmbedding(db, "sim-07201", 0.7201, { subject: "sim-07201", content: "sim-07201" });
    await insertEntryWithEmbedding(db, "sim-07200", 0.72, { subject: "sim-07200", content: "sim-07200" });
    await insertEntryWithEmbedding(db, "sim-07199", 0.7199, { subject: "sim-07199", content: "sim-07199" });
    await insertEntryWithEmbedding(db, "sim-070", 0.7, { subject: "sim-070", content: "sim-070" });

    const related = await preFetchRelated("chunk", db, "sk-test", async () => [unitVector(1)]);
    expect(related.map((entry) => entry.subject)).toEqual(["sim-080", "sim-07201", "sim-07200"]);
  });

  it("caps related results at MAX_PREFETCH_RESULTS", async () => {
    const db = await makeDb();
    await seedEntries(db, 15, 0.1);
    await insertEntryWithEmbedding(db, "cap-1", 0.95, { subject: "cap-1" });
    await insertEntryWithEmbedding(db, "cap-2", 0.93, { subject: "cap-2" });
    await insertEntryWithEmbedding(db, "cap-3", 0.91, { subject: "cap-3" });
    await insertEntryWithEmbedding(db, "cap-4", 0.89, { subject: "cap-4" });
    await insertEntryWithEmbedding(db, "cap-5", 0.87, { subject: "cap-5" });

    const related = await preFetchRelated("chunk", db, "sk-test", async () => [unitVector(1)]);
    expect(related).toHaveLength(MAX_PREFETCH_RESULTS);
  });

  it("returns [] for embedding errors and degenerate embedding responses", async () => {
    const db = await makeDb();
    await seedEntries(db, 20, 0.2);

    await expect(
      preFetchRelated("chunk", db, "sk-test", async () => {
        throw new Error("embedding failed");
      }),
    ).resolves.toEqual([]);

    await expect(preFetchRelated("chunk", db, "sk-test", async () => [])).resolves.toEqual([]);
    await expect(
      preFetchRelated("chunk", db, "sk-test", async () => [{ embedding: null }] as unknown as number[][]),
    ).resolves.toEqual([]);
  });

  it("respects timeout and does not block chunk extraction", async () => {
    vi.useFakeTimers();

    const db = await makeDb();
    await seedEntries(db, 20, 0.2);
    const hangingEmbed = vi.fn(
      () =>
        new Promise<number[][]>(() => {
          // never resolves
        }),
    );

    const prefetchPromise = preFetchRelated("chunk", db, "sk-test", hangingEmbed);
    await vi.advanceTimersByTimeAsync(PREFETCH_TIMEOUT_MS + 20);
    await expect(prefetchPromise).resolves.toEqual([]);

    const extractPromise = extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl: emptyToolCallStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      db,
      embeddingApiKey: "sk-test",
      embedFn: hangingEmbed,
    });
    await vi.advanceTimersByTimeAsync(PREFETCH_TIMEOUT_MS + 20);
    const result = await extractPromise;
    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
  });

  it("includes related-memory header for empty related set", () => {
    const prompt = buildUserPrompt(fakeChunk(), []);
    expect(prompt).toContain("Existing related memories");
    expect(prompt).toContain("[none found]");
    expect(prompt).not.toContain("- [");
  });

  it("omits related-memory section when related is omitted or undefined", () => {
    const withoutArg = buildUserPrompt(fakeChunk());
    const explicitUndefined = buildUserPrompt(fakeChunk(), undefined);
    expect(withoutArg).not.toContain("Existing related memories");
    expect(explicitUndefined).not.toContain("Existing related memories");
  });

  it("renders related entries in prompt when provided", () => {
    const related = [
      { type: "fact", subject: "foo subject", content: "foo content" },
      { type: "fact", subject: "bar subject", content: "bar content" },
    ] as unknown as StoredEntry[];

    const prompt = buildUserPrompt(fakeChunk(), related);
    expect(prompt).toContain("- [fact] foo subject: foo content");
    expect(prompt).toContain("- [fact] bar subject: bar content");
  });

  it("returns [] for empty and whitespace chunk text without embedding", async () => {
    const db = await makeDb();
    await seedEntries(db, 20, 0.2);
    const embedFn = vi.fn(async () => [unitVector(1)]);

    await expect(preFetchRelated("", db, "sk-test", embedFn)).resolves.toEqual([]);
    await expect(preFetchRelated("   ", db, "sk-test", embedFn)).resolves.toEqual([]);
    expect(embedFn).not.toHaveBeenCalled();
  });
});

describe("extractKnowledgeFromChunks", () => {
  afterEach(() => {
    resetShutdownForTests();
  });

  it("skips pre-fetch in whole-file mode", async () => {
    const db = await makeDb();
    await seedEntries(db, 30, 0.2);
    const embedFn = vi.fn(async () => [unitVector(1)]);

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      messages: fakeMessages(),
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "force",
      db,
      embeddingApiKey: "sk-test",
      embedFn,
      streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
        streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [{ type: "toolCall", id: "call_empty", name: "submit_knowledge", arguments: { entries: [] } }],
              "toolUse",
            ),
          ),
        ),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(embedFn).not.toHaveBeenCalled();
    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
  });

  it("force mode without messages throws", async () => {
    await expect(
      extractKnowledgeFromChunks({
        file: "session.jsonl",
        chunks: [fakeChunk()],
        client: fakeClientWithModelId("gpt-4.1-nano"),
        verbose: false,
        wholeFile: "force",
        sleepImpl: async () => {},
      }),
    ).rejects.toThrow("force mode requires messages to be provided");
  });

  it("returns empty entries and warning when whole-file response is malformed JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      messages: fakeMessages(),
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "force",
      streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
        streamWithResult(Promise.resolve(assistantMessage("not-json"))),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toEqual([]);
    expect(result.warnings.some((line) => line.includes("Falling back to chunked mode"))).toBe(true);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("fires onChunkComplete once in whole-file mode even when zero entries are returned", async () => {
    const callbacks: Array<{
      chunkIndex: number;
      totalChunks: number;
      entriesExtracted?: number;
      durationMs?: number;
    }> = [];

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      messages: fakeMessages(),
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "force",
      streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
        streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [{ type: "toolCall", id: "call_empty", name: "submit_knowledge", arguments: { entries: [] } }],
              "toolUse",
            ),
          ),
        ),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async (chunkResult) => {
        callbacks.push(chunkResult);
      },
    });

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.chunkIndex).toBe(0);
    expect(callbacks[0]?.totalChunks).toBe(1);
    expect(callbacks[0]?.entriesExtracted).toBe(0);
    expect((callbacks[0]?.durationMs ?? -1) >= 0).toBe(true);
  });

  it("uses a single LLM call in whole-file mode and sends full rendered file text", async () => {
    const messages = fakeMessages();
    let callCount = 0;
    let prompt = "";

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      messages,
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "force",
      noDedup: true,
      streamSimpleImpl: (_model: Model<Api>, context: Context, _opts?: SimpleStreamOptions) => {
        callCount += 1;
        prompt = String(context.messages[0]?.content ?? "");
        return streamWithResult(Promise.resolve(assistantMessage("[]")));
      },
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    const fullRenderedText = messages.map((message) => renderTranscriptLine(message)).join("\n");
    expect(callCount).toBe(1);
    expect(prompt).toContain(fullRenderedText);
  });

  it("skips dedup in whole-file mode but runs dedup in chunked mode", async () => {
    let wholeFileDedupCalls = 0;
    const wholeFileStream = (_model: Model<Api>, context: Context, _opts?: SimpleStreamOptions) => {
      const prompt = String(context.messages[0]?.content ?? "");
      if (prompt.includes("Deduplicate these extracted knowledge entries.")) {
        wholeFileDedupCalls += 1;
      }
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            JSON.stringify([
              {
                type: "fact",
                content: "Duplicate candidate one with durable context",
                subject: "dedup subject",
                importance: 7,
                expiry: "temporary",
                tags: ["dedup"],
                source: { context: "a" },
              },
              {
                type: "fact",
                content: "Duplicate candidate two with durable context",
                subject: "dedup subject",
                importance: 7,
                expiry: "temporary",
                tags: ["dedup"],
                source: { context: "b" },
              },
            ]),
          ),
        ),
      );
    };

    const wholeFileResult = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      messages: fakeMessages(),
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "force",
      streamSimpleImpl: wholeFileStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    let chunkedDedupCalls = 0;
    const chunkedStream = (_model: Model<Api>, context: Context, _opts?: SimpleStreamOptions) => {
      const prompt = String(context.messages[0]?.content ?? "");
      if (prompt.includes("Deduplicate these extracted knowledge entries.")) {
        chunkedDedupCalls += 1;
        return streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [
                {
                  type: "toolCall",
                  id: "dedup_call",
                  name: "submit_deduped_knowledge",
                  arguments: {
                    entries: [
                      {
                        type: "fact",
                        content: "Merged deduplicated fact",
                        subject: "dedup subject",
                        importance: 7,
                        expiry: "temporary",
                        tags: ["dedup"],
                        source_context: "merged",
                      },
                    ],
                  },
                },
              ],
              "toolUse",
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Chunked candidate fact","subject":"dedup subject","importance":7,"expiry":"temporary","tags":["dedup"],"source":{"context":"chunk"}}]',
          ),
        ),
      );
    };

    const chunkedResult = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "never",
      streamSimpleImpl: chunkedStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(wholeFileDedupCalls).toBe(0);
    expect(wholeFileResult.entries).toHaveLength(2);
    expect(chunkedDedupCalls).toBeGreaterThanOrEqual(1);
    expect(chunkedResult.entries).toHaveLength(1);
  });

  it("reports whole-file onChunkComplete payload fields", async () => {
    const callbacks: Array<{
      chunkIndex: number;
      totalChunks: number;
      entriesExtracted?: number;
      durationMs?: number;
    }> = [];

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      messages: fakeMessages(),
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "force",
      streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
        streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Whole-file callback payload test entry","subject":"whole-file payload","importance":7,"expiry":"temporary","tags":["whole-file"],"source":{"context":"wf"}}]',
            ),
          ),
        ),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async (chunkResult) => {
        callbacks.push(chunkResult);
      },
    });

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.chunkIndex).toBe(0);
    expect(callbacks[0]?.totalChunks).toBe(1);
    expect(callbacks[0]?.entriesExtracted).toBe(1);
    expect((callbacks[0]?.durationMs ?? -1) >= 0).toBe(true);
  });

  it("retries whole-file extraction and succeeds on the third attempt with expected delays", async () => {
    let callCount = 0;
    const sleepCalls: number[] = [];
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const result = await extractKnowledgeFromChunks({
        file: "session.jsonl",
        chunks: [fakeChunk()],
        messages: fakeMessages(),
        client: fakeClientWithModelId("gpt-4.1-nano"),
        verbose: false,
        wholeFile: "force",
        streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
          callCount += 1;
          if (callCount < 3) {
            return streamWithResult(Promise.reject(new Error("network timeout")));
          }
          return streamWithResult(
            Promise.resolve(
              assistantMessage(
                '[{"type":"fact","content":"Retry success on third attempt","subject":"whole-file retry","importance":7,"expiry":"temporary","tags":["retry"],"source":{"context":"wf"}}]',
              ),
            ),
          );
        },
        sleepImpl: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      expect(callCount).toBe(3);
      expect(sleepCalls).toEqual([2000, 4000]);
      expect(result.entries).toHaveLength(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("falls back to chunked mode when whole-file retries are exhausted", async () => {
    let callCount = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      messages: fakeMessages(),
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: false,
      wholeFile: "force",
      streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
        callCount += 1;
        if (callCount <= 3) {
          return streamWithResult(Promise.reject(new Error("upstream outage")));
        }
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Fallback chunked result","subject":"fallback path","importance":7,"expiry":"temporary","tags":["fallback"],"source":{"context":"chunk"}}]',
            ),
          ),
        );
      },
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBeGreaterThanOrEqual(4);
    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((line) => line.includes("Falling back to chunked mode"))).toBe(true);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("watchMode overrides wholeFile and uses chunked extraction with warning", async () => {
    const verboseLines: string[] = [];
    let prompt = "";

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0)],
      messages: fakeMessages(),
      client: fakeClientWithModelId("gpt-4.1-nano"),
      verbose: true,
      watchMode: true,
      wholeFile: "force",
      noDedup: true,
      onVerbose: (line) => verboseLines.push(line),
      streamSimpleImpl: (_model: Model<Api>, context: Context, _opts?: SimpleStreamOptions) => {
        prompt = String(context.messages[0]?.content ?? "");
        return streamWithResult(Promise.resolve(assistantMessage("[]")));
      },
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(prompt).toContain("hello 0");
    expect(prompt).not.toContain("First whole-file message");
    expect(
      verboseLines.some((line) =>
        line.includes("watchMode=true overrides wholeFile setting to 'never'"),
      ),
    ).toBe(true);
  });

  it("treats pre-fetch failures as best-effort and still completes all chunks", async () => {
    const db = await makeDb();
    await seedEntries(db, 30, 0.2);
    const embedFn = vi.fn(async () => {
      throw new Error("embedding provider down");
    });

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1), fakeChunkAt(2)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
        streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [{ type: "toolCall", id: "call_empty", name: "submit_knowledge", arguments: { entries: [] } }],
              "toolUse",
            ),
          ),
        ),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      db,
      embeddingApiKey: "sk-test",
      embedFn,
    });

    expect(result.successfulChunks).toBe(3);
    expect(result.failedChunks).toBe(0);
  });

  it("runs concurrent pre-fetch calls without blocking other workers", async () => {
    vi.useFakeTimers();
    const db = await makeDb();
    await seedEntries(db, 30, 0.2);

    let inFlight = 0;
    let maxInFlight = 0;
    const llmCalls: number[] = [];
    const embedFn = vi.fn((texts: string[]) => {
      const text = texts[0] ?? "";
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      if (text.includes("hello 0")) {
        return new Promise<number[][]>(() => {
          // intentionally hangs; pre-fetch timeout should release this chunk
        });
      }

      return new Promise<number[][]>((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve([unitVector(1)]);
        }, 50);
      });
    });

    const resultPromise = extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1), fakeChunkAt(2), fakeChunkAt(3)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      llmConcurrency: 4,
      streamSimpleImpl: (_model: Model<Api>, context: Context, _opts?: SimpleStreamOptions) => {
        const prompt = String(context.messages[0]?.content ?? "");
        const match = /hello (\d+)/.exec(prompt);
        if (match?.[1]) {
          llmCalls.push(Number(match[1]));
        }
        return streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [{ type: "toolCall", id: "call_empty", name: "submit_knowledge", arguments: { entries: [] } }],
              "toolUse",
            ),
          ),
        );
      },
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      db,
      embeddingApiKey: "sk-test",
      embedFn,
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(llmCalls.length).toBeGreaterThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(PREFETCH_TIMEOUT_MS + 50);
    const result = await resultPromise;
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(result.successfulChunks).toBe(4);
    expect(result.failedChunks).toBe(0);
  });

  it("disables pre-fetch end-to-end with noPreFetch=true", async () => {
    const db = await makeDb();
    await seedEntries(db, 30, 0.2);
    const embedFn = vi.fn(async () => [unitVector(1)]);
    const prompts: string[] = [];

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      noPreFetch: true,
      db,
      embeddingApiKey: "sk-test",
      embedFn,
      streamSimpleImpl: (_model: Model<Api>, context: Context, _opts?: SimpleStreamOptions) => {
        prompts.push(String(context.messages[0]?.content ?? ""));
        return streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [{ type: "toolCall", id: "call_empty", name: "submit_knowledge", arguments: { entries: [] } }],
              "toolUse",
            ),
          ),
        );
      },
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(embedFn).not.toHaveBeenCalled();
    expect(prompts[0]).not.toContain("Existing related memories");
    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
  });

  it("calls embedding exactly once per chunk", async () => {
    const db = await makeDb();
    await seedEntries(db, 30, 0.2);
    const embedFn = vi.fn(async () => [unitVector(1)]);

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1), fakeChunkAt(2)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      db,
      embeddingApiKey: "sk-test",
      embedFn,
      streamSimpleImpl: (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
        streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [{ type: "toolCall", id: "call_empty", name: "submit_knowledge", arguments: { entries: [] } }],
              "toolUse",
            ),
          ),
        ),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(embedFn).toHaveBeenCalledTimes(3);
  });

  it("extracts entries from submit_knowledge tool calls", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "call_1",
                name: "submit_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Jim prefers pnpm for JavaScript monorepo package management",
                      subject: "Jim",
                      canonical_key: "preferred-package-manager",
                      importance: 8,
                      expiry: "permanent",
                      tags: ["tooling"],
                      source_context: "user discussed preferred package manager",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.type).toBe("fact");
    expect(result.entries[0]?.subject).toBe("Jim");
    expect(result.entries[0]?.canonical_key).toBe("preferred-package-manager");
    expect(result.entries[0]?.importance).toBe(8);
    expect(result.entries[0]?.source.file).toBe("session.jsonl");
    expect(result.entries[0]?.source.context).toBe("user discussed preferred package manager");
  });

  it("sets created_at from chunk timestamp when model does not provide it", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "call_ts",
                name: "submit_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "The agenr extraction pipeline now preserves source timestamps end to end.",
                      subject: "agenr extraction pipeline",
                      importance: 8,
                      expiry: "permanent",
                      tags: ["agenr", "timestamps"],
                      source_context: "timestamp discussion",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkWithTimestamp(0, "2026-02-16T05:20:01.123Z")],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.created_at).toBe("2026-02-16T05:20:01.123Z");
  });

  it("preserves created_at through LLM dedup output when dedup entry omits timestamp", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;

      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "submit_knowledge",
                  arguments: {
                    entries: [
                      {
                        type: "fact",
                        content: "Agenr now supports source adapter parsing for OpenClaw transcripts with timestamps.",
                        subject: "agenr source adapters",
                        canonical_key: "source-adapter-timestamp-preservation",
                        importance: 8,
                        expiry: "temporary",
                        tags: ["agenr", "adapters"],
                        source_context: "chunk 1",
                      },
                    ],
                  },
                },
              ],
              "toolUse",
            ),
          ),
        );
      }

      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessageWithContent(
              [
                {
                  type: "toolCall",
                  id: "call_2",
                  name: "submit_knowledge",
                  arguments: {
                    entries: [
                      {
                        type: "fact",
                        content: "Agenr source adapters preserve message timestamps and carry them through extraction.",
                        subject: "agenr source adapters",
                        canonical_key: "source-adapter-timestamp-preservation",
                        importance: 8,
                        expiry: "temporary",
                        tags: ["agenr", "timestamps"],
                        source_context: "chunk 2",
                      },
                    ],
                  },
                },
              ],
              "toolUse",
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "dedup_call",
                name: "submit_deduped_knowledge",
                arguments: {
                  entries: [
                      {
                        type: "fact",
                        content: "Agenr source adapters preserve transcript timestamps through parsing and extraction.",
                        subject: "agenr source adapters",
                        canonical_key: "source-adapter-timestamp-preservation",
                        importance: 8,
                      expiry: "temporary",
                      tags: ["agenr", "timestamps"],
                      source_context: "dedup merge",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [
        fakeChunkWithTimestamp(0, "2026-02-15T05:20:01.123Z"),
        fakeChunkWithTimestamp(1, "2026-02-16T05:20:01.123Z"),
      ],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.created_at).toBe("2026-02-16T05:20:01.123Z");
    expect(result.entries[0]?.canonical_key).toBe("source-adapter-timestamp-preservation");
  });

  it("falls back to text parsing when no tool calls are present", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim uses pnpm for JavaScript monorepo package management");
  });

  it("warns for unexpected tool names and still uses text fallback", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessageWithContent([
            {
              type: "toolCall",
              id: "call_2",
              name: "unexpected_tool",
              arguments: { entries: [] },
            },
            {
              type: "text",
              text: '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
            },
          ]),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('unexpected tool call "unexpected_tool"'))).toBe(true);
  });

  it("warns when submit_knowledge tool call has no entries array", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessageWithContent([
            {
              type: "toolCall",
              id: "call_3",
              name: "submit_knowledge",
              arguments: {},
            },
            {
              type: "text",
              text: '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
            },
          ]),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("tool call had no entries array"))).toBe(true);
  });

  it("parses fenced JSON responses", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            "```json\n[{\"type\":\"fact\",\"content\":\"Jim prefers pnpm for JavaScript monorepo package management\",\"subject\":\"Jim\",\"importance\":8,\"expiry\":\"permanent\",\"tags\":[\"tooling\"],\"source\":{\"file\":\"ignored\",\"context\":\"m00001\"}}]\n```",
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source.file).toBe("session.jsonl");
  });

  it("drops invalid entries but keeps valid ones", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            JSON.stringify([
              {
                type: "fact",
                content: "Agenr launched a major release with validated memory extraction quality improvements.",
                subject: "Agenr",
                importance: 8,
                expiry: "temporary",
                tags: ["launch"],
                source: { file: "ignored", context: "m00002" },
              },
              {
                type: "unsupported",
                content: "bad",
                subject: "bad",
                importance: 8,
                expiry: "permanent",
                tags: [],
                source: { file: "ignored", context: "x" },
              },
            ]),
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("invalid type"))).toBe(true);
  });

  it("retries after parse failure and succeeds", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(Promise.resolve(assistantMessage("not-json")));
      }
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"file":"x","context":"m"}}]',
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(2);
    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("retrying"))).toBe(true);
  });

  it("marks chunk failed when all retries fail", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      return streamWithResult(Promise.reject(new Error("429 rate limit")));
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(5);
    expect(result.successfulChunks).toBe(0);
    expect(result.failedChunks).toBe(1);
    expect(result.entries).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("extraction failed"))).toBe(true);
  });

  it("accepts source_context as a flat string", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source_context":"flat context"}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source.context).toBe("flat context");
  });

  it("accepts source as a flat string", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":"source as string"}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source.context).toBe("source as string");
  });

  it("accepts description instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","description":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm for JavaScript monorepo package management");
  });

  it("accepts text instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","text":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm for JavaScript monorepo package management");
  });

  it("accepts statement instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","statement":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim prefers pnpm for JavaScript monorepo package management");
  });

  it("accepts plural type names (DECISIONS, PREFERENCES, EVENTS)", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"DECISIONS","content":"Chose an async queue architecture for background job processing","subject":"Architecture","importance":8,"expiry":"temporary","tags":["arch"],"source":{"context":"m"}},{"type":"PREFERENCES","content":"Prefers a keto diet for weekly meal planning","subject":"Jim","importance":8,"expiry":"permanent","tags":["diet"],"source":{"context":"m"}},{"type":"EVENTS","content":"Launched version one of the product to production","subject":"Agenr","importance":8,"expiry":"temporary","tags":["launch"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.type).toBe("decision");
    expect(result.entries[1]?.type).toBe("preference");
    expect(result.entries[2]?.type).toBe("event");
  });

  it("accepts knowledge instead of content", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","knowledge":"Jim uses pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.content).toBe("Jim uses pnpm for JavaScript monorepo package management");
  });

  it("accepts name instead of subject", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","name":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.subject).toBe("Jim");
  });

  it("drops entries with no recognizable content field", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("empty content"))).toBe(true);
  });

  it("logs verbose raw sample and fallback field usage", async () => {
    const verboseLines: string[] = [];
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","description":"Jim prefers pnpm for JavaScript monorepo package management","name":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source_context":"flat context"}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: true,
      streamSimpleImpl,
      onVerbose: (line) => verboseLines.push(line),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(verboseLines.some((line) => line.startsWith("[raw-sample]"))).toBe(true);
    expect(verboseLines).toContain('[field-fallback] used "description" for content');
    expect(verboseLines).toContain('[field-fallback] used "name" for subject');
    expect(verboseLines).toContain('[field-fallback] used "source_context" for source.context');
  });

  it("routes stream deltas to onStreamDelta and emits newline per completed chunk", async () => {
    const deltas: Array<{ delta: string; kind: "text" | "thinking" }> = [];
    const verboseLines: string[] = [];

    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
        [
          { type: "thinking_start" } as AssistantMessageEvent,
          { type: "thinking_delta", delta: "reasoning " } as AssistantMessageEvent,
          { type: "text_delta", delta: "answer" } as AssistantMessageEvent,
          { type: "thinking_end" } as AssistantMessageEvent,
        ],
      );

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: true,
      noDedup: true,
      streamSimpleImpl,
      onVerbose: (line) => verboseLines.push(line),
      onStreamDelta: (delta, kind) => deltas.push({ delta, kind }),
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(deltas).toEqual([
      { delta: "reasoning ", kind: "thinking" },
      { delta: "answer", kind: "text" },
      { delta: "\n", kind: "text" },
      { delta: "reasoning ", kind: "thinking" },
      { delta: "answer", kind: "text" },
      { delta: "\n", kind: "text" },
    ]);
    expect(verboseLines).toEqual([
      "[whole-file] skipping whole-file: no messages parsed from file (falling back to chunked text)",
      "[chunk 1/2] attempt 1/5",
      "[thinking]",
      "[/thinking]",
      '[raw-sample] {"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}',
      "[chunk 2/2] attempt 1/5",
      "[thinking]",
      "[/thinking]",
      '[raw-sample] {"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}',
    ]);
  });

  it("sleeps between chunks using the default inter-chunk delay and skips sleeping after the last chunk", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1), fakeChunkAt(2)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl,
      sleepImpl,
      retryDelayMs: () => 0,
    });

    expect(sleepCalls).toEqual([150, 150]);
  });

  it("supports custom interChunkDelayMs", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1), fakeChunkAt(2)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      interChunkDelayMs: 50,
      streamSimpleImpl,
      sleepImpl,
      retryDelayMs: () => 0,
    });

    expect(sleepCalls).toEqual([50, 50]);
  });

  it("adapts inter-chunk delay upward on 429 and decays back toward base after success", async () => {
    let callCount = 0;
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 2) {
        return streamWithResult(Promise.reject(new Error("429 rate limit")));
      }
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );
    };

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1), fakeChunkAt(2)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl,
      sleepImpl,
      retryDelayMs: () => 0,
    });

    // sleep order: after chunk1 (base 150), retry backoff (0), after chunk2 (300*0.9 => 270)
    expect(sleepCalls).toEqual([150, 0, 270]);
  });

  it("retries up to 5 attempts and succeeds on the 5th", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount < 5) {
        return streamWithResult(Promise.reject(new Error("503 service unavailable")));
      }
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(5);
    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toHaveLength(1);
  });

  it("onChunkComplete receives entries per chunk", async () => {
    let callCount = 0;
    const chunkCallbacks: Array<{ chunkIndex: number; totalChunks: number; contents: string[] }> = [];
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      const index = callCount;
      callCount += 1;
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            JSON.stringify([
              {
                type: "fact",
                content:
                  index === 0
                    ? "Entry zero contains durable planning context"
                    : "Entry one contains durable implementation context",
                subject: "Jim",
                importance: 8,
                expiry: "permanent",
                tags: ["tooling"],
                source: { context: "m" },
              },
            ]),
          ),
        ),
      );
    };

    await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async (chunkResult) => {
        chunkCallbacks.push({
          chunkIndex: chunkResult.chunkIndex,
          totalChunks: chunkResult.totalChunks,
          contents: chunkResult.entries.map((entry) => entry.content),
        });
      },
    });

    expect(chunkCallbacks).toEqual([
      { chunkIndex: 0, totalChunks: 2, contents: ["Entry zero contains durable planning context"] },
      { chunkIndex: 1, totalChunks: 2, contents: ["Entry one contains durable implementation context"] },
    ]);
  });

  it("onChunkComplete returns empty final entries array", async () => {
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async () => {},
    });

    expect(result.successfulChunks).toBe(1);
    expect(result.failedChunks).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it("without onChunkComplete accumulates entries as before", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      const index = callCount;
      callCount += 1;
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            JSON.stringify([
              {
                type: "fact",
                content:
                  index === 0
                    ? "Entry zero contains durable planning context"
                    : "Entry one contains durable implementation context",
                subject: "Jim",
                importance: 8,
                expiry: "permanent",
                tags: ["tooling"],
                source: { context: "m" },
              },
            ]),
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries.map((entry) => entry.content)).toEqual(["Entry zero contains durable planning context", "Entry one contains durable implementation context"]);
  });

  it("onChunkComplete error in callback propagates", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      return streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Jim prefers pnpm for JavaScript monorepo package management","subject":"Jim","importance":8,"expiry":"permanent","tags":["tooling"],"source":{"context":"m"}}]',
          ),
        ),
      );
    };

    await expect(
      extractKnowledgeFromChunks({
        file: "session.jsonl",
        chunks: [fakeChunkAt(0), fakeChunkAt(1)],
        client: fakeClient(),
        verbose: false,
        streamSimpleImpl,
        sleepImpl: async () => {},
        retryDelayMs: () => 0,
        onChunkComplete: async () => {
          throw new Error("callback failed");
        },
      }),
    ).rejects.toThrow("callback failed");

    expect(callCount).toBe(1);
  });

  it("runs post-extraction dedup and merges obvious duplicates", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr skill server uses port 7373 in local development environments","subject":"agenr skill server port","importance":6,"expiry":"temporary","tags":["agenr","server"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr server port configuration defaults to 7373 during local runs","subject":"agenr server port configuration","importance":7,"expiry":"temporary","tags":["agenr","config"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "dedup_1",
                name: "submit_deduped_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Agenr local server defaults to port 7373 unless explicitly overridden",
                      subject: "agenr local server port",
                      importance: 7,
                      expiry: "temporary",
                      tags: ["agenr", "server", "config"],
                      source_context: "merged duplicate configuration notes",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(3);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.subject).toBe("agenr local server port");
  });

  it("preserves genuinely different entries during dedup", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr stores vectors in sqlite-vec for semantic similarity queries","subject":"agenr vector storage","importance":8,"expiry":"permanent","tags":["agenr","vectors"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"decision","content":"The project chose pnpm workspaces to manage monorepo dependencies","subject":"monorepo package manager","importance":8,"expiry":"temporary","tags":["pnpm","monorepo"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "dedup_2",
                name: "submit_deduped_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Agenr stores vectors in sqlite-vec for semantic similarity queries",
                      subject: "agenr vector storage",
                      importance: 8,
                      expiry: "permanent",
                      tags: ["agenr", "vectors"],
                      source_context: "kept as independent fact",
                    },
                    {
                      type: "decision",
                      content: "The project chose pnpm workspaces to manage monorepo dependencies",
                      subject: "monorepo package manager",
                      importance: 8,
                      expiry: "temporary",
                      tags: ["pnpm", "monorepo"],
                      source_context: "kept as independent decision",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.subject)).toEqual([
      "agenr vector storage",
      "monorepo package manager",
    ]);
  });

  it("preserves the highest importance when duplicates are merged", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr extraction pipeline retries model calls on transient provider errors","subject":"agenr extraction retries","importance":6,"expiry":"temporary","tags":["agenr","retries"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr extraction pipeline retries transient provider failures with exponential backoff","subject":"agenr extraction retries","importance":9,"expiry":"temporary","tags":["agenr","backoff"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }

      return streamWithResult(
        Promise.resolve(
          assistantMessageWithContent(
            [
              {
                type: "toolCall",
                id: "dedup_3",
                name: "submit_deduped_knowledge",
                arguments: {
                  entries: [
                    {
                      type: "fact",
                      content: "Agenr extraction retries transient provider failures with exponential backoff",
                      subject: "agenr extraction retries",
                      importance: 9,
                      expiry: "temporary",
                      tags: ["agenr", "retries", "backoff"],
                      source_context: "merged duplicate retry behavior notes",
                    },
                  ],
                },
              },
            ],
            "toolUse",
          ),
        ),
      );
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.importance).toBe(9);
  });

  it("skips post-extraction dedup when noDedup is true", async () => {
    let callCount = 0;
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      callCount += 1;
      if (callCount === 1) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr watch mode stores extracted entries incrementally per chunk","subject":"agenr watch mode behavior","importance":7,"expiry":"temporary","tags":["agenr","watch"],"source":{"context":"m0"}}]',
            ),
          ),
        );
      }
      if (callCount === 2) {
        return streamWithResult(
          Promise.resolve(
            assistantMessage(
              '[{"type":"fact","content":"Agenr watch mode persists chunk entries immediately after extraction","subject":"agenr watch mode behavior","importance":7,"expiry":"temporary","tags":["agenr","watch"],"source":{"context":"m1"}}]',
            ),
          ),
        );
      }
      throw new Error("dedup should not run");
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(callCount).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it("does not call dedup for empty or single-entry extraction results", async () => {
    const singleCallStream = vi.fn((_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(
        Promise.resolve(
          assistantMessage(
            '[{"type":"fact","content":"Agenr uses TypeScript with ESM modules and Node.js 20 runtime","subject":"agenr runtime stack","importance":7,"expiry":"permanent","tags":["typescript","node"],"source":{"context":"m0"}}]',
          ),
        ),
      ),
    );

    const singleResult = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl: singleCallStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(singleResult.entries).toHaveLength(1);
    expect(singleCallStream).toHaveBeenCalledTimes(1);

    const emptyStream = vi.fn((_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
      streamWithResult(Promise.resolve(assistantMessage("[]"))),
    );

    const emptyResult = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunk()],
      client: fakeClient(),
      verbose: false,
      streamSimpleImpl: emptyStream,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    expect(emptyResult.entries).toHaveLength(0);
    expect(emptyStream).toHaveBeenCalledTimes(1);
  });

  it("caps concurrent LLM calls based on llmConcurrency", async () => {
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (error: unknown) => void;
    };

    const deferred = <T,>(): Deferred<T> => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    let inFlight = 0;
    let maxInFlight = 0;
    const deferreds: Array<Deferred<AssistantMessage>> = [];

    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      const d = deferred<AssistantMessage>();
      deferreds.push(d);
      return streamWithResult(
        d.promise.finally(() => {
          inFlight = Math.max(0, inFlight - 1);
        }),
      );
    };

    const runPromise = extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: Array.from({ length: 10 }, (_, index) => fakeChunkAt(index)),
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      llmConcurrency: 3,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
    });

    while (deferreds.length < 3) {
      await Promise.resolve();
    }

    expect(maxInFlight).toBe(3);

    for (let i = 0; i < 10; i += 1) {
      while (deferreds.length <= i) {
        await Promise.resolve();
      }
      deferreds[i]?.resolve(assistantMessage("[]"));
    }

    const result = await runPromise;
    expect(result.successfulChunks).toBe(10);
    expect(result.failedChunks).toBe(0);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("allows onChunkComplete to fire out of order under concurrency", async () => {
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (error: unknown) => void;
    };

    const deferred = <T,>(): Deferred<T> => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    const deferreds: Array<Deferred<AssistantMessage>> = [];
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      const d = deferred<AssistantMessage>();
      deferreds.push(d);
      return streamWithResult(d.promise);
    };

    const chunkOrder: number[] = [];
    const runPromise = extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: [fakeChunkAt(0), fakeChunkAt(1)],
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      llmConcurrency: 2,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async (chunkResult) => {
        chunkOrder.push(chunkResult.chunkIndex);
      },
    });

    while (deferreds.length < 2) {
      await Promise.resolve();
    }

    deferreds[1]?.resolve(assistantMessage("[]"));
    while (chunkOrder.length < 1) {
      await Promise.resolve();
    }
    deferreds[0]?.resolve(assistantMessage("[]"));

    await runPromise;
    expect(chunkOrder).toEqual([1, 0]);
  });

  it("isolates chunk failures so other chunks still complete", async () => {
    const completed: number[] = [];
    const streamSimpleImpl = (_model: Model<Api>, context: Context, _opts?: SimpleStreamOptions) => {
      const userText = String(context.messages[0]?.content ?? "");
      if (userText.includes("hello 2")) {
        return streamWithResult(Promise.reject(new Error("400 bad request")));
      }
      return streamWithResult(Promise.resolve(assistantMessage("[]")));
    };

    const result = await extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: Array.from({ length: 5 }, (_, index) => fakeChunkAt(index)),
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      llmConcurrency: 3,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async (chunkResult) => {
        completed.push(chunkResult.chunkIndex);
      },
    });

    expect(result.successfulChunks).toBe(4);
    expect(result.failedChunks).toBe(1);
    expect(completed.sort((a, b) => a - b)).toEqual([0, 1, 3, 4]);
  });

  it("drains in-flight chunks and skips remaining work when shutdown is requested", async () => {
    resetShutdownForTests();

    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (error: unknown) => void;
    };

    const deferred = <T,>(): Deferred<T> => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    const deferreds: Array<Deferred<AssistantMessage>> = [];
    const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) => {
      const d = deferred<AssistantMessage>();
      deferreds.push(d);
      return streamWithResult(d.promise);
    };

    let shutdownSet = false;
    const runPromise = extractKnowledgeFromChunks({
      file: "session.jsonl",
      chunks: Array.from({ length: 10 }, (_, index) => fakeChunkAt(index)),
      client: fakeClient(),
      verbose: false,
      noDedup: true,
      llmConcurrency: 3,
      streamSimpleImpl,
      sleepImpl: async () => {},
      retryDelayMs: () => 0,
      onChunkComplete: async () => {
        if (!shutdownSet) {
          shutdownSet = true;
          requestShutdown();
        }
      },
    });

    while (deferreds.length < 3) {
      await Promise.resolve();
    }

    deferreds[0]?.resolve(assistantMessage("[]"));
    await Promise.resolve();

    deferreds[1]?.resolve(assistantMessage("[]"));
    deferreds[2]?.resolve(assistantMessage("[]"));

    const result = await runPromise;
    expect(deferreds).toHaveLength(3);
    expect(result.aborted).toBe(true);
    expect(result.skippedChunks).toBe(7);
    expect(result.successfulChunks).toBe(3);
    expect(result.failedChunks).toBe(0);
  });

  it("adds jitter to inter-chunk sleeps when llmConcurrency > 1", async () => {
    const sleepCalls: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const streamSimpleImpl = (_model: Model<Api>, _context: Context, _opts?: SimpleStreamOptions) =>
        streamWithResult(Promise.resolve(assistantMessage("[]")));

      await extractKnowledgeFromChunks({
        file: "session.jsonl",
        chunks: [fakeChunkAt(0), fakeChunkAt(1), fakeChunkAt(2)],
        client: fakeClient(),
        verbose: false,
        noDedup: true,
        llmConcurrency: 2,
        interChunkDelayMs: 100,
        streamSimpleImpl,
        sleepImpl,
        retryDelayMs: () => 0,
      });
    } finally {
      randomSpy.mockRestore();
    }

    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls.every((ms) => ms === 50)).toBe(true);
  });
});

describe("validateEntry", () => {
  it("rejects blocked subjects", () => {
    const reason = validateEntry({
      type: "fact",
      subject: "assistant",
      content: "Assistant preferences should not be extracted as durable memory.",
      importance: 6,
      expiry: "temporary",
      tags: ["meta"],
      source: { file: "x", context: "ctx" },
    });

    expect(reason).toContain("blocked subject");
  });

  it("rejects meta-pattern narration", () => {
    const reason = validateEntry({
      type: "fact",
      subject: "deployment verification",
      content: "The assistant ran the deployment checks and reported success.",
      importance: 6,
      expiry: "temporary",
      tags: ["deployment"],
      source: { file: "x", context: "ctx" },
    });

    expect(reason).toContain("meta-pattern");
  });

  it("enforces content length and importance floor", () => {
    const shortReason = validateEntry({
      type: "fact",
      subject: "tooling preference",
      content: "Too short.",
      importance: 6,
      expiry: "temporary",
      tags: ["tooling"],
      source: { file: "x", context: "ctx" },
    });
    const lowImportanceReason = validateEntry({
      type: "fact",
      subject: "tooling preference",
      content: "Prefers pnpm for JavaScript monorepo package management across projects.",
      importance: 4,
      expiry: "temporary",
      tags: ["tooling"],
      source: { file: "x", context: "ctx" },
    });

    expect(shortReason).toBe("content too short");
    expect(lowImportanceReason).toBe("importance 4 < 5");
  });
});
