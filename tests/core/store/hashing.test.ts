import { describe, expect, it } from "vitest";

import { computeContentHash, computeNormContentHash } from "../../../src/core/store/hashing.js";

describe("computeContentHash", () => {
  it("is deterministic for the same input", () => {
    expect(computeContentHash("same content", "/tmp/source.txt")).toBe(computeContentHash("same content", "/tmp/source.txt"));
  });

  it("differs when the source file differs", () => {
    expect(computeContentHash("same content", "/tmp/a.txt")).not.toBe(computeContentHash("same content", "/tmp/b.txt"));
  });

  it("hashes only the content when no source file is provided", () => {
    expect(computeContentHash("same content")).toBe(computeContentHash("same content"));
    expect(computeContentHash("same content")).not.toBe(computeContentHash("other content"));
  });
});

describe("computeNormContentHash", () => {
  it("normalizes whitespace and casing", () => {
    expect(computeNormContentHash("Hello   WORLD")).toBe(computeNormContentHash(" hello world "));
  });

  it("strips punctuation before hashing", () => {
    expect(computeNormContentHash("Hello, world!")).toBe(computeNormContentHash("hello world"));
  });
});
