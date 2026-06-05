import { describe, expect, it, vi } from "vitest";

import { runSessionStart } from "../../../src/app/session-start/index.js";
import type { SessionStartDeps } from "../../../src/app/session-start/index.js";
import type { RecallCandidateDurable } from "../../../src/core/recall/types.js";
import type { RecallPorts } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";

describe("runSessionStart", () => {
  it("returns only always-on core memory when no predecessor artifacts exist", async () => {
    const coreEntry = createEntry({
      id: "core-branching",
      subject: "branching workflow",
      content: "Branch from local master, commit on the feature branch, then fast-forward merge.",
      expiry: "core",
      importance: 10,
    });
    const deps = createDeps({
      coreEntries: [coreEntry],
    });

    const result = await runSessionStart(
      {
        sessionKey: "agent:main:webchat:test",
      },
      deps,
    );

    expect(result.contextSections).toEqual([]);
    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        entry: {
          id: "core-branching",
        },
        sourceKind: "core",
        whySurfaced: {
          summary: "always-on core memory; importance 10",
        },
      },
    ]);
    expect(result.diagnostics).toMatchObject({
      coreCandidateCount: 1,
      artifactRecallCandidateCount: 0,
      artifactRecallUsed: false,
      notices: [],
    });
    expect(deps.recall.embed).not.toHaveBeenCalled();
    expect(deps.recall.ftsSearch).not.toHaveBeenCalled();
    expect(deps.recall.recordRecallEvents).not.toHaveBeenCalled();
  });

  it("merges artifact-grounded durable recall with core memory, dedupes overlaps, and preserves rank order", async () => {
    const coreEntry = createEntry({
      id: "core-policy",
      subject: "workflow policy",
      content: "Always branch from local master before editing shared runtime code.",
      expiry: "core",
      importance: 10,
    });
    const recalledEntry = createEntry({
      id: "permanent-runtime",
      type: "lesson",
      subject: "runtime wiring lesson",
      content: "Keep the app-layer contract host-neutral and let the adapter own prompt rendering.",
      expiry: "permanent",
      importance: 8,
    });
    const deps = createDeps({
      coreEntries: [coreEntry],
      ftsCandidates: [toRecallCandidateDurable(coreEntry), toRecallCandidateDurable(recalledEntry)],
      hydratedEntries: [coreEntry, recalledEntry],
    });

    const result = await runSessionStart(
      {
        sessionKey: "agent:main:webchat:test",
        continuitySummaryText: "The workflow policy still matters when wiring session-start runtime behavior.",
        recentSessionText: "U: Keep the runtime contract host-neutral.\nA: Let the adapter own prompt rendering.",
        policy: {
          maxCoreEntries: 1,
          maxArtifactRecallEntries: 3,
          maxDurableEntries: 2,
        },
      },
      deps,
    );

    expect(result.contextSections.map((section) => section.title)).toEqual(["Previous session summary", "Recent session"]);
    expect(result.diagnostics).toMatchObject({
      coreCandidateCount: 1,
      artifactRecallCandidateCount: 2,
      artifactRecallUsed: true,
    });
    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        entry: { id: "core-policy" },
        sourceKind: "core",
      },
      {
        rank: 2,
        entry: { id: "permanent-runtime" },
        sourceKind: "artifact_recall",
      },
    ]);
    expect(result.durableMemory).toHaveLength(2);
    expect(result.durableMemory[1]?.whySurfaced.reasons).toEqual(expect.arrayContaining([expect.stringContaining("lexical overlap")]));
    expect(deps.recall.embed).toHaveBeenCalledOnce();
    expect(deps.recall.ftsSearch).toHaveBeenCalledOnce();
    expect(deps.recall.recordRecallEvents).toHaveBeenCalledOnce();
  });

  it("captures degraded recall diagnostics when semantic search is unavailable", async () => {
    const recalledEntry = createEntry({
      id: "permanent-slice",
      subject: "hybrid session-start slice",
      content: "Use artifact-grounded durable recall when predecessor continuity is available.",
      expiry: "permanent",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(recalledEntry)],
      hydratedEntries: [recalledEntry],
    });

    const result = await runSessionStart(
      {
        continuitySummaryText: "Use artifact-grounded durable recall when predecessor continuity is available.",
      },
      deps,
    );

    expect(result.diagnostics.artifactRecallUsed).toBe(true);
    expect(result.diagnostics.artifactRecallTrace?.degraded.active).toBe(true);
    expect(result.diagnostics.notices).toEqual(expect.arrayContaining(["Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking."]));
    expect(result.durableMemory).toMatchObject([
      {
        sourceKind: "artifact_recall",
        entry: {
          id: "permanent-slice",
        },
      },
    ]);
  });

  it("swallows artifact recall failures and still returns core memory", async () => {
    const coreEntry = createEntry({
      id: "core-continuity",
      subject: "continuity fallback",
      content: "Session start should still inject bounded durable memory even if recall fails.",
      expiry: "core",
      importance: 10,
    });
    const deps = createDeps({
      coreEntries: [coreEntry],
      ftsSearchImplementation: async () => {
        throw new Error("fts is unavailable");
      },
    });

    const result = await runSessionStart(
      {
        continuitySummaryText: "Continuity still matters even if recall is down.",
      },
      deps,
    );

    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        entry: {
          id: "core-continuity",
        },
        sourceKind: "core",
      },
    ]);
    expect(result.diagnostics.notices).toEqual(expect.arrayContaining(["Artifact-grounded durable recall failed: fts is unavailable"]));
  });

  it("skips artifact-grounded recall when the session-start policy disables it", async () => {
    const coreEntry = createEntry({
      id: "core-only",
      subject: "core-only workflow",
      content: "Core memory should still render when relevant durable memory is disabled.",
      expiry: "core",
      importance: 10,
    });
    const recalledEntry = createEntry({
      id: "artifact-entry",
      subject: "artifact-grounded lesson",
      content: "This entry would have surfaced through artifact-grounded recall.",
      expiry: "permanent",
      importance: 8,
    });
    const deps = createDeps({
      coreEntries: [coreEntry],
      ftsCandidates: [toRecallCandidateDurable(recalledEntry)],
      hydratedEntries: [recalledEntry],
    });

    const result = await runSessionStart(
      {
        continuitySummaryText: "Continue the previous runtime work.",
        recentSessionText: "U: hello\nA: hi",
        policy: {
          enableArtifactRecall: false,
        },
      },
      deps,
    );

    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        entry: {
          id: "core-only",
        },
        sourceKind: "core",
      },
    ]);
    expect(result.diagnostics).toMatchObject({
      artifactRecallCandidateCount: 0,
      artifactRecallUsed: false,
    });
    expect(result.diagnostics.notices).toContain("Artifact-grounded durable recall disabled by session-start policy.");
    expect(deps.recall.embed).not.toHaveBeenCalled();
    expect(deps.recall.ftsSearch).not.toHaveBeenCalled();
    expect(deps.recall.recordRecallEvents).not.toHaveBeenCalled();
  });

  it("suppresses core memory that violates an active abstain directive", async () => {
    const stanEntry = createEntry({
      id: "core-stan",
      subject: "colleague preferences",
      content: "Stan prefers async standups.",
      expiry: "core",
      importance: 9,
    });
    const allowedEntry = createEntry({
      id: "core-workflow",
      subject: "branching workflow",
      content: "Branch from local master before editing shared code.",
      expiry: "core",
      importance: 8,
    });
    const directiveRow = createEntry({
      id: "dir-stan",
      subject: "memory directive",
      content: "Do not mention Stan.",
      claim_key: "user/memory_directive/do_not_mention_stan",
    });
    const deps = createDeps({
      coreEntries: [stanEntry, allowedEntry],
      listActiveAbstainDirectives: vi.fn(async () => [directiveRow]),
    });

    const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["core-workflow"]);
    expect(result.diagnostics.directiveAbstentions).toEqual([
      { entryId: "core-stan", reason: "directive_topic", directiveId: "dir-stan", blockedTerm: "stan" },
    ]);
  });

  it("never injects a directive durable as core memory", async () => {
    const directiveCore = createEntry({
      id: "dir-core",
      subject: "memory directive",
      content: "Do not mention the acquisition.",
      claim_key: "user/memory_directive/do_not_mention_acquisition",
      expiry: "core",
      importance: 9,
    });
    const allowedEntry = createEntry({
      id: "core-workflow",
      subject: "branching workflow",
      content: "Branch from local master before editing shared code.",
      expiry: "core",
      importance: 8,
    });
    const deps = createDeps({
      coreEntries: [directiveCore, allowedEntry],
    });

    const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["core-workflow"]);
    expect(result.diagnostics.directiveAbstentions).toEqual([{ entryId: "dir-core", reason: "directive_self" }]);
  });

  it("labels a core entry current when its valid_to is still in the future", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));
    try {
      const stillValid = createEntry({
        id: "core-lease",
        subject: "current lease",
        content: "Lease runs through the summer.",
        expiry: "core",
        valid_to: "2026-09-01T00:00:00.000Z",
      });
      const alreadyExpired = createEntry({
        id: "core-stale",
        subject: "old assignment",
        content: "Temporary assignment that has ended.",
        expiry: "core",
        valid_to: "2026-02-01T00:00:00.000Z",
      });
      const deps = createDeps({ coreEntries: [stillValid, alreadyExpired] });

      const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

      const states = new Map(result.durableMemory.map((item) => [item.entry.id, item.memoryState]));
      expect(states.get("core-lease")).toBe("current");
      expect(states.get("core-stale")).toBe("historical");
    } finally {
      vi.useRealTimers();
    }
  });
});

function createDeps(
  options: {
    coreEntries?: Durable[];
    ftsCandidates?: RecallCandidateDurable[];
    hydratedEntries?: Durable[];
    ftsSearchImplementation?: RecallPorts["ftsSearch"];
    listActiveAbstainDirectives?: SessionStartDeps["listActiveAbstainDirectives"];
  } = {},
): SessionStartDeps {
  const recallEntries = new Map((options.hydratedEntries ?? []).map((entry) => [entry.id, entry]));
  const recall: RecallPorts = {
    embed: vi.fn(async () => {
      throw new Error("embeddings unavailable");
    }),
    vectorSearch: vi.fn(async () => []),
    ftsSearch:
      options.ftsSearchImplementation ??
      vi.fn(async () =>
        (options.ftsCandidates ?? []).map((entry) => ({
          entry,
          rank: -1,
          tier: "all_tokens" as const,
        })),
      ),
    hydrateEntries: vi.fn(async (ids) => ids.flatMap((id) => recallEntries.get(id) ?? [])),
    recordRecallEvents: vi.fn(async () => undefined),
  };

  return {
    repository: {
      listCoreEntries: vi.fn(async (limit) => (options.coreEntries ?? []).slice(0, limit)),
    },
    recall,
    ...(options.listActiveAbstainDirectives ? { listActiveAbstainDirectives: options.listActiveAbstainDirectives } : {}),
  };
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
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

function toRecallCandidateDurable(entry: Durable): RecallCandidateDurable {
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
