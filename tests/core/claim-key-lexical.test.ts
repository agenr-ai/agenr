import { describe, expect, it } from "vitest";

import {
  computeClaimKeyTokenOverlap,
  readClaimKeyAttributeHead,
  tokenizeClaimKeyAttributeTokens,
  tokenizeClaimKeyTextTokens,
} from "../../src/core/claim-key-lexical.js";

describe("claim-key lexical helpers", () => {
  it("tokenizes attribute segments and ignores short or stopword tokens", () => {
    expect([...tokenizeClaimKeyAttributeTokens("quality_score_default")]).toEqual(["quality", "score", "default"]);
    expect([...tokenizeClaimKeyAttributeTokens("to_for_with")]).toEqual([]);
  });

  it("tokenizes free-form text with shared stopwords", () => {
    expect([...tokenizeClaimKeyTextTokens("Agenr quality score for the project")]).toEqual(["agenr", "quality", "score", "project"]);
  });

  it("computes min-size overlap coefficient", () => {
    const left = new Set(["quality", "score", "default"]);
    const right = new Set(["quality", "score", "heuristic"]);

    expect(computeClaimKeyTokenOverlap(left, right)).toEqual({
      commonCount: 2,
      coefficient: 2 / 3,
    });
  });

  it("reads the trailing stable attribute head", () => {
    expect(readClaimKeyAttributeHead("quality_score_default")).toBe("default");
    expect(readClaimKeyAttributeHead("to_for")).toBe("to_for");
  });
});
