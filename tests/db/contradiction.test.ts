import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import { SubjectIndex } from "../../src/db/subject-index.js";
import type { LlmClient, StoredEntry } from "../../src/types.js";

const { findSimilarMock } = vi.hoisted(() => ({
  findSimilarMock: vi.fn(),
}));

vi.mock("../../src/llm/stream.js", () => ({
  runSimpleStream: vi.fn(),
}));

vi.mock("../../src/db/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db/store.js")>("../../src/db/store.js");
  return {
    ...actual,
    findSimilar: findSimilarMock,
  };
});

import { runSimpleStream } from "../../src/llm/stream.js";
import * as contradictionModule from "../../src/db/contradiction.js";

interface DetectRow {
  id: string;
  content: string;
  type: string;
  subject: string;
  importance: number;
  createdAt: string;
}

interface SeedEntryOptions {
  type?: string;
  subject?: string;
  importance?: number;
  subjectKey?: string | null;
}

function makeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4.1-nano",
      model: {} as LlmClient["resolvedModel"]["model"],
    },
    credentials: {
      apiKey: "sk-test",
      source: "test",
    },
  };
}

function makeToolMessage(args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tool_1",
        name: "classify_conflict",
        arguments: args,
      },
    ],
    api: "openai-chat",
    provider: "openai",
    model: "gpt-4.1-nano",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function makeTextMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "No tool call",
      },
    ],
    api: "openai-chat",
    provider: "openai",
    model: "gpt-4.1-nano",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "endTurn",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function makeStoredEntry(params: {
  id: string;
  content: string;
  type?: string;
  subject?: string;
  importance?: number;
  createdAt?: string;
}): StoredEntry {
  const createdAt = params.createdAt ?? "2026-02-26T00:00:00.000Z";
  return {
    id: params.id,
    type: (params.type ?? "fact") as StoredEntry["type"],
    subject: params.subject ?? `subject-${params.id}`,
    content: params.content,
    importance: params.importance ?? 7,
    expiry: "permanent",
    tags: [],
    source: {
      file: "contradiction.test.ts",
      context: "unit-test",
    },
    created_at: createdAt,
    updated_at: createdAt,
    recall_count: 0,
    confirmations: 0,
    contradictions: 0,
  };
}

function makeDetectDb(rows: DetectRow[]): Client {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const execute = vi.fn(async (statement: unknown) => {
    const sql =
      typeof statement === "string"
        ? statement
        : String((statement as { sql?: unknown }).sql ?? "");
    const args =
      typeof statement === "string"
        ? []
        : (((statement as { args?: unknown[] }).args ?? []) as unknown[]);

    if (sql.includes("FROM entries") && sql.includes("WHERE id IN")) {
      const ids = args.map((value) => String(value));
      return {
        rows: ids
          .map((id) => rowById.get(id))
          .filter((row): row is DetectRow => Boolean(row))
          .map((row) => ({
            id: row.id,
            content: row.content,
            type: row.type,
            subject: row.subject,
            importance: row.importance,
            created_at: row.createdAt,
          })),
      };
    }

    return { rows: [] };
  });

  return { execute } as unknown as Client;
}

function makeSubjectIndexMock(ids: string[]): SubjectIndex {
  const lookup = vi.fn(() => ids);
  return { lookup, remove: vi.fn() } as unknown as SubjectIndex;
}

function zeroEmbedding(dimensions = 1024): number[] {
  return Array.from({ length: dimensions }, () => 0);
}

function buildConflict(params: {
  existingEntryId?: string;
  existingType?: string;
  existingImportance?: number;
  relation?: "contradicts" | "supersedes" | "coexists" | "unrelated";
  confidence?: number;
}) {
  return {
    existingEntryId: params.existingEntryId ?? "existing-entry",
    existingContent: "Existing content",
    existingType: params.existingType ?? "fact",
    existingSubject: "subject",
    existingImportance: params.existingImportance ?? 7,
    result: {
      relation: params.relation ?? "supersedes",
      confidence: params.confidence ?? 0.9,
      explanation: "test",
    },
  } satisfies contradictionModule.DetectedConflict;
}

async function seedEntry(client: Client, id: string, options: SeedEntryOptions = {}): Promise<void> {
  const now = "2026-02-26T00:00:00.000Z";
  await client.execute({
    sql: `
      INSERT INTO entries (
        id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at, subject_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      options.type ?? "fact",
      options.subject ?? `subject-${id}`,
      `content-${id}`,
      options.importance ?? 7,
      "permanent",
      "private",
      "contradiction.test.ts",
      "unit-test",
      now,
      now,
      options.subjectKey ?? null,
    ],
  });
}

describe("contradiction", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    vi.restoreAllMocks();
    findSimilarMock.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findSimilarMock.mockReset();
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("returns supersedes when LLM says supersedes", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        relation: "supersedes",
        confidence: 0.93,
        explanation: "new entry clearly updates prior value",
      }),
    );

    const result = await contradictionModule.classifyConflict(
      makeLlmClient(),
      { content: "Alex now weighs 180 lbs", type: "fact", subject: "Alex weight" },
      {
        content: "Alex weighs 200 lbs",
        type: "fact",
        subject: "Alex weight",
        createdAt: "2026-02-20T00:00:00.000Z",
      },
    );

    expect(result.relation).toBe("supersedes");
    expect(result.confidence).toBeCloseTo(0.93);
  });

  it("returns contradicts when LLM says contradicts", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        relation: "contradicts",
        confidence: 0.81,
        explanation: "claims cannot both be true without time context",
      }),
    );

    const result = await contradictionModule.classifyConflict(
      makeLlmClient(),
      { content: "Acme HQ is in Austin", type: "fact", subject: "Acme HQ" },
      {
        content: "Acme HQ is in Seattle",
        type: "fact",
        subject: "Acme HQ",
        createdAt: "2026-02-20T00:00:00.000Z",
      },
    );

    expect(result.relation).toBe("contradicts");
  });

  it("returns coexists when LLM says coexists", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        relation: "coexists",
        confidence: 0.88,
        explanation: "both statements can be true in different contexts",
      }),
    );

    const result = await contradictionModule.classifyConflict(
      makeLlmClient(),
      { content: "Alex prefers TypeScript", type: "preference", subject: "Alex languages" },
      {
        content: "Alex likes Python",
        type: "preference",
        subject: "Alex languages",
        createdAt: "2026-02-20T00:00:00.000Z",
      },
    );

    expect(result.relation).toBe("coexists");
  });

  it("returns unrelated when LLM says unrelated", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        relation: "unrelated",
        confidence: 0.9,
        explanation: "different entities",
      }),
    );

    const result = await contradictionModule.classifyConflict(
      makeLlmClient(),
      { content: "Alex prefers TypeScript", type: "preference", subject: "Alex languages" },
      {
        content: "The release happened Friday",
        type: "event",
        subject: "Release",
        createdAt: "2026-02-20T00:00:00.000Z",
      },
    );

    expect(result.relation).toBe("unrelated");
  });

  it("returns unrelated with confidence 0 on LLM error", async () => {
    vi.mocked(runSimpleStream).mockRejectedValueOnce(new Error("LLM failure"));

    const result = await contradictionModule.classifyConflict(
      makeLlmClient(),
      { content: "new", type: "fact", subject: "s" },
      { content: "old", type: "fact", subject: "s", createdAt: "2026-02-20T00:00:00.000Z" },
    );

    expect(result).toEqual({
      relation: "unrelated",
      confidence: 0,
      explanation: "LLM error",
    });
  });

  it("returns unrelated with confidence 0 on missing tool call", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(makeTextMessage());

    const result = await contradictionModule.classifyConflict(
      makeLlmClient(),
      { content: "new", type: "fact", subject: "s" },
      { content: "old", type: "fact", subject: "s", createdAt: "2026-02-20T00:00:00.000Z" },
    );

    expect(result).toEqual({
      relation: "unrelated",
      confidence: 0,
      explanation: "LLM error",
    });
  });

  it("finds candidates via subject index when subjectKey is set and still runs embedding lookup", async () => {
    const db = makeDetectDb([
      {
        id: "entry-1",
        content: "old one",
        type: "fact",
        subject: "subject-1",
        importance: 6,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "entry-2",
        content: "old two",
        type: "fact",
        subject: "subject-2",
        importance: 7,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "entry-3",
        content: "old three",
        type: "fact",
        subject: "subject-3",
        importance: 8,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
    ]);
    const subjectIndex = makeSubjectIndexMock(["entry-1", "entry-2", "entry-3"]);
    findSimilarMock.mockResolvedValue([]);
    vi.mocked(runSimpleStream)
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "coexists",
          confidence: 0.8,
          explanation: "related",
        }),
      )
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "coexists",
          confidence: 0.82,
          explanation: "related",
        }),
      )
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "coexists",
          confidence: 0.84,
          explanation: "related",
        }),
      );

    const detected = await contradictionModule.detectContradictions(
      db,
      {
        content: "new content",
        type: "fact",
        subject: "new-subject",
        subjectKey: "person:alex|attr:weight",
        importance: 7,
      },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
    );

    expect(detected).toHaveLength(3);
    expect(findSimilarMock).toHaveBeenCalledTimes(1);
    expect(runSimpleStream).toHaveBeenCalledTimes(3);
  });

  it("falls back to embedding similarity when no subject key", async () => {
    const db = makeDetectDb([]);
    const subjectIndex = makeSubjectIndexMock([]);
    findSimilarMock.mockResolvedValue([
      {
        entry: makeStoredEntry({ id: "sim-1", content: "similar one", createdAt: "2026-02-20T00:00:00.000Z" }),
        similarity: 0.9,
      },
    ]);
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        relation: "supersedes",
        confidence: 0.9,
        explanation: "newer value",
      }),
    );

    const detected = await contradictionModule.detectContradictions(
      db,
      {
        content: "new content",
        type: "fact",
        subject: "new-subject",
        importance: 7,
      },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
    );

    expect(detected).toHaveLength(1);
    expect(findSimilarMock).toHaveBeenCalledTimes(1);
    expect(
      (subjectIndex as unknown as { lookup: ReturnType<typeof vi.fn> }).lookup,
    ).not.toHaveBeenCalled();
  });

  it("uses both subject index and embedding when subject has fewer than 3 matches", async () => {
    const db = makeDetectDb([
      {
        id: "entry-subject",
        content: "subject candidate",
        type: "fact",
        subject: "subject",
        importance: 7,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
    ]);
    const subjectIndex = makeSubjectIndexMock(["entry-subject"]);
    findSimilarMock.mockResolvedValue([
      {
        entry: makeStoredEntry({ id: "entry-subject", content: "subject candidate" }),
        similarity: 0.95,
      },
      {
        entry: makeStoredEntry({ id: "entry-sim", content: "similar candidate" }),
        similarity: 0.9,
      },
    ]);
    vi.mocked(runSimpleStream)
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "coexists",
          confidence: 0.85,
          explanation: "related",
        }),
      )
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "coexists",
          confidence: 0.86,
          explanation: "related",
        }),
      );

    const detected = await contradictionModule.detectContradictions(
      db,
      {
        content: "new content",
        type: "fact",
        subject: "new-subject",
        subjectKey: "person:alex|attr:weight",
        importance: 7,
      },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
    );

    expect(detected.map((entry) => entry.existingEntryId).sort()).toEqual(["entry-sim", "entry-subject"]);
  });

  it("caps subject-index candidates to maxCandidates after sorting by recency", async () => {
    const rows: DetectRow[] = Array.from({ length: 10 }, (_, index) => {
      const rank = index + 1;
      const day = String(rank).padStart(2, "0");
      return {
        id: `entry-${rank}`,
        content: `content-${rank}`,
        type: "fact",
        subject: `subject-${rank}`,
        importance: rank,
        createdAt: `2026-02-${day}T00:00:00.000Z`,
      };
    });
    const db = makeDetectDb(rows);
    const subjectIndex = makeSubjectIndexMock(rows.map((row) => row.id).reverse());
    findSimilarMock.mockResolvedValue([]);
    vi.mocked(runSimpleStream).mockImplementation(async () =>
      makeToolMessage({
        relation: "coexists",
        confidence: 0.8,
        explanation: "related",
      }),
    );

    const detected = await contradictionModule.detectContradictions(
      db,
      {
        content: "new content",
        type: "fact",
        subject: "new-subject",
        subjectKey: "person:alex|attr:weight",
        importance: 7,
      },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
      { maxCandidates: 5 },
    );

    expect(detected.map((entry) => entry.existingEntryId)).toEqual([
      "entry-10",
      "entry-9",
      "entry-8",
      "entry-7",
      "entry-6",
    ]);
    expect(runSimpleStream).toHaveBeenCalledTimes(5);
    expect(findSimilarMock).toHaveBeenCalledTimes(1);
  });

  it("always runs embedding search even when subject index returns at maxCandidates", async () => {
    const rows: DetectRow[] = Array.from({ length: 5 }, (_, index) => ({
      id: `entry-${index + 1}`,
      content: `content-${index + 1}`,
      type: "fact",
      subject: `subject-${index + 1}`,
      importance: 7,
      createdAt: "2026-02-24T00:00:00.000Z",
    }));
    const db = makeDetectDb(rows);
    const subjectIndex = makeSubjectIndexMock(rows.map((row) => row.id));
    findSimilarMock.mockResolvedValue([]);
    vi.mocked(runSimpleStream).mockImplementation(async () =>
      makeToolMessage({
        relation: "coexists",
        confidence: 0.8,
        explanation: "related",
      }),
    );

    const detected = await contradictionModule.detectContradictions(
      db,
      {
        content: "new content",
        type: "fact",
        subject: "new-subject",
        subjectKey: "person:alex|attr:weight",
        importance: 7,
      },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
      { maxCandidates: 5 },
    );

    expect(detected).toHaveLength(5);
    expect(findSimilarMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes duplicate ids across subject and embedding candidates", async () => {
    const db = makeDetectDb([
      {
        id: "entry-1",
        content: "subject candidate",
        type: "fact",
        subject: "subject-1",
        importance: 7,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
    ]);
    const subjectIndex = makeSubjectIndexMock(["entry-1"]);
    findSimilarMock.mockResolvedValue([
      {
        entry: makeStoredEntry({ id: "entry-1", content: "subject candidate", createdAt: "2026-02-23T00:00:00.000Z" }),
        similarity: 0.95,
      },
      {
        entry: makeStoredEntry({ id: "entry-2", content: "embedding candidate", createdAt: "2026-02-22T00:00:00.000Z" }),
        similarity: 0.93,
      },
    ]);
    vi.mocked(runSimpleStream)
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "coexists",
          confidence: 0.82,
          explanation: "related",
        }),
      )
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "coexists",
          confidence: 0.83,
          explanation: "related",
        }),
      );

    const detected = await contradictionModule.detectContradictions(
      db,
      {
        content: "new content",
        type: "fact",
        subject: "new-subject",
        subjectKey: "person:alex|attr:weight",
        importance: 7,
      },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
      { maxCandidates: 5 },
    );

    expect(detected.map((entry) => entry.existingEntryId).sort()).toEqual(["entry-1", "entry-2"]);
    expect(runSimpleStream).toHaveBeenCalledTimes(2);
  });

  it("calls classifyConflict in parallel across candidates", async () => {
    const db = makeDetectDb([
      {
        id: "entry-1",
        content: "old one",
        type: "fact",
        subject: "subject-1",
        importance: 6,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "entry-2",
        content: "old two",
        type: "fact",
        subject: "subject-2",
        importance: 7,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
      {
        id: "entry-3",
        content: "old three",
        type: "fact",
        subject: "subject-3",
        importance: 8,
        createdAt: "2026-02-24T00:00:00.000Z",
      },
    ]);
    const subjectIndex = makeSubjectIndexMock(["entry-1", "entry-2", "entry-3"]);
    findSimilarMock.mockResolvedValue([]);

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runSimpleStream).mockImplementation(async () => {
      await gate;
      return makeToolMessage({
        relation: "coexists",
        confidence: 0.8,
        explanation: "related",
      });
    });

    const pending = contradictionModule.detectContradictions(
      db,
      {
        content: "new content",
        type: "fact",
        subject: "new-subject",
        subjectKey: "person:alex|attr:weight",
        importance: 7,
      },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
    );
    await vi.waitFor(() => {
      expect(runSimpleStream).toHaveBeenCalledTimes(3);
    });

    release?.();
    const detected = await pending;
    expect(detected).toHaveLength(3);
  });

  it("filters out unrelated results from returned conflicts", async () => {
    const db = makeDetectDb([]);
    const subjectIndex = makeSubjectIndexMock([]);
    findSimilarMock.mockResolvedValue([
      {
        entry: makeStoredEntry({ id: "sim-1", content: "similar one" }),
        similarity: 0.92,
      },
      {
        entry: makeStoredEntry({ id: "sim-2", content: "similar two" }),
        similarity: 0.91,
      },
    ]);
    vi.mocked(runSimpleStream)
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "unrelated",
          confidence: 0.7,
          explanation: "none",
        }),
      )
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "contradicts",
          confidence: 0.8,
          explanation: "conflict",
        }),
      );

    const detected = await contradictionModule.detectContradictions(
      db,
      { content: "new", type: "fact", subject: "s", importance: 7 },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
    );

    expect(detected).toHaveLength(1);
    expect(detected[0]?.existingEntryId).toBe("sim-2");
  });

  it("returns empty array when no candidates found", async () => {
    const db = makeDetectDb([]);
    const subjectIndex = makeSubjectIndexMock([]);
    findSimilarMock.mockResolvedValue([]);

    const detected = await contradictionModule.detectContradictions(
      db,
      { content: "new", type: "fact", subject: "s", subjectKey: "k", importance: 7 },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
    );

    expect(detected).toEqual([]);
  });

  it("returns empty array when all candidates are unrelated", async () => {
    const db = makeDetectDb([]);
    const subjectIndex = makeSubjectIndexMock([]);
    findSimilarMock.mockResolvedValue([
      {
        entry: makeStoredEntry({ id: "sim-1", content: "similar one" }),
        similarity: 0.95,
      },
      {
        entry: makeStoredEntry({ id: "sim-2", content: "similar two" }),
        similarity: 0.94,
      },
    ]);
    vi.mocked(runSimpleStream)
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "unrelated",
          confidence: 0.8,
          explanation: "no link",
        }),
      )
      .mockResolvedValueOnce(
        makeToolMessage({
          relation: "unrelated",
          confidence: 0.78,
          explanation: "no link",
        }),
      );

    const detected = await contradictionModule.detectContradictions(
      db,
      { content: "new", type: "fact", subject: "s", importance: 7 },
      zeroEmbedding(),
      subjectIndex,
      makeLlmClient(),
    );

    expect(detected).toEqual([]);
  });

  it("auto-supersedes fact with high confidence supersession", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact", subjectKey: "alex/weight" });
    await seedEntry(client, "existing-entry", { type: "fact", importance: 7, subjectKey: "alex/weight" });
    const subjectIndex = new SubjectIndex();
    subjectIndex.add("alex/weight", "existing-entry");

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({ existingType: "fact", relation: "supersedes", confidence: 0.91 }),
      subjectIndex,
    );

    expect(resolution.action).toBe("auto-superseded");

    const superseded = await client.execute({
      sql: "SELECT superseded_by FROM entries WHERE id = ?",
      args: ["existing-entry"],
    });
    expect(String(superseded.rows[0]?.superseded_by)).toBe("new-entry");
    expect(subjectIndex.lookup("alex/weight")).toEqual([]);
  });

  it("auto-supersedes preference with high confidence supersession", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "preference", subjectKey: "alex/editor" });
    await seedEntry(client, "existing-entry", { type: "preference", importance: 6, subjectKey: "alex/editor" });
    const subjectIndex = new SubjectIndex();
    subjectIndex.add("alex/editor", "existing-entry");

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "preference", importance: 6 },
      buildConflict({ existingType: "preference", relation: "supersedes", confidence: 0.92, existingImportance: 6 }),
      subjectIndex,
    );

    expect(resolution.action).toBe("auto-superseded");
  });

  it("does not auto-supersede when confidence is less than or equal to 0.85", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact", subjectKey: "alex/weight" });
    await seedEntry(client, "existing-entry", { type: "fact", importance: 7, subjectKey: "alex/weight" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({ existingType: "fact", relation: "supersedes", confidence: 0.85 }),
      new SubjectIndex(),
    );

    expect(resolution).toEqual({ action: "coexist", reason: "entries can coexist" });
  });

  it("flags supersedes with confidence 0.9 and lower new importance for review", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact", importance: 6, subjectKey: "alex/weight" });
    await seedEntry(client, "existing-entry", { type: "fact", importance: 9, subjectKey: "alex/weight" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 6 },
      buildConflict({ existingType: "fact", relation: "supersedes", confidence: 0.9, existingImportance: 9 }),
      new SubjectIndex(),
    );

    expect(resolution.action).toBe("flagged");
  });

  it("coexists for supersedes with confidence exactly 0.85 and lower new importance", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact", importance: 5, subjectKey: "alex/weight" });
    await seedEntry(client, "existing-entry", { type: "fact", importance: 8, subjectKey: "alex/weight" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 5 },
      buildConflict({ existingType: "fact", relation: "supersedes", confidence: 0.85, existingImportance: 8 }),
      new SubjectIndex(),
    );

    expect(resolution.action).toBe("coexist");
  });

  it("coexists when existing type is event (immutable)", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "event" });
    await seedEntry(client, "existing-entry", { type: "event", importance: 8 });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "event", importance: 8 },
      buildConflict({ existingType: "event", relation: "contradicts", confidence: 0.9 }),
      new SubjectIndex(),
    );

    expect(resolution).toEqual({ action: "coexist", reason: "events are immutable" });
  });

  it("flags for review when relation is contradicts", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact" });
    await seedEntry(client, "existing-entry", { type: "fact" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({ existingType: "fact", relation: "contradicts", confidence: 0.95 }),
      new SubjectIndex(),
    );

    expect(resolution).toEqual({ action: "flagged", reason: "needs human review" });
  });

  it("flags for review when confidence is below 0.75", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact" });
    await seedEntry(client, "existing-entry", { type: "fact" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({ existingType: "fact", relation: "coexists", confidence: 0.74 }),
      new SubjectIndex(),
    );

    expect(resolution.action).toBe("flagged");
  });

  it("flags for review when confidence is exactly 0.75", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact" });
    await seedEntry(client, "existing-entry", { type: "fact" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({ existingType: "fact", relation: "coexists", confidence: 0.75 }),
      new SubjectIndex(),
    );

    expect(resolution.action).toBe("flagged");
  });

  it("flags for review when existing type is decision", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "decision" });
    await seedEntry(client, "existing-entry", { type: "decision" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "decision", importance: 8 },
      buildConflict({ existingType: "decision", relation: "coexists", confidence: 0.9 }),
      new SubjectIndex(),
    );

    expect(resolution.action).toBe("flagged");
  });

  it("flags for review when existing type is lesson", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "lesson" });
    await seedEntry(client, "existing-entry", { type: "lesson" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "lesson", importance: 8 },
      buildConflict({ existingType: "lesson", relation: "coexists", confidence: 0.9 }),
      new SubjectIndex(),
    );

    expect(resolution.action).toBe("flagged");
  });

  it("coexists for remaining cases", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact" });
    await seedEntry(client, "existing-entry", { type: "fact" });

    const resolution = await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({ existingType: "fact", relation: "coexists", confidence: 0.9 }),
      new SubjectIndex(),
    );

    expect(resolution).toEqual({ action: "coexist", reason: "entries can coexist" });
  });

  it("all resolution paths create a conflict_log entry", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "new-entry", { type: "fact", subjectKey: "alex/status" });
    await seedEntry(client, "existing-auto", { type: "fact", importance: 7, subjectKey: "alex/status" });
    await seedEntry(client, "existing-flagged", { type: "decision", importance: 7, subjectKey: "alex/status" });
    await seedEntry(client, "existing-coexist", { type: "fact", importance: 7, subjectKey: "alex/status" });

    const subjectIndex = new SubjectIndex();
    subjectIndex.add("alex/status", "existing-auto");

    await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({
        existingEntryId: "existing-auto",
        existingType: "fact",
        relation: "supersedes",
        confidence: 0.91,
      }),
      subjectIndex,
    );

    await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({
        existingEntryId: "existing-flagged",
        existingType: "decision",
        relation: "coexists",
        confidence: 0.9,
      }),
      subjectIndex,
    );

    await contradictionModule.resolveConflict(
      client,
      "new-entry",
      { type: "fact", importance: 7 },
      buildConflict({
        existingEntryId: "existing-coexist",
        existingType: "fact",
        relation: "coexists",
        confidence: 0.9,
      }),
      subjectIndex,
    );

    const rows = await client.execute({
      sql: "SELECT resolution FROM conflict_log ORDER BY created_at ASC",
      args: [],
    });

    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map((row) => String(row.resolution))).toEqual([
      "auto-superseded",
      "pending",
      "coexist",
    ]);
  });
});
