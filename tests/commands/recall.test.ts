import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateEntryTokens, runRecallCommand } from "../../src/commands/recall.js";
import { parseSinceToIso } from "../../src/utils/time.js";
import type { RecallResult, StoredEntry } from "../../src/types.js";

function makeEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: "entry-1",
    type: "fact",
    subject: "Jim",
    content: "Default content",
    importance: 8,
    expiry: "temporary",
    scope: "private",
    tags: ["default"],
    source: {
      file: "source.jsonl",
      context: "test",
    },
    embedding: [0.1, 0.2, 0.3],
    created_at: "2026-02-14T00:00:00.000Z",
    updated_at: "2026-02-14T00:00:00.000Z",
    recall_count: 0,
    confirmations: 0,
    contradictions: 0,
    quality_score: 0.5,
    ...overrides,
  };
}

function makeResult(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    entry: makeEntry(),
    score: 0.8,
    scores: {
      vector: 0.9,
      recency: 0.8,
      importance: 0.75,
      recall: 0.2,
      freshness: 1,
      todoPenalty: 1,
      fts: 0.15,
      spacing: 1,
      quality: 0.5,
    },
    ...overrides,
  };
}

function makeDeps(overrides?: {
  recallFn?: ReturnType<typeof vi.fn>;
  updateRecallMetadataFn?: ReturnType<typeof vi.fn>;
}) {
  return {
    readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
    getDbFn: vi.fn(() => ({}) as any),
    initDbFn: vi.fn(async () => undefined),
    closeDbFn: vi.fn(() => undefined),
    recallFn: overrides?.recallFn ?? vi.fn(async () => [makeResult()]),
    updateRecallMetadataFn: overrides?.updateRecallMetadataFn ?? vi.fn(async () => undefined),
    nowFn: () => new Date("2026-02-15T00:00:00.000Z"),
  };
}

describe("recall command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures repeated --project flags as an array", async () => {
    const { createProgram } = await import("../../src/cli-main.js");
    const program = createProgram();
    const recallCommand = program.commands.find((command) => command.name() === "recall");
    const actionMock = vi.fn(async () => undefined);
    recallCommand?.action(actionMock as any);

    await program.parseAsync(["node", "agenr", "recall", "query", "--project", "foo", "--project", "bar"]);

    expect(actionMock).toHaveBeenCalledTimes(1);
    const firstCall = (actionMock.mock.calls as unknown[][])[0] as [string, Record<string, unknown>] | undefined;
    expect(firstCall?.[1].project).toEqual(["foo", "bar"]);
  });

  it("rejects --around-radius without --around at CLI parse time", async () => {
    const { createProgram } = await import("../../src/cli-main.js");
    const program = createProgram();
    await expect(program.parseAsync(["node", "agenr", "recall", "query", "--around-radius", "7"])).rejects.toThrow(
      "--around-radius requires --around",
    );
  });

  it("rejects non-positive --around-radius values at CLI parse time", async () => {
    const { createProgram } = await import("../../src/cli-main.js");
    const program = createProgram();
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "agenr", "recall", "query", "--around", "7d", "--around-radius", "0"]),
    ).rejects.toThrow("--around-radius must be a positive integer (days)");
    await expect(
      program.parseAsync(["node", "agenr", "recall", "query", "--around", "7d", "--around-radius", "-3"]),
    ).rejects.toThrow("--around-radius must be a positive integer (days)");
  });

  it("parses duration strings into ISO cutoffs", () => {
    const now = new Date("2026-02-15T12:00:00.000Z");
    const oneHour = parseSinceToIso("1h", now);
    const sevenDays = parseSinceToIso("7d", now);
    const oneMonth = parseSinceToIso("1m", now);
    const oneYear = parseSinceToIso("1y", now);

    expect(oneHour).toBe("2026-02-15T11:00:00.000Z");
    expect(sevenDays).toBe("2026-02-08T12:00:00.000Z");
    expect(oneMonth).toBe("2026-01-16T12:00:00.000Z");
    expect(oneYear).toBe("2025-02-15T12:00:00.000Z");
  });

  it("estimates token usage per entry", () => {
    const tokens = estimateEntryTokens(
      makeResult({
        entry: makeEntry({
          content: "Jim is working on recall and db commands",
          tags: ["recall", "db", "phase-3"],
        }),
      }),
    );
    expect(tokens).toBeGreaterThan(5);
  });

  it("requires either a query, session-start context, or browse mode", async () => {
    const deps = makeDeps();
    await expect(runRecallCommand(undefined, { context: "default" }, deps)).rejects.toThrow(
      "Provide a query, use --context session-start, or use --browse.",
    );
  });

  it("outputs JSON envelope and strips entry embeddings", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const deps = makeDeps();

    const result = await runRecallCommand("work", { json: true, limit: 5 }, deps);

    expect(result.payload.query).toBe("work");
    expect(result.payload.total).toBe(1);
    expect(result.payload.results[0]?.entry.embedding).toBeUndefined();

    const jsonOutput = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const parsed = JSON.parse(jsonOutput) as { query: string; results: Array<{ entry: { embedding?: number[] } }> };
    expect(parsed.query).toBe("work");
    expect(parsed.results[0]?.entry.embedding).toBeUndefined();
  });

  it("groups session-start output and includes category fields", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const freshIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recallFn = vi.fn(async (_db: unknown, query: { expiry?: string }) => {
      if (query.expiry === "core") {
        return [
          makeResult({
            entry: makeEntry({
              id: "core-1",
              content: "Core identity",
              expiry: "core",
              type: "fact",
              created_at: freshIso,
              updated_at: freshIso,
              embedding: [1, 0, 0],
            }),
          }),
        ];
      }

      return [
        makeResult({
          entry: makeEntry({
            id: "todo-1",
            type: "todo",
            expiry: "temporary",
            content: "Active todo",
            created_at: freshIso,
            updated_at: freshIso,
          }),
          score: 0.92,
        }),
        makeResult({
          entry: makeEntry({
            id: "pref-1",
            type: "preference",
            expiry: "permanent",
            content: "Pref item",
            created_at: freshIso,
            updated_at: freshIso,
          }),
          score: 0.85,
        }),
        makeResult({
          entry: makeEntry({
            id: "recent-1",
            type: "event",
            expiry: "temporary",
            content: "Recent item",
            created_at: freshIso,
            updated_at: freshIso,
          }),
          score: 0.8,
        }),
      ];
    });

    const deps = makeDeps({ recallFn });
    const output = await runRecallCommand(undefined, { context: "session-start", json: true, budget: 500 }, deps);

    expect(output.payload.results[0]?.category).toBe("core");
    expect(output.payload.results.some((row) => row.category === "active")).toBe(true);
    expect(output.payload.results.some((row) => row.category === "preferences")).toBe(true);
    expect(output.payload.results.some((row) => row.category === "recent")).toBe(true);

    const jsonOutput = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const parsed = JSON.parse(jsonOutput) as { results: Array<{ category?: string }> };
    expect(parsed.results.some((item) => item.category === "core")).toBe(true);
  });

  it("shapes topic context text as [topic: value] <query>", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });
    await runRecallCommand("what is Jim's diet", { context: "topic:health", json: true }, deps);

    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { text?: string }] | undefined;
    const firstCallQuery = firstCall?.[1];
    expect(firstCallQuery?.text).toBe("[topic: health] what is Jim's diet");
  });

  it("passes --platform into recall query when provided", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });

    await runRecallCommand("work", { context: "default", json: true, platform: "openclaw" }, deps);

    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { platform?: string }] | undefined;
    expect(firstCall?.[1]?.platform).toBe("openclaw");
  });

  it("passes --until into recall query when provided", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });

    await runRecallCommand("work", { context: "default", json: true, until: "2026-02-01T00:00:00.000Z" }, deps);

    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { until?: string }] | undefined;
    expect(firstCall?.[1]?.until).toBe("2026-02-01T00:00:00.000Z");
  });

  it("passes --around into recall query when provided", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });

    await runRecallCommand("work", { context: "default", json: true, around: "7d" }, deps);

    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { around?: string }] | undefined;
    expect(firstCall?.[1]?.around).toBe("2026-02-08T00:00:00.000Z");
  });

  it("passes --around-radius into recall query when provided", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });

    await runRecallCommand("work", { context: "default", json: true, aroundRadius: "21" }, deps);

    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { aroundRadius?: number }] | undefined;
    expect(firstCall?.[1]?.aroundRadius).toBe(21);
  });

  it("passes --project into recall query when provided", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });

    await runRecallCommand("work", { context: "default", json: true, project: "agenr,openclaw" }, deps);

    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { project?: string[] }] | undefined;
    expect(firstCall?.[1]?.project).toEqual(["agenr", "openclaw"]);
  });

  it("sets projectStrict when --strict is used with --project", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });

    await runRecallCommand("work", { context: "default", json: true, project: "agenr", strict: true }, deps);

    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { projectStrict?: boolean }] | undefined;
    expect(firstCall?.[1]?.projectStrict).toBe(true);
  });

  it("allows --browse without query text", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });
    const output = await runRecallCommand(undefined, { browse: true, json: true }, deps);
    expect(output.exitCode).toBe(0);
  });

  it("rejects --browse with --context session-start", async () => {
    const deps = makeDeps();
    await expect(runRecallCommand(undefined, { browse: true, context: "session-start" }, deps)).rejects.toThrow(
      "cannot be combined",
    );
  });

  it("does not update recall metadata in browse mode", async () => {
    const recallFn = vi.fn(async () => [makeResult()]);
    const updateRecallMetadataFn = vi.fn(async () => undefined);
    const deps = makeDeps({ recallFn, updateRecallMetadataFn });

    await runRecallCommand(undefined, { browse: true, json: true }, deps);
    expect(updateRecallMetadataFn).not.toHaveBeenCalled();
  });

  it("threads --since into browse recall queries", async () => {
    const recallFn = vi.fn(async () => []);
    const deps = makeDeps({ recallFn });

    await runRecallCommand(undefined, { browse: true, since: "1d", json: true }, deps);
    const firstCall = (recallFn.mock.calls as unknown[][])[0] as [unknown, { browse?: boolean; since?: string }] | undefined;
    expect(firstCall?.[1]?.browse).toBe(true);
    expect(firstCall?.[1]?.since).toBe("2026-02-14T00:00:00.000Z");
  });

  it("sets JSON query field to [browse] in browse mode", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const deps = makeDeps();

    await runRecallCommand(undefined, { browse: true, json: true }, deps);

    const jsonOutput = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const parsed = JSON.parse(jsonOutput) as { query: string };
    expect(parsed.query).toBe("[browse]");
  });
});
