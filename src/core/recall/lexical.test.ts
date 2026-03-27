import { describe, expect, it } from "vitest";

import { STOP_WORDS, buildFtsQueries, computeLexicalScore, tokenize } from "./lexical.js";

describe("STOP_WORDS", () => {
  it("includes common operators that should not survive tokenization", () => {
    expect(STOP_WORDS.has("or")).toBe(true);
    expect(STOP_WORDS.has("not")).toBe(true);
  });
});

describe("tokenize", () => {
  it("returns lowercase tokens for basic text", () => {
    expect(tokenize("Alpha beta_2 GAMMA.delta")).toEqual(["alpha", "beta_2", "gamma.delta"]);
  });

  it("strips stop words", () => {
    expect(tokenize("the latest decision about architecture")).toEqual(["latest", "decision", "architecture"]);
  });

  it("removes single-character tokens", () => {
    expect(tokenize("a b cd e")).toEqual(["cd"]);
  });

  it("strips special characters outside the allowed token set", () => {
    expect(tokenize('subject:"alpha!" / beta* + gamma?')).toEqual(["subject", "alpha", "beta", "gamma"]);
  });

  it("returns an empty array for empty strings", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("buildFtsQueries", () => {
  it("returns the three expected tiers for a normal multi-token query", () => {
    expect(buildFtsQueries("latest handoff summary")).toEqual(['"latest handoff summary"', "latest handoff summary", "latest OR handoff OR summary"]);
  });

  it("returns exact and single-token tiers for a single-token query", () => {
    expect(buildFtsQueries("handoff")).toEqual(['"handoff"', "handoff"]);
  });

  it("returns only the exact phrase when tokenization removes everything", () => {
    expect(buildFtsQueries("the and of")).toEqual(['"the and of"']);
  });

  it("returns an empty array for empty input", () => {
    expect(buildFtsQueries("   ")).toEqual([]);
  });

  it("sanitizes FTS special syntax in token tiers", () => {
    expect(buildFtsQueries('subject:"alpha" OR beta*')).toEqual(['"subject:""alpha"" OR beta*"', "subject alpha beta", "subject OR alpha OR beta"]);
  });
});

describe("computeLexicalScore", () => {
  it("gives exact subject matches a high score", () => {
    expect(computeLexicalScore("Latest session handoff", "latest session handoff", "Other context")).toBe(1);
  });

  it("gives proportional credit for partial token overlap", () => {
    expect(computeLexicalScore("alpha beta gamma", "alpha notes", "other beta context")).toBeCloseTo(2 / 3, 6);
  });

  it("adds bonus for matching query phrases", () => {
    const baseline = computeLexicalScore("alpha beta gamma", "alpha gamma", "misc");
    const withPhrase = computeLexicalScore("alpha beta gamma", "alpha beta gamma", "misc");

    expect(withPhrase).toBeGreaterThan(baseline);
    expect(withPhrase).toBe(1);
  });

  it("returns zero when there is no overlap", () => {
    expect(computeLexicalScore("alpha beta", "delta", "epsilon")).toBe(0);
  });

  it("caps the score at 1.0", () => {
    expect(computeLexicalScore("alpha beta gamma delta", "alpha beta gamma delta", "alpha beta gamma delta")).toBe(1);
  });
});
