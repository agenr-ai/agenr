import { describe, expect, it } from "vitest";

import { createHostWorkingSetPolicy } from "../../../src/app/working-memory/host-working-set-policy.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import type { WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { ResolvedWorkingScope } from "../../../src/app/working-memory/scope.js";
import { selectWorkingSet } from "../../../src/app/working-memory/selection.js";
import { createTestWorkingSet } from "./service-test-helpers.js";

describe("selectWorkingSet auto target", () => {
  it("falls back to the session layer when the goal layer has no active set", async () => {
    const session = createSessionWorkingSet("session-fallback");
    const visitedScopes: string[] = [];
    const repository = createSelectionRepository(async (scope) => {
      visitedScopes.push(scope.scopeKind);
      return scope.scopeKind === "session" ? [session] : [];
    });

    const result = await selectWorkingSet(
      {
        scope: {
          conversationKey: "session-fallback",
          sessionId: "session-fallback",
        },
      },
      repository,
      { policy: createHostWorkingSetPolicy() },
    );

    expect(result).toMatchObject({
      ok: true,
      workingSet: {
        id: session.id,
      },
    });
    expect(visitedScopes).toEqual(["conversation", "session"]);
  });

  it("falls back to the session layer when the goal layer cannot resolve scope", async () => {
    const session = createSessionWorkingSet("missing-goal-scope");
    const visitedScopes: string[] = [];
    const repository = createSelectionRepository(async (scope) => {
      visitedScopes.push(scope.scopeKind);
      return [session];
    });

    const result = await selectWorkingSet(
      {
        scope: {
          sessionId: "missing-goal-scope",
        },
      },
      repository,
      { policy: createHostWorkingSetPolicy() },
    );

    expect(result).toMatchObject({
      ok: true,
      workingSet: {
        id: session.id,
      },
    });
    expect(visitedScopes).toEqual(["session"]);
  });

  it("propagates goal-layer failures other than missing scope or missing active set", async () => {
    const firstGoal = createTestWorkingSet({
      id: "goal-1",
      scopeKind: "conversation",
      scopeKey: "conversation:ambiguous",
    });
    const secondGoal = createTestWorkingSet({
      id: "goal-2",
      scopeKind: "conversation",
      scopeKey: "conversation:ambiguous",
    });
    const visitedScopes: string[] = [];
    const repository = createSelectionRepository(async (scope) => {
      visitedScopes.push(scope.scopeKind);
      return scope.scopeKind === "conversation" ? [firstGoal, secondGoal] : [createSessionWorkingSet("ambiguous")];
    });

    const result = await selectWorkingSet(
      {
        scope: {
          conversationKey: "ambiguous",
          sessionId: "ambiguous",
        },
      },
      repository,
      { policy: createHostWorkingSetPolicy() },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_scope",
    });
    expect(visitedScopes).toEqual(["conversation"]);
  });
});

function createSelectionRepository(findCurrentWorkingSets: (scope: ResolvedWorkingScope) => Promise<WorkingSetRecord[]>): WorkingMemoryRepository {
  return {
    getWorkingSet: async () => null,
    findCurrentWorkingSets,
    listWorkingSets: async () => [],
    listWorkingEvents: async () => [],
    createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
    updateWorkingSet: async () => ({ kind: "not_found" }),
    patchWorkingSetUsage: async () => ({ kind: "not_found" }),
    patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
    recordEpisodePromotion: async () => ({ kind: "not_found" }),
  };
}

function createSessionWorkingSet(sessionId: string): WorkingSetRecord {
  return createTestWorkingSet({
    id: `session-${sessionId}`,
    scopeKind: "session",
    scopeKey: `session:${sessionId}`,
    sessionId,
  });
}
