import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { runBeforeTurn } from "../../../src/app/before-turn/index.js";
import type { BeforeTurnDeps } from "../../../src/app/before-turn/index.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../src/core/procedures/hashing.js";
import { composeProcedureRecallText } from "../../../src/core/procedures/recall-text.js";
import type { ProcedureDatabasePort, RecallPorts } from "../../../src/core/ports.js";
import type { RecallCandidateEntry } from "../../../src/core/recall/types.js";
import type { Entry, Procedure } from "../../../src/core/types.js";

describe("runBeforeTurn", () => {
  it("abstains when the current turn is empty after normalization", async () => {
    const deps = createDeps();

    const result = await runBeforeTurn(
      {
        currentTurnText: "   ",
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics.abstained).toBe(true);
    expect(result.diagnostics.abstentionReasons).toContain("Current turn text was empty after normalization.");
    expect(deps.recall.embed).not.toHaveBeenCalled();
    expect(deps.procedures.procedureFtsSearch).not.toHaveBeenCalled();
  });

  it("returns a bounded durable-only patch when procedure suggestion is disabled", async () => {
    const entry = createEntry({
      id: "entry-decision",
      type: "decision",
      subject: "feature branch workflow",
      content: "Branch from local master and keep the change on a feature branch until ready to merge.",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateEntry(entry)],
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        sessionKey: "agent:main:webchat:test",
        currentTurnText: "Should I work on this directly on master or use a feature branch?",
        recentTurns: [{ role: "assistant", text: "We are changing a shared runtime slice." }],
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        entry: {
          id: "entry-decision",
        },
        sourceKind: "turn_recall",
      },
    ]);
    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics).toMatchObject({
      durableRecallUsed: true,
      durableRecallCandidateCount: 1,
      procedureRecallUsed: false,
      procedureCandidateCount: 0,
      abstained: false,
    });
  });

  it("returns durable memory plus one canonical procedure suggestion when both are strong", async () => {
    const entry = createEntry({
      id: "entry-before-turn",
      type: "lesson",
      subject: "before-turn injection pattern",
      content: "Inject a bounded patch through prependContext rather than rebuilding a large persistent prompt block.",
      importance: 8,
    });
    const procedure = createProcedure({
      procedure_key: "agenr/before-turn-slice",
      title: "Implement the before-turn memory patch",
      goal: "Add the app contract, OpenClaw hook wiring, and tests for the before-turn slice.",
      when_to_use: ["Use this when implementing the post-sessionStart proactive surfacing slice."],
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateEntry(entry)],
      hydratedEntries: [entry],
      procedureFtsMatches: [{ procedure, rank: -1 }],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "How should I implement the before-turn memory patch after session start?",
        recentTurns: [{ role: "assistant", text: "We need a bounded, inspectable patch." }],
        policy: {
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory).toHaveLength(1);
    expect(result.procedure?.procedure.procedure_key).toBe("agenr/before-turn-slice");
    expect(result.procedure?.whySurfaced.summary).toContain("canonical procedure match");
    expect(result.diagnostics).toMatchObject({
      procedureRecallUsed: true,
      procedureCandidateCount: 1,
      abstained: false,
    });
  });

  it("abstains from procedure suggestion when top candidates are ambiguous", async () => {
    const alpha = createProcedure({
      procedure_key: "alpha/procedure",
      title: "Rotate the production signing key",
      goal: "Rotate the production signing key safely.",
    });
    const beta = createProcedure({
      procedure_key: "beta/procedure",
      title: "Rotate the production signing key",
      goal: "Rotate the production signing key safely.",
    });
    const deps = createDeps({
      procedureFtsMatches: [
        { procedure: alpha, rank: -1 },
        { procedure: beta, rank: -1 },
      ],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "How do I rotate the production signing key?",
        policy: {
          enableDurableRecall: false,
        },
      },
      deps,
    );

    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics.procedureRecallUsed).toBe(true);
    expect(result.diagnostics.procedureCandidateCount).toBe(2);
    expect(result.diagnostics.abstentionReasons).toContain("No canonical procedure suggestion cleared the before-turn threshold.");
  });

  it("captures degraded lexical fallback notices when durable recall embeddings fail", async () => {
    const entry = createEntry({
      id: "entry-lexical",
      subject: "lexical fallback",
      content: "If embeddings fail, before-turn durable recall should degrade rather than abort.",
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateEntry(entry)],
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What should happen if embeddings fail during before-turn recall?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      deps,
    );

    expect(result.diagnostics.notices).toEqual(expect.arrayContaining(["Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking."]));
    expect(result.durableMemory).toHaveLength(1);
  });

  it("keeps the durable patch bounded and preserves rank order", async () => {
    const first = createEntry({
      id: "entry-1",
      subject: "first durable match",
      content: "First ranked durable result.",
      importance: 9,
    });
    const second = createEntry({
      id: "entry-2",
      subject: "second durable match",
      content: "Second ranked durable result.",
      importance: 8,
    });
    const third = createEntry({
      id: "entry-3",
      subject: "third durable match",
      content: "Third ranked durable result.",
      importance: 7,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateEntry(first), toRecallCandidateEntry(second), toRecallCandidateEntry(third)],
      hydratedEntries: [first, second, third],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Find the most relevant durable matches for this turn.",
        policy: {
          maxDurableEntries: 2,
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["entry-1", "entry-2"]);
    expect(result.durableMemory.map((item) => item.rank)).toEqual([1, 2]);
    expect(result.diagnostics.durableRecallCandidateCount).toBe(2);
  });
});

function createDeps(
  options: {
    ftsCandidates?: RecallCandidateEntry[];
    hydratedEntries?: Entry[];
    ftsSearchImplementation?: RecallPorts["ftsSearch"];
    procedureFtsMatches?: Array<{ procedure: Procedure; rank: number }>;
    procedureVectorMatches?: Array<{ procedure: Procedure; vectorSim: number }>;
    embedQuery?: BeforeTurnDeps["embedQuery"];
  } = {},
): BeforeTurnDeps & {
  procedures: ProcedureDatabasePort & {
    procedureFtsSearch: ReturnType<typeof vi.fn>;
    procedureVectorSearch: ReturnType<typeof vi.fn>;
  };
} {
  const recallEntries = new Map((options.hydratedEntries ?? []).map((entry) => [entry.id, entry]));
  const recall: RecallPorts = {
    embed: vi.fn(async () => {
      throw new Error("embeddings unavailable");
    }),
    vectorSearch: vi.fn(async () => []),
    ftsSearch:
      options.ftsSearchImplementation ??
      vi.fn(async (_params) =>
        (options.ftsCandidates ?? []).map((entry) => ({
          entry,
          rank: -1,
          tier: "all_tokens" as const,
        })),
      ),
    hydrateEntries: vi.fn(async (ids) => ids.flatMap((id) => recallEntries.get(id) ?? [])),
    recordRecallEvents: vi.fn(async () => undefined),
  };
  const procedures = createProcedureDatabase({
    procedureFtsSearch: vi.fn(async () => options.procedureFtsMatches ?? []),
    procedureVectorSearch: vi.fn(async () => options.procedureVectorMatches ?? []),
  });

  return {
    recall,
    procedures,
    ...(options.embedQuery ? { embedQuery: options.embedQuery } : {}),
  };
}

function createProcedureDatabase(
  overrides: Partial<{
    procedureFtsSearch: ReturnType<typeof vi.fn>;
    procedureVectorSearch: ReturnType<typeof vi.fn>;
  }> = {},
): ProcedureDatabasePort & {
  procedureFtsSearch: ReturnType<typeof vi.fn>;
  procedureVectorSearch: ReturnType<typeof vi.fn>;
} {
  return {
    upsertProcedure: vi.fn(),
    getProcedure: vi.fn(),
    hydrateProcedures: vi.fn(),
    findActiveProcedureByKey: vi.fn(),
    procedureFtsSearch: overrides.procedureFtsSearch ?? vi.fn(async () => []),
    procedureVectorSearch: overrides.procedureVectorSearch ?? vi.fn(async () => []),
    listProceduresWithoutEmbeddings: vi.fn(),
    updateProcedureEmbedding: vi.fn(),
    retireProcedure: vi.fn(),
    supersedeProcedure: vi.fn(),
  };
}

function createEntry(overrides: Partial<Entry> = {}): Entry {
  const now = "2026-04-14T10:00:00.000Z";
  return {
    id: overrides.id ?? "entry-1",
    type: overrides.type ?? "decision",
    subject: overrides.subject ?? "test subject",
    content: overrides.content ?? "test content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
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
    claim_key_raw: overrides.claim_key_raw,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_key_confidence: overrides.claim_key_confidence,
    claim_key_rationale: overrides.claim_key_rationale,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
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

function toRecallCandidateEntry(entry: Entry): RecallCandidateEntry {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    importance: entry.importance,
    expiry: entry.expiry,
    created_at: entry.created_at,
    embedding: entry.embedding,
    superseded_by: entry.superseded_by,
    claim_key: entry.claim_key,
    claim_key_status: entry.claim_key_status,
    claim_support_observed_at: entry.claim_support_observed_at,
    valid_from: entry.valid_from,
    valid_to: entry.valid_to,
    retired: entry.retired,
  };
}

function createProcedure(overrides: Partial<Procedure> = {}): Procedure {
  const now = overrides.created_at ?? "2026-04-01T00:00:00.000Z";
  const body = {
    procedure_key: overrides.procedure_key ?? "agenr/release",
    title: overrides.title ?? "Release agenr and publish packages",
    goal: overrides.goal ?? "Cut a release and publish packages safely.",
    when_to_use: overrides.when_to_use ?? ["Use this when you need to ship a new agenr release."],
    when_not_to_use: overrides.when_not_to_use ?? ["Do not use this for a local dry run."],
    prerequisites: overrides.prerequisites ?? ["A clean repo state is available."],
    steps: overrides.steps ?? [
      {
        id: "read-doc",
        kind: "read_reference" as const,
        instruction: "Read the release procedure reference.",
        ref: {
          kind: "manual" as const,
          label: "release docs",
        },
      },
    ],
    verification: overrides.verification ?? ["The workflow completed successfully."],
    failure_modes: overrides.failure_modes ?? ["Validation fails before publish."],
    sources: overrides.sources ?? [
      {
        kind: "manual" as const,
        label: "fixture",
      },
    ],
  };

  return {
    id: overrides.id ?? randomUUID(),
    ...body,
    recall_text: overrides.recall_text ?? composeProcedureRecallText(body),
    revision_hash: overrides.revision_hash ?? computeProcedureRevisionHash(body),
    source_hash: overrides.source_hash ?? computeProcedureSourceHash(JSON.stringify(body)),
    source_file: overrides.source_file,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    superseded_by: overrides.superseded_by,
    created_at: now,
    updated_at: overrides.updated_at ?? now,
  };
}
