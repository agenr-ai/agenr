import { describe, expect, it } from "vitest";
import { classifyMessage, countEntities } from "../../src/openclaw-plugin/mid-session-recall.js";

describe("classifyMessage", () => {
  it("classifies 'You there?' as trivial", () => {
    expect(classifyMessage("You there?")).toBe("trivial");
  });

  it("classifies 'She left' as trivial", () => {
    expect(classifyMessage("She left")).toBe("trivial");
  });

  it("classifies 'They agreed' as trivial", () => {
    expect(classifyMessage("They agreed")).toBe("trivial");
  });

  it("classifies single-word 'You' as trivial", () => {
    expect(classifyMessage("You")).toBe("trivial");
  });

  it("classifies short no-entity questions as trivial", () => {
    expect(classifyMessage("Really?")).toBe("trivial");
    expect(classifyMessage("You sure?")).toBe("trivial");
    expect(classifyMessage("Right?")).toBe("trivial");
  });

  it("keeps real entity questions as recall", () => {
    expect(classifyMessage("What happened with PR #42?")).toBe("recall");
  });
});

describe("countEntities", () => {
  it("returns 0 for pronoun-only short messages", () => {
    expect(countEntities("You there?")).toBe(0);
  });

  it("counts real named entities", () => {
    expect(countEntities("Check the Codex logs")).toBe(1);
  });
});
