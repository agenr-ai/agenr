import { describe, expect, it } from "vitest";
import { normalizeKnowledgePlatform } from "../src/platform.js";

describe("normalizeKnowledgePlatform", () => {
  it("normalizes plaud", () => {
    expect(normalizeKnowledgePlatform("plaud")).toBe("plaud");
    expect(normalizeKnowledgePlatform("PLAUD")).toBe("plaud"); // case-insensitive like other platforms
    expect(normalizeKnowledgePlatform("plaud-ai")).toBe(null); // no variant alias
  });
});
