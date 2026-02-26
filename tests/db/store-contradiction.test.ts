import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import { storeEntries } from "../../src/db/store.js";
import { SubjectIndex } from "../../src/db/subject-index.js";
import type { KnowledgeEntry, LlmClient } from "../../src/types.js";

vi.mock("../../src/llm/stream.js", () => ({
  runSimpleStream: vi.fn(),
}));

import { runSimpleStream } from "../../src/llm/stream.js";

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function vectorForText(text: string): number[] {
  const toVector = (head: number[]): number[] => [...head, ...Array.from({ length: 1021 }, () => 0)];

  if (text.includes("vec-base")) return toVector([1, 0, 0]);
  if (text.includes("vec-89")) return toVector([0.89, Math.sqrt(1 - 0.89 ** 2), 0]);
  if (text.includes("vec-v2")) return toVector([0, 1, 0]);
  if (text.includes("vec-low")) return toVector([0.7, 0.71, 0]);
  return toVector([0.2, 0.2, 0.9]);
}

async function mockEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => vectorForText(text));
}

function makeEntry(params: {
  type?: KnowledgeEntry["type"];
  subject?: string;
  content: string;
  sourceFile?: string;
  importance?: number;
}): KnowledgeEntry {
  return {
    type: params.type ?? "fact",
    subject: params.subject ?? "Jim",
    content: params.content,
    importance: params.importance ?? 8,
    expiry: "permanent",
    tags: [],
    source: {
      file: params.sourceFile ?? "store-contradiction.test.jsonl",
      context: "unit test",
    },
  };
}

function makeLlmClient(modelId = "gpt-4.1-nano"): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId,
      model: {} as LlmClient["resolvedModel"]["model"],
    },
    credentials: {
      apiKey: "sk-test",
      source: "test",
    },
  };
}

function makeToolMessage(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tool_1",
        name,
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

type JudgeReply = {
  relation: "supersedes" | "contradicts" | "coexists" | "unrelated";
  confidence: number;
  explanation: string;
};

type StreamMockOptions = {
  failClaim?: boolean;
  failJudge?: boolean;
  judgeReply?: JudgeReply;
  judgeForPrompt?: (prompt: string) => JudgeReply;
};

function getToolNameFromCall(callArg: unknown): string | null {
  const record = callArg as {
    context?: {
      tools?: Array<{ name?: unknown }>;
    };
  };
  const firstTool = record.context?.tools?.[0];
  return typeof firstTool?.name === "string" ? firstTool.name : null;
}

function getFirstPrompt(callArg: unknown): string {
  const record = callArg as {
    context?: {
      messages?: Array<{ content?: unknown }>;
    };
  };
  const content = record.context?.messages?.[0]?.content;
  return typeof content === "string" ? content : "";
}

function getCalledTools(): string[] {
  const mocked = vi.mocked(runSimpleStream);
  return mocked.mock.calls
    .map((call) => getToolNameFromCall(call[0]))
    .filter((name): name is string => Boolean(name));
}

function configureStreamMock(options: StreamMockOptions = {}): void {
  const mocked = vi.mocked(runSimpleStream);
  mocked.mockImplementation(async (input: unknown) => {
    const toolName = getToolNameFromCall(input);
    if (toolName === "extract_claim") {
      if (options.failClaim) {
        throw new Error("claim extraction failed");
      }
      return makeToolMessage("extract_claim", {
        no_claim: false,
        subject_entity: "jim",
        subject_attribute: "weight",
        predicate: "weighs",
        object: "185 lbs",
        confidence: 0.9,
      });
    }

    if (toolName === "classify_conflict") {
      if (options.failJudge) {
        throw new Error("judge failed");
      }
      const prompt = getFirstPrompt(input);
      const reply = options.judgeForPrompt?.(prompt) ?? options.judgeReply ?? {
        relation: "coexists",
        confidence: 0.9,
        explanation: "default",
      };
      return makeToolMessage("classify_conflict", reply);
    }

    return makeToolMessage("extract_claim", { no_claim: true });
  });
}

async function getEntryIdByContent(client: Client, content: string): Promise<string> {
  const row = await client.execute({
    sql: "SELECT id FROM entries WHERE content = ? ORDER BY created_at DESC LIMIT 1",
    args: [content],
  });
  return String(row.rows[0]?.id);
}

async function getSupersededBy(client: Client, entryId: string): Promise<string | null> {
  const row = await client.execute({
    sql: "SELECT superseded_by FROM entries WHERE id = ? LIMIT 1",
    args: [entryId],
  });
  const value = row.rows[0]?.superseded_by;
  return value === null || value === undefined ? null : String(value);
}

async function setSubjectKey(client: Client, entryId: string, subjectKey: string): Promise<void> {
  await client.execute({
    sql: `
      UPDATE entries
      SET subject_key = ?, subject_entity = ?, subject_attribute = ?
      WHERE id = ?
    `,
    args: [subjectKey, "jim", "weight", entryId],
  });
}

async function seedEntry(client: Client, entry: KnowledgeEntry): Promise<string> {
  await storeEntries(client, [entry], "sk-test", {
    embedFn: mockEmbed,
    force: true,
  });
  return await getEntryIdByContent(client, entry.content);
}

describe("store contradiction pipeline integration", () => {
  const clients: Client[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    configureStreamMock();
  });

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    vi.restoreAllMocks();
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("runs contradiction detection after claim extraction on ADD", async () => {
    const client = makeClient();
    await initDb(client);

    const existingId = await seedEntry(client, makeEntry({ content: "existing vec-base", subject: "Alpha" }));
    await setSubjectKey(client, existingId, "jim/weight");

    const result = await storeEntries(client, [makeEntry({ content: "incoming vec-low", subject: "Beta" })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
    });

    expect(result.added).toBe(1);
    expect(getCalledTools()).toEqual(["extract_claim", "classify_conflict"]);

    const row = await client.execute({
      sql: `
        SELECT subject_entity, subject_attribute, subject_key, claim_predicate, claim_object, claim_confidence
        FROM entries
        WHERE content = ?
      `,
      args: ["incoming vec-low"],
    });
    expect(row.rows[0]).toMatchObject({
      subject_entity: "jim",
      subject_attribute: "weight",
      subject_key: "jim/weight",
      claim_predicate: "weighs",
      claim_object: "185 lbs",
    });
    expect(asNumber(row.rows[0]?.claim_confidence)).toBeCloseTo(0.9, 6);
  });

  it("does not run contradiction detection on SKIP, UPDATE, or SUPERSEDE mutations", async () => {
    for (const action of ["SKIP", "UPDATE", "SUPERSEDE"] as const) {
      const client = makeClient();
      await initDb(client);

      const existingId = await seedEntry(client, makeEntry({ content: `seed-${action} vec-base`, subject: "Alpha" }));
      vi.mocked(runSimpleStream).mockClear();

      const result = await storeEntries(client, [makeEntry({ content: `incoming-${action} vec-89`, subject: "Beta" })], "sk-test", {
        embedFn: mockEmbed,
        onlineDedup: true,
        llmClient: makeLlmClient(),
        onlineDedupFn: vi.fn(async () => ({
          action,
          target_id: existingId,
          merged_content: action === "UPDATE" ? `merged-${action}` : null,
          reasoning: "forced",
        })),
      });

      if (action === "SKIP") {
        expect(result.skipped).toBe(1);
      } else if (action === "UPDATE") {
        expect(result.updated).toBe(1);
      } else {
        expect(result.superseded).toBe(1);
      }

      expect(getCalledTools()).toEqual([]);
    }
  });

  it("does not run contradiction detection when contradictionEnabled is false", async () => {
    const client = makeClient();
    await initDb(client);

    const existingId = await seedEntry(client, makeEntry({ content: "existing-disable vec-base", subject: "Alpha" }));
    await setSubjectKey(client, existingId, "jim/weight");
    vi.mocked(runSimpleStream).mockClear();

    await storeEntries(client, [makeEntry({ content: "incoming-disable vec-low", subject: "Beta" })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
      contradictionEnabled: false,
    });

    const tools = getCalledTools();
    expect(tools.filter((tool) => tool === "extract_claim")).toHaveLength(1);
    expect(tools.filter((tool) => tool === "classify_conflict")).toHaveLength(0);
  });

  it("does not run contradiction detection when llmClient is not provided", async () => {
    const client = makeClient();
    await initDb(client);

    vi.mocked(runSimpleStream).mockClear();
    const result = await storeEntries(client, [makeEntry({ content: "incoming-no-llm vec-low" })], "sk-test", {
      embedFn: mockEmbed,
      force: true,
    });

    expect(result.added).toBe(1);
    expect(getCalledTools()).toEqual([]);
  });

  it("auto-supersedes existing temporal entries in the same write path", async () => {
    const client = makeClient();
    await initDb(client);

    configureStreamMock({
      judgeReply: {
        relation: "supersedes",
        confidence: 0.95,
        explanation: "new value replaces old",
      },
    });

    const existingId = await seedEntry(
      client,
      makeEntry({ content: "existing-auto vec-base", subject: "Alpha", type: "fact", importance: 6 }),
    );
    await setSubjectKey(client, existingId, "jim/weight");

    const result = await storeEntries(client, [makeEntry({ content: "incoming-auto vec-low", subject: "Beta", type: "fact", importance: 8 })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
    });

    expect(result.added).toBe(1);

    const newId = await getEntryIdByContent(client, "incoming-auto vec-low");
    expect(await getSupersededBy(client, existingId)).toBe(newId);

    const conflictRows = await client.execute({
      sql: `
        SELECT relation, resolution
        FROM conflict_log
        WHERE entry_a = ? AND entry_b = ?
      `,
      args: [newId, existingId],
    });
    expect(conflictRows.rows).toHaveLength(1);
    expect(String(conflictRows.rows[0]?.relation)).toBe("supersedes");
    expect(String(conflictRows.rows[0]?.resolution)).toBe("auto-superseded");
  });

  it("flags contradictions and writes pending conflict_log rows", async () => {
    const client = makeClient();
    await initDb(client);

    configureStreamMock({
      judgeReply: {
        relation: "contradicts",
        confidence: 0.93,
        explanation: "conflict",
      },
    });

    const existingId = await seedEntry(
      client,
      makeEntry({ content: "existing-flag vec-base", subject: "Alpha", type: "decision", importance: 8 }),
    );
    await setSubjectKey(client, existingId, "jim/weight");

    const result = await storeEntries(client, [makeEntry({ content: "incoming-flag vec-low", subject: "Beta", type: "decision", importance: 8 })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
    });

    expect(result.added).toBe(1);
    const newId = await getEntryIdByContent(client, "incoming-flag vec-low");

    const conflictRows = await client.execute({
      sql: `
        SELECT relation, resolution
        FROM conflict_log
        WHERE entry_a = ? AND entry_b = ?
      `,
      args: [newId, existingId],
    });
    expect(conflictRows.rows).toHaveLength(1);
    expect(String(conflictRows.rows[0]?.relation)).toBe("contradicts");
    expect(String(conflictRows.rows[0]?.resolution)).toBe("pending");
  });

  it("updates the provided subject index with the newly inserted entry", async () => {
    const client = makeClient();
    await initDb(client);

    const existingId = await seedEntry(client, makeEntry({ content: "existing-index vec-base", subject: "Alpha" }));
    await setSubjectKey(client, existingId, "jim/weight");
    const subjectIndex = new SubjectIndex();

    const result = await storeEntries(client, [makeEntry({ content: "incoming-index vec-low", subject: "Beta" })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
      subjectIndex,
    });

    expect(result.added).toBe(1);
    const newId = await getEntryIdByContent(client, "incoming-index vec-low");
    expect(subjectIndex.lookup("jim/weight")).toContain(newId);
  });

  it("continues to contradiction detection when claim extraction fails", async () => {
    const client = makeClient();
    await initDb(client);

    configureStreamMock({
      failClaim: true,
      judgeReply: {
        relation: "coexists",
        confidence: 0.85,
        explanation: "embedding fallback candidate",
      },
    });

    await seedEntry(client, makeEntry({ content: "existing-fallback vec-base", subject: "Alpha" }));
    vi.mocked(runSimpleStream).mockClear();

    const result = await storeEntries(client, [makeEntry({ content: "incoming-fallback vec-89", subject: "Beta" })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
    });

    expect(result.added).toBe(1);
    const tools = getCalledTools();
    expect(tools.filter((tool) => tool === "extract_claim")).toHaveLength(1);
    expect(tools.filter((tool) => tool === "classify_conflict")).toHaveLength(1);
  });

  it("stores entries even when contradiction detection judge fails", async () => {
    const client = makeClient();
    await initDb(client);

    const existingId = await seedEntry(client, makeEntry({ content: "existing-judge-fail vec-base", subject: "Alpha" }));
    await setSubjectKey(client, existingId, "jim/weight");
    configureStreamMock({ failJudge: true });

    const result = await storeEntries(client, [makeEntry({ content: "incoming-judge-fail vec-low", subject: "Beta" })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
    });

    expect(result.added).toBe(1);
    const inserted = await client.execute({
      sql: "SELECT id FROM entries WHERE content = ? LIMIT 1",
      args: ["incoming-judge-fail vec-low"],
    });
    expect(inserted.rows.length).toBe(1);

    const conflictCount = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM conflict_log",
    });
    expect(asNumber(conflictCount.rows[0]?.count)).toBe(0);
  });

  it("resolves multiple detected conflicts for a single inserted entry", async () => {
    const client = makeClient();
    await initDb(client);

    const existingOneId = await seedEntry(
      client,
      makeEntry({ content: "existing-one vec-base", subject: "Alpha", type: "fact", importance: 6 }),
    );
    await setSubjectKey(client, existingOneId, "jim/weight");

    const existingTwoId = await seedEntry(
      client,
      makeEntry({ content: "existing-two vec-v2", subject: "Alpha", type: "decision", importance: 7 }),
    );
    await setSubjectKey(client, existingTwoId, "jim/weight");

    configureStreamMock({
      judgeForPrompt: (prompt) => {
        if (prompt.includes("Content: existing-one vec-base")) {
          return {
            relation: "supersedes",
            confidence: 0.95,
            explanation: "replace one",
          };
        }
        if (prompt.includes("Content: existing-two vec-v2")) {
          return {
            relation: "contradicts",
            confidence: 0.91,
            explanation: "flag two",
          };
        }
        return {
          relation: "coexists",
          confidence: 0.8,
          explanation: "default",
        };
      },
    });

    const result = await storeEntries(client, [makeEntry({ content: "incoming-multi vec-low", subject: "Beta", type: "fact", importance: 8 })], "sk-test", {
      embedFn: mockEmbed,
      llmClient: makeLlmClient(),
    });

    expect(result.added).toBe(1);
    const newId = await getEntryIdByContent(client, "incoming-multi vec-low");

    expect(await getSupersededBy(client, existingOneId)).toBe(newId);
    expect(await getSupersededBy(client, existingTwoId)).toBeNull();

    const conflictRows = await client.execute({
      sql: `
        SELECT relation, resolution
        FROM conflict_log
        WHERE entry_a = ?
        ORDER BY created_at ASC
      `,
      args: [newId],
    });
    expect(conflictRows.rows).toHaveLength(2);
    const resolutions = conflictRows.rows.map((row) => String(row.resolution)).sort();
    expect(resolutions).toEqual(["auto-superseded", "pending"]);
  });
});
