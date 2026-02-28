import { beforeEach, describe, expect, it } from "vitest";
import {
  buildQuery,
  classifyMessage,
  clearMidSessionState,
  clearMidSessionStates,
  formatMidSessionRecall,
  getMidSessionState,
  markStoreCall,
  shouldRecall,
} from "./mid-session-recall.js";

describe("classifyMessage", () => {
  it.each([
    { input: "yes", expected: "trivial" },
    { input: "ok", expected: "trivial" },
    { input: "Okay.", expected: "trivial" },
    { input: "thanks!", expected: "trivial" },
    { input: "sure.", expected: "trivial" },
    { input: "do it", expected: "trivial" },
    { input: "what do you think?", expected: "normal" },
    { input: "How's Duke doing?", expected: "complex" },
    { input: "Can you check PR #312?", expected: "complex" },
    { input: "yeah put it in the web ui", expected: "normal" },
    { input: "What did we decide about the extraction pipeline?", expected: "complex" },
    { input: "fix the bug", expected: "trivial" },
    { input: "Jim mentioned something about the Tesla last week", expected: "complex" },
    { input: "send Kevin a message", expected: "complex" },
    { input: "lgtm ship it", expected: "trivial" },
    { input: "How does consolidate handle crashes?", expected: "normal" },
    { input: "1", expected: "trivial" },
    {
      input: "can you remind me what agenr-ai/agenr's default branch is?",
      expected: "complex",
    },
    { input: "nice", expected: "trivial" },
    { input: "Tell me about Ava", expected: "complex" },
  ])("$input -> $expected", ({ input, expected }) => {
    expect(classifyMessage(input)).toBe(expected);
  });
});

describe("buildQuery", () => {
  it("returns a single meaningful message as-is", () => {
    expect(buildQuery(["Need extraction pipeline context"])).toBe("Need extraction pipeline context");
  });

  it("filters out stopword-only messages", () => {
    expect(buildQuery(["yes", "do it", "thanks", "no thanks"])).toBe("");
  });

  it("keeps the last two messages in full and compresses older messages", () => {
    const first = "Working on extraction pipeline reliability improvements";
    const second = "Investigated agenr-ai/agenr state handling";
    const third = "Need to fix PR #312 merge conflict handling";
    const fourth = "Tell me about Kevin's notes on consolidation";

    const query = buildQuery([first, second, third, fourth]);
    expect(query).toContain(third);
    expect(query).toContain(fourth);
    expect(query).toContain("Working");
    expect(query).toContain("Investigated");
    expect(query).not.toContain(second);
  });

  it("returns empty string for empty input", () => {
    expect(buildQuery([])).toBe("");
  });
});

describe("shouldRecall", () => {
  it("returns false for single-token queries", () => {
    expect(shouldRecall("one", null, 0.85)).toBe(false);
  });

  it("returns false when Jaccard similarity exceeds threshold", () => {
    const query = "tell me about ava and recall status";
    const lastQuery = "tell me about ava recall status";
    expect(shouldRecall(query, lastQuery, 0.7)).toBe(false);
  });

  it("returns true when queries are different enough", () => {
    const query = "analyze consolidation cluster verification rules";
    const lastQuery = "tell me about ava recall status";
    expect(shouldRecall(query, lastQuery, 0.85)).toBe(true);
  });

  it("returns true when lastQuery is null", () => {
    expect(shouldRecall("analyze consolidation cluster verification", null, 0.85)).toBe(true);
  });

  it("returns true for two-token entity queries", () => {
    expect(shouldRecall("check Tesla", null, 0.85)).toBe(true);
  });
});

describe("mid-session state", () => {
  beforeEach(() => {
    clearMidSessionStates();
  });

  it("creates a new state on first call", () => {
    const state = getMidSessionState("session-a");
    expect(state.turnCount).toBe(0);
    expect(state.lastRecallQuery).toBeNull();
    expect(state.recentMessages.toArray()).toEqual([]);
    expect(state.recalledIds.size).toBe(0);
    expect(state.lastStoreTurn).toBe(0);
    expect(state.nudgeCount).toBe(0);
  });

  it("returns the same state object for the same key", () => {
    const stateA = getMidSessionState("session-a");
    stateA.turnCount = 3;
    const stateB = getMidSessionState("session-a");
    expect(stateB).toBe(stateA);
    expect(stateB.turnCount).toBe(3);
  });

  it("clears all state entries", () => {
    const stateA = getMidSessionState("session-a");
    const stateB = getMidSessionState("session-b");
    stateA.turnCount = 1;
    stateB.turnCount = 2;

    clearMidSessionStates();

    const stateANext = getMidSessionState("session-a");
    const stateBNext = getMidSessionState("session-b");
    expect(stateANext).not.toBe(stateA);
    expect(stateBNext).not.toBe(stateB);
    expect(stateANext.turnCount).toBe(0);
    expect(stateBNext.turnCount).toBe(0);
  });

  it("clears only the targeted state entry", () => {
    const stateA = getMidSessionState("session-a");
    const stateB = getMidSessionState("session-b");
    stateA.turnCount = 4;
    stateB.turnCount = 2;

    clearMidSessionState("session-a");

    const stateANext = getMidSessionState("session-a");
    const stateBNext = getMidSessionState("session-b");
    expect(stateANext).not.toBe(stateA);
    expect(stateANext.turnCount).toBe(0);
    expect(stateBNext).toBe(stateB);
    expect(stateBNext.turnCount).toBe(2);
  });

  it("caps window buffer at five messages", () => {
    const state = getMidSessionState("session-window");
    for (let index = 1; index <= 7; index += 1) {
      state.recentMessages.push(`message-${index}`);
    }
    expect(state.recentMessages.length).toBe(5);
    const values = state.recentMessages.toArray();
    expect(values[0]).toBe("message-3");
    expect(values[4]).toBe("message-7");
  });

  it("truncates buffered messages to 200 chars", () => {
    const state = getMidSessionState("session-truncate");
    state.recentMessages.push("x".repeat(240));
    expect(state.recentMessages.length).toBe(1);
    expect(state.recentMessages.slice(0, 1)[0]).toHaveLength(200);
  });

  it("markStoreCall updates lastStoreTurn to current turnCount", () => {
    const state = getMidSessionState("session-store");
    state.turnCount = 6;

    markStoreCall("session-store");

    expect(state.lastStoreTurn).toBe(6);
  });

  it("markStoreCall with empty key is a no-op", () => {
    expect(() => markStoreCall("")).not.toThrow();
  });

  it("markStoreCall with a new key creates state and sets lastStoreTurn to zero", () => {
    markStoreCall("session-new");

    const state = getMidSessionState("session-new");
    expect(state.turnCount).toBe(0);
    expect(state.lastStoreTurn).toBe(0);
  });
});

describe("formatMidSessionRecall", () => {
  it("returns undefined for empty input", () => {
    expect(formatMidSessionRecall([])).toBeUndefined();
  });

  it("formats recalled rows under a recalled context heading", () => {
    const markdown = formatMidSessionRecall([
      {
        entry: {
          subject: "Ava",
          content: "Maintains the release checklist.",
        },
      },
    ]);
    expect(markdown).toContain("## Recalled context");
    expect(markdown).toContain("- [Ava] Maintains the release checklist.");
  });
});
