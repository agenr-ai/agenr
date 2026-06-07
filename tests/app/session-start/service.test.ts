import { describe, expect, it, vi } from "vitest";

import { runSessionStart } from "../../../src/app/session-start/index.js";
import type { SessionStartDeps } from "../../../src/app/session-start/index.js";
import type { SessionMemoryRepository } from "../../../src/app/session-memory/repository.js";
import { createStubSessionMemoryRepository } from "../../helpers/host-memory-stubs.js";
import type { RecallCandidateDurable } from "../../../src/core/recall/types.js";
import type { RecallPorts } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";
import { finalizeTestDurable } from "../../helpers/durable-fixtures.js";

describe("runSessionStart", () => {
  it("returns only always-on core memory at session start", async () => {
    const coreEntry = createEntry({
      id: "core-branching",
      subject: "branching workflow",
      content: "Branch from local master, commit on the feature branch, then fast-forward merge.",
      expiry: "core",
      importance: 10,
    });
    const deps = createDeps({
      coreDurables: [coreEntry],
    });

    const result = await runSessionStart(
      {
        sessionKey: "agent:main:webchat:test",
      },
      deps,
    );

    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        durable: {
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

  it("uses active profile snapshot entries before core memory", async () => {
    const profileEntry = createEntry({
      id: "profile-runtime",
      subject: "runtime boundary",
      content: "Keep runtime orchestration in app services.",
      expiry: "permanent",
      importance: 9,
    });
    const coreEntry = createEntry({
      id: "core-policy",
      subject: "branching workflow",
      content: "Branch from local master before editing shared code.",
      expiry: "core",
      importance: 10,
    });
    const deps = createDeps({
      profileSnapshot: {
        id: "profile-1",
        durableIds: ["profile-runtime"],
        directiveIds: [],
        asOf: "2026-04-14T10:00:00.000Z",
        runId: "run-1",
        createdAt: "2026-04-14T10:00:00.000Z",
      },
      entriesById: [profileEntry],
      coreDurables: [coreEntry],
    });

    const result = await runSessionStart(
      {
        policy: {
          maxDurables: 3,
        },
      },
      deps,
    );

    expect(result.diagnostics.activeProfileSnapshotId).toBe("profile-1");
    expect(result.durableMemory.map((item) => [item.sourceKind, item.durable.id])).toEqual([
      ["profile", "profile-runtime"],
      ["core", "core-policy"],
    ]);
  });

  it("runs artifact-grounded recall from predecessor session-memory artifacts", async () => {
    const recalledEntry = createEntry({
      id: "artifact-memory",
      subject: "adapter boundary",
      content: "Adapters translate host details into app calls.",
      expiry: "permanent",
      importance: 8,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(recalledEntry)],
      hydratedDurables: [recalledEntry],
      sessionMemoryRepository: createStubSessionMemoryRepository({
        getLatestLineageEdgeForChild: vi.fn(async () => ({
          id: "edge-1",
          childSessionKey: "child-session",
          parentSessionKey: "parent-session",
          reason: "resume" as const,
          observedAt: "2026-05-30T00:00:00.000Z",
        })),
        listSessionArtifacts: vi.fn(async () => [
          {
            id: "summary-1",
            kind: "compaction_checkpoint" as const,
            sessionKey: "parent-session",
            source: "openclaw",
            sourceId: "compact-1",
            contentHash: "hash-1",
            summary: "Previous work focused on adapter boundaries.",
            createdAt: "2026-05-30T00:00:00.000Z",
          },
        ]),
      }),
    });

    const result = await runSessionStart(
      {
        sessionKey: "child-session",
        policy: {
          enableArtifactRecall: true,
          maxDurables: 2,
        },
      },
      deps,
    );

    expect(result.diagnostics).toMatchObject({
      artifactRecallUsed: true,
      artifactRecallCandidateCount: 1,
      artifactRecallQuery: "Compaction checkpoint: Previous work focused on adapter boundaries.",
    });
    expect(result.durableMemory).toMatchObject([
      {
        sourceKind: "artifact_recall",
        durable: { id: "artifact-memory" },
      },
    ]);
    expect(deps.recall.ftsSearch).toHaveBeenCalledOnce();
  });

  it("reserves a session-start slot for unique artifact-grounded recall", async () => {
    const profileEntry = createEntry({
      id: "profile-current",
      subject: "profile current work",
      content: "Current work is focused on host lifecycle memory.",
      importance: 9,
    });
    const coreDurables = Array.from({ length: 4 }, (_, index) =>
      createEntry({
        id: `core-${index + 1}`,
        subject: `core workflow ${index + 1}`,
        content: `Core memory ${index + 1}.`,
        expiry: "core",
        importance: 8 - index,
      }),
    );
    const recalledEntry = createEntry({
      id: "artifact-memory",
      subject: "previous compaction lesson",
      content: "The previous session compacted the lifecycle contract discussion.",
      importance: 8,
    });
    const deps = createDeps({
      profileSnapshot: {
        id: "profile-1",
        durableIds: ["profile-current"],
        directiveIds: [],
        asOf: "2026-04-14T10:00:00.000Z",
        runId: "run-1",
        createdAt: "2026-04-14T10:00:00.000Z",
      },
      entriesById: [profileEntry],
      coreDurables,
      ftsCandidates: [toRecallCandidateDurable(recalledEntry)],
      hydratedDurables: [recalledEntry],
      sessionMemoryRepository: createStubSessionMemoryRepository({
        getLatestLineageEdgeForChild: vi.fn(async () => ({
          id: "edge-1",
          childSessionKey: "child-session",
          parentSessionKey: "parent-session",
          reason: "resume" as const,
          observedAt: "2026-05-30T00:00:00.000Z",
        })),
        listSessionArtifacts: vi.fn(async () => [
          {
            id: "compact-1",
            kind: "compaction_checkpoint" as const,
            sessionKey: "parent-session",
            source: "openclaw",
            sourceId: "compact-1",
            contentHash: "hash-1",
            summary: "Previous work focused on lifecycle ordering.",
            createdAt: "2026-05-30T00:00:00.000Z",
          },
        ]),
      }),
    });

    const result = await runSessionStart(
      {
        sessionKey: "child-session",
        policy: {
          maxCoreDurables: 4,
          maxDurables: 5,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => [item.sourceKind, item.durable.id])).toEqual([
      ["profile", "profile-current"],
      ["core", "core-1"],
      ["core", "core-2"],
      ["core", "core-3"],
      ["artifact_recall", "artifact-memory"],
    ]);
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
      coreDurables: [coreEntry],
      ftsCandidates: [toRecallCandidateDurable(recalledEntry)],
      hydratedDurables: [recalledEntry],
    });

    const result = await runSessionStart(
      {
        policy: {
          enableArtifactRecall: false,
        },
      },
      deps,
    );

    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        durable: {
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
      coreDurables: [stanEntry, allowedEntry],
      listActiveAbstainDirectives: vi.fn(async () => [directiveRow]),
    });

    const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

    expect(result.durableMemory.map((item) => item.durable.id)).toEqual(["core-workflow"]);
    expect(result.diagnostics.directiveAbstentions).toEqual([
      { durableId: "core-stan", reason: "directive_topic", directiveId: "dir-stan", blockedTerm: "stan" },
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
      coreDurables: [directiveCore, allowedEntry],
    });

    const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

    expect(result.durableMemory.map((item) => item.durable.id)).toEqual(["core-workflow"]);
    expect(result.diagnostics.directiveAbstentions).toEqual([{ durableId: "dir-core", reason: "directive_self" }]);
  });

  it("surfaces proactive directives at session start", async () => {
    const proactiveDirective = createEntry({
      id: "dir-weekly-goals",
      type: "directive",
      subject: "weekly goals directive",
      content: "Ask about weekly goals at session start.",
      claim_key: "user/memory_directive/weekly_goals",
      directive_polarity: "proactive",
      directive_trigger: "session_start",
      expiry: "core",
      importance: 9,
    });
    const deps = createDeps({
      listActiveProactiveDirectives: vi.fn(async () => [proactiveDirective]),
    });

    const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

    expect(result.durableMemory).toMatchObject([
      {
        sourceKind: "directive",
        durable: { id: "dir-weekly-goals" },
      },
    ]);
    expect(result.diagnostics.proactiveDirectiveCandidateCount).toBe(1);
  });

  it("applies abstain directives after proactive directive assembly", async () => {
    const proactiveDirective = createEntry({
      id: "dir-ask-stan",
      type: "directive",
      subject: "stan check-in directive",
      content: "Ask about Stan at session start.",
      claim_key: "user/memory_directive/ask_stan",
      directive_polarity: "proactive",
      directive_trigger: "session_start",
      expiry: "core",
      importance: 9,
    });
    const abstainDirective = createEntry({
      id: "dir-no-stan",
      type: "directive",
      subject: "stan abstain directive",
      content: "Do not mention Stan.",
      claim_key: "user/memory_directive/do_not_mention_stan",
      directive_polarity: "abstain",
      directive_trigger: "always",
      expiry: "core",
      importance: 10,
    });
    const deps = createDeps({
      listActiveProactiveDirectives: vi.fn(async () => [proactiveDirective]),
      listActiveAbstainDirectives: vi.fn(async () => [abstainDirective]),
    });

    const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

    expect(result.durableMemory).toEqual([]);
    expect(result.diagnostics.directiveAbstentions).toEqual([
      { durableId: "dir-ask-stan", reason: "directive_topic", directiveId: "dir-no-stan", blockedTerm: "stan" },
    ]);
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
      const deps = createDeps({ coreDurables: [stillValid, alreadyExpired] });

      const result = await runSessionStart({ policy: { enableArtifactRecall: false } }, deps);

      const states = new Map(result.durableMemory.map((item) => [item.durable.id, item.memoryState]));
      expect(states.get("core-lease")).toBe("current");
      expect(states.get("core-stale")).toBe("historical");
    } finally {
      vi.useRealTimers();
    }
  });
});

function createDeps(
  options: {
    coreDurables?: Durable[];
    ftsCandidates?: RecallCandidateDurable[];
    hydratedDurables?: Durable[];
    ftsSearchImplementation?: RecallPorts["ftsSearch"];
    listActiveAbstainDirectives?: SessionStartDeps["listActiveAbstainDirectives"];
    listActiveProactiveDirectives?: SessionStartDeps["listActiveProactiveDirectives"];
    profileSnapshot?: Awaited<ReturnType<SessionStartDeps["repository"]["getActiveProfileSnapshot"]>>;
    entriesById?: Durable[];
    sessionMemoryRepository?: SessionMemoryRepository;
  } = {},
): SessionStartDeps {
  const recallEntries = new Map((options.hydratedDurables ?? []).map((entry) => [entry.id, entry]));
  const entriesById = new Map((options.entriesById ?? []).map((entry) => [entry.id, entry]));
  const recall: RecallPorts = {
    embed: vi.fn(async () => {
      throw new Error("embeddings unavailable");
    }),
    vectorSearch: vi.fn(async () => []),
    ftsSearch:
      options.ftsSearchImplementation ??
      vi.fn(async () =>
        (options.ftsCandidates ?? []).map((durable) => ({
          durable,
          rank: -1,
          tier: "all_tokens" as const,
        })),
      ),
    hydrateDurables: vi.fn(async (ids: string[]) => ids.flatMap((id) => recallEntries.get(id) ?? [])),
    recordRecallEvents: vi.fn(async () => undefined),
  };

  return {
    repository: {
      listCoreDurables: vi.fn(async (limit) => (options.coreDurables ?? []).slice(0, limit)),
      getActiveProfileSnapshot: vi.fn(async () => options.profileSnapshot ?? null),
      listDurablesByIds: vi.fn(async (ids: string[]) => ids.flatMap((id) => entriesById.get(id) ?? [])),
    },
    recall,
    ...(options.listActiveAbstainDirectives ? { listActiveAbstainDirectives: options.listActiveAbstainDirectives } : {}),
    ...(options.listActiveProactiveDirectives ? { listActiveProactiveDirectives: options.listActiveProactiveDirectives } : {}),
    ...(options.sessionMemoryRepository ? { sessionMemoryRepository: options.sessionMemoryRepository } : {}),
  };
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
  const now = "2026-04-14T10:00:00.000Z";
  return finalizeTestDurable({
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
    directive_polarity: overrides.directive_polarity,
    directive_trigger: overrides.directive_trigger,
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
    user_id: overrides.user_id,
    project: overrides.project,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  });
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
  };
}
