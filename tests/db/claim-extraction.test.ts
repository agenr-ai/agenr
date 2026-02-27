import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../src/db/client.js";
import type { LlmClient } from "../../src/types.js";

vi.mock("../../src/llm/stream.js", () => ({
  runSimpleStream: vi.fn(),
}));

import { runSimpleStream } from "../../src/llm/stream.js";
import { extractClaim, extractClaimsBatch, getDistinctEntities } from "../../src/db/claim-extraction.js";

function makeClient(): LlmClient {
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
        name: "extract_claim",
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

describe("claim extraction", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDbClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("extracts claim from a simple fact entry", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "alex",
        subject_attribute: "weight",
        predicate: "weighs",
        object: "180 lbs",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("Alex weighs 180 lbs", "fact", "Alex weight", makeClient());

    expect(claim).toEqual({
      subjectEntity: "alex",
      subjectAttribute: "weight",
      subjectKey: "alex/weight",
      predicate: "weighs",
      object: "180 lbs",
      confidence: 0.9,
    });
  });

  it("extracts claim from a preference entry", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "Alex",
        subject_attribute: "package_manager",
        predicate: "prefers",
        object: "pnpm",
        confidence: 0.92,
      }),
    );

    const claim = await extractClaim("Alex prefers pnpm", "preference", "Alex package manager", makeClient());

    expect(claim?.subjectEntity).toBe("alex");
    expect(claim?.subjectAttribute).toBe("package_manager");
    expect(claim?.subjectKey).toBe("alex/package_manager");
  });

  it("extracts primary claim when entry includes extra context", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "alex",
        subject_attribute: "employer",
        predicate: "works_at",
        object: "acme corp",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim(
      "Alex works at Acme Corp as lead engineer",
      "fact",
      "Alex employer",
      makeClient(),
    );

    expect(claim).toEqual({
      subjectEntity: "alex",
      subjectAttribute: "employer",
      subjectKey: "alex/employer",
      predicate: "works_at",
      object: "acme corp",
      confidence: 0.9,
    });
  });

  it("returns null for complex entry when no_claim is true", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: true,
      }),
    );

    const claim = await extractClaim(
      "Long meeting summary with many unrelated topics.",
      "event",
      "Q3 planning",
      makeClient(),
    );

    expect(claim).toBeNull();
  });

  it("returns null on llm error", async () => {
    vi.mocked(runSimpleStream).mockRejectedValueOnce(new Error("upstream failure"));

    await expect(extractClaim("Alex weighs 180 lbs", "fact", "Alex weight", makeClient())).resolves.toBeNull();
  });

  it("returns null on missing required fields", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "alex",
        predicate: "weighs",
        object: "180 lbs",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("Alex weighs 180 lbs", "fact", "Alex weight", makeClient());
    expect(claim).toBeNull();
  });

  it("composes subjectKey with lowercase normalization", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "Alex",
        subject_attribute: "Weight",
        predicate: "weighs",
        object: "180 lbs",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("Alex weighs 180 lbs", "fact", "Alex weight", makeClient());
    expect(claim?.subjectKey).toBe("alex/weight");
  });

  it("resolves entity alias the_user to user", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "the_user",
        subject_attribute: "weight",
        predicate: "weighs",
        object: "180 lbs",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("I weigh 180 lbs", "fact", "weight", makeClient());
    expect(claim?.subjectEntity).toBe("user");
  });

  it("uses single known entity hint when extracted entity is generic user", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: false,
        subject_entity: "user",
        subject_attribute: "employer",
        predicate: "works_at",
        object: "dataflow",
        confidence: 0.9,
      }),
    );

    const claim = await extractClaim("Works at DataFlow", "fact", "employer", makeClient(), {
      entityHints: ["alex"],
    });
    expect(claim?.subjectEntity).toBe("alex");
  });

  it("appends entity hints to claim extraction system prompt when provided", async () => {
    vi.mocked(runSimpleStream).mockResolvedValueOnce(
      makeToolMessage({
        no_claim: true,
      }),
    );

    await extractClaim("Alex weighs 180 lbs", "fact", "Alex weight", makeClient(), {
      entityHints: ["alex", "dataflow"],
    });

    const call = vi.mocked(runSimpleStream).mock.calls[0]?.[0];
    expect(call?.context.systemPrompt).toContain("Known entities in the knowledge base: alex, dataflow");
    expect(call?.context.systemPrompt).toContain("Use one of these entities if the entry is about any of them.");
  });

  it("extractClaimsBatch processes multiple entries sequentially", async () => {
    vi.mocked(runSimpleStream)
      .mockResolvedValueOnce(
        makeToolMessage({
          no_claim: false,
          subject_entity: "alex",
          subject_attribute: "weight",
          predicate: "weighs",
          object: "180 lbs",
          confidence: 0.9,
        }),
      )
      .mockResolvedValueOnce(makeToolMessage({ no_claim: true }))
      .mockResolvedValueOnce(
        makeToolMessage({
          no_claim: false,
          subject_entity: "agenr",
          subject_attribute: "storage_backend",
          predicate: "uses",
          object: "libsql",
          confidence: 0.88,
        }),
      );

    const results = await extractClaimsBatch(
      [
        { content: "Alex weighs 180 lbs", type: "fact", subject: "Alex weight" },
        { content: "Long meeting summary", type: "event", subject: "meeting" },
        { content: "agenr uses libsql", type: "fact", subject: "agenr storage" },
      ],
      makeClient(),
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.subjectKey).toBe("alex/weight");
    expect(results[1]).toBeNull();
    expect(results[2]?.subjectKey).toBe("agenr/storage_backend");
    expect(runSimpleStream).toHaveBeenCalledTimes(3);
  });

  it("handles empty content gracefully", async () => {
    const claim = await extractClaim("   ", "fact", "empty", makeClient());
    expect(claim).toBeNull();
    expect(runSimpleStream).not.toHaveBeenCalled();
  });

  it("getDistinctEntities returns unique normalized active entities", async () => {
    const client = makeDbClient();
    await initDb(client);

    const now = "2026-02-27T00:00:00.000Z";
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at,
          subject_entity, retired, superseded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "entry-1",
        "fact",
        "subject-1",
        "content-1",
        7,
        "permanent",
        "private",
        "claim-extraction.test.ts",
        "unit-test",
        now,
        now,
        "Alex",
        0,
        null,
      ],
    });
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at,
          subject_entity, retired, superseded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "entry-2",
        "fact",
        "subject-2",
        "content-2",
        7,
        "permanent",
        "private",
        "claim-extraction.test.ts",
        "unit-test",
        now,
        now,
        "alex",
        0,
        null,
      ],
    });
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at,
          subject_entity, retired, superseded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "entry-3",
        "fact",
        "subject-3",
        "content-3",
        7,
        "permanent",
        "private",
        "claim-extraction.test.ts",
        "unit-test",
        now,
        now,
        "user",
        1,
        null,
      ],
    });
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at,
          subject_entity, retired, superseded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "entry-4",
        "fact",
        "subject-4",
        "content-4",
        7,
        "permanent",
        "private",
        "claim-extraction.test.ts",
        "unit-test",
        now,
        now,
        "sarah",
        0,
        "entry-1",
      ],
    });

    const entities = await getDistinctEntities(client);
    expect(entities).toEqual(["alex"]);
  });
});
