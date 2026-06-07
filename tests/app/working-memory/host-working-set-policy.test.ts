import { describe, expect, it } from "vitest";

import { createFailure } from "../../../src/app/working-memory/results.js";
import {
  createHostWorkingSetPolicy,
  goalBundleSectionFromSelection,
  goalsEnabled,
  layersForAutoSelect,
  layersForList,
  listFilter,
  requiresExplicitGoalTarget,
  shouldResolveGoalSelection,
} from "../../../src/app/working-memory/host-working-set-policy.js";
import { createTestWorkingSet } from "./service-test-helpers.js";

describe("host-working-set-policy", () => {
  it("requires explicit goal targets only for goal layer requests", () => {
    expect(requiresExplicitGoalTarget("goal")).toBe(true);
    expect(requiresExplicitGoalTarget("session")).toBe(false);
    expect(requiresExplicitGoalTarget(undefined)).toBe(false);
    expect(requiresExplicitGoalTarget("auto")).toBe(false);
  });

  it("controls goal bundle selection from one policy mode", () => {
    expect(shouldResolveGoalSelection(createHostWorkingSetPolicy(true))).toBe(true);
    expect(shouldResolveGoalSelection(createHostWorkingSetPolicy(false))).toBe(false);
    expect(goalsEnabled(createHostWorkingSetPolicy(true))).toBe(true);
    expect(goalsEnabled(createHostWorkingSetPolicy(false))).toBe(false);
  });

  it("limits list output to session sets when goals are disabled", () => {
    expect(listFilter(createHostWorkingSetPolicy(true))).toEqual({});
    expect(listFilter(createHostWorkingSetPolicy(false))).toEqual({ scopeKinds: ["session"] });
  });

  it("orders auto-select and list layers from one policy mode", () => {
    expect(layersForAutoSelect(createHostWorkingSetPolicy(true))).toEqual(["goal", "session"]);
    expect(layersForAutoSelect(createHostWorkingSetPolicy(false))).toEqual(["session"]);
    expect(layersForList(createHostWorkingSetPolicy(true), "session")).toEqual(["session"]);
    expect(layersForList(createHostWorkingSetPolicy(true), "goal")).toEqual(["goal"]);
    expect(layersForList(createHostWorkingSetPolicy(false), "goal")).toEqual([]);
    expect(layersForList(createHostWorkingSetPolicy(true), undefined)).toEqual(["session", "goal"]);
    expect(layersForList(createHostWorkingSetPolicy(false), undefined)).toEqual(["session"]);
  });

  it("maps goal bundle selections to typed section decisions", () => {
    const policy = createHostWorkingSetPolicy(true);
    const workingSet = createTestWorkingSet({
      id: "goal-set",
      scopeKind: "conversation",
      scopeKey: "conversation:bundle",
    });

    expect(goalBundleSectionFromSelection(policy, null)).toEqual({ kind: "omit" });
    expect(goalBundleSectionFromSelection(policy, { ok: true, workingSet })).toEqual({
      kind: "include",
      workingSet,
    });
    expect(goalBundleSectionFromSelection(policy, createFailure("missing_active_set", "No current working set matched the resolved scope."))).toEqual({
      kind: "omit",
    });
    expect(goalBundleSectionFromSelection(policy, createFailure("missing_scope", "Working memory needs a task, conversation, or git scope."))).toEqual({
      kind: "omit",
    });
    expect(
      goalBundleSectionFromSelection(
        policy,
        createFailure("ambiguous_scope", "Multiple current working sets matched the resolved scope.", {
          scopeKey: "conversation:bundle",
        }),
      ),
    ).toEqual({
      kind: "warn",
      message: "Multiple current working sets matched the resolved scope.",
    });
  });
});
