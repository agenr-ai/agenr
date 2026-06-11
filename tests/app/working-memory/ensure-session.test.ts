import { describe, expect, it } from "vitest";

import { ensureSessionWorkingSet } from "../../../src/app/working-memory/selection.js";
import type { WorkingMemoryRepository, WorkingSetCreateResult } from "../../../src/app/working-memory/repository.js";
import type { ResolvedWorkingScope } from "../../../src/app/working-memory/scope.js";
import { createTestWorkingSet } from "./service-test-helpers.js";

describe("ensureSessionWorkingSet", () => {
  it("returns the existing set when a create conflict retry finds one active session set", async () => {
    const existing = createTestWorkingSet({
      id: "ws-existing",
      scopeKind: "session",
      scopeKey: "session:session-1",
      sessionId: "session-1",
    });
    const repository = createEnsureRepository({
      retryMatches: [existing],
    });

    const result = await ensureSessionWorkingSet(
      {
        scope: { sessionId: "session-1", conversationKey: "session-1" },
        timestamp: "2026-06-11T12:00:00.000Z",
      },
      repository,
    );

    expect(result).toMatchObject({
      ok: true,
      created: false,
      workingSet: {
        id: "ws-existing",
      },
    });
  });

  it("surfaces retry ambiguity instead of masking it as an active set conflict", async () => {
    const first = createTestWorkingSet({
      id: "ws-1",
      scopeKind: "session",
      scopeKey: "session:session-1",
      sessionId: "session-1",
    });
    const second = createTestWorkingSet({
      id: "ws-2",
      scopeKind: "session",
      scopeKey: "session:session-1",
      sessionId: "session-1",
    });
    const repository = createEnsureRepository({
      retryMatches: [first, second],
    });

    const result = await ensureSessionWorkingSet(
      {
        scope: { sessionId: "session-1", conversationKey: "session-1" },
        timestamp: "2026-06-11T12:00:00.000Z",
      },
      repository,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_scope",
      details: {
        scopeKey: "session:session-1",
        workingSetIds: ["ws-1", "ws-2"],
      },
    });
  });

  it("surfaces an unconfirmed create conflict as ambiguous instead of a benign existing set", async () => {
    const repository = createEnsureRepository({
      retryMatches: [],
    });

    const result = await ensureSessionWorkingSet(
      {
        scope: { sessionId: "session-1", conversationKey: "session-1" },
        timestamp: "2026-06-11T12:00:00.000Z",
      },
      repository,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_scope",
      message: "Session working-set create conflicted, but retry lookup did not find exactly one active set.",
      details: {
        scopeKey: "session:session-1",
        matchCount: 0,
      },
    });
  });
});

function createEnsureRepository(options: { retryMatches: Awaited<ReturnType<WorkingMemoryRepository["findCurrentWorkingSets"]>> }): WorkingMemoryRepository {
  let lookupCount = 0;
  return {
    getWorkingSet: async () => null,
    findCurrentWorkingSets: async (scope: ResolvedWorkingScope) => {
      lookupCount += 1;
      return lookupCount === 1 ? [] : options.retryMatches.map((match) => ({ ...match, scopeKey: scope.scopeKey }));
    },
    listWorkingSets: async () => [],
    listWorkingEvents: async () => [],
    createWorkingSet: async (): Promise<WorkingSetCreateResult> => ({ kind: "active_set_exists", scopeKey: "session:session-1" }),
    updateWorkingSet: async () => ({ kind: "not_found" }),
    patchWorkingSetUsage: async () => ({ kind: "not_found" }),
    patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
    recordEpisodePromotion: async () => ({ kind: "not_found" }),
    recordCandidateConsolidation: async () => ({ kind: "not_found" }),
  };
}
