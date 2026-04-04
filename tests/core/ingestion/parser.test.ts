import { describe, expect, it } from "vitest";

import { parseExtractionResponse } from "../../../src/core/ingestion/parser.js";

describe("parseExtractionResponse", () => {
  it("parses a valid extraction response", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "agenr knowledge database",
          content: "agenr stores durable knowledge in SQLite with a vector index for similarity search.",
          importance: "standard",
          expiry: "permanent",
          tags: ["Database", "Memory"],
          claim_key: " Agenr / Default Model ",
          source_context: "Architecture discussion",
        },
      ],
    });

    expect(result).toEqual({
      entries: [
        {
          type: "fact",
          subject: "agenr knowledge database",
          content: "agenr stores durable knowledge in SQLite with a vector index for similarity search.",
          importance: 6,
          expiry: "permanent",
          tags: ["database", "memory"],
          claim_key: "agenr/default_model",
          source_context: "Architecture discussion",
        },
      ],
      warnings: [],
    });
  });

  it("returns an empty array for an empty entries list", () => {
    expect(parseExtractionResponse({ entries: [] })).toEqual({
      entries: [],
      warnings: [],
    });
  });

  it("coerces uppercase type aliases and maps legacy event labels to milestone", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "FACT",
          subject: "jim martin dietary preference",
          content: "Jim Martin prefers low-carb meals and avoids high-sugar desserts when possible.",
          importance: "standard",
          expiry: "permanent",
        },
        {
          type: "DECISION",
          subject: "agenr package manager",
          content: "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
          importance: "standard",
          expiry: "permanent",
        },
        {
          type: "EVENT",
          subject: "auth token migration",
          content: "The auth service migrated from JWT to session tokens on 2026-02-15 and removed the old middleware.",
          importance: "low",
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries.map((entry) => entry.type)).toEqual(["fact", "decision", "milestone"]);
  });

  it("rejects removed task aliases", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "task",
          subject: "semantic dedup follow-up",
          content: "Implement semantic deduplication in the store pipeline so near-duplicate memories do not accumulate.",
          importance: "standard",
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.warnings[0]).toMatch(/invalid type/i);
  });

  it("maps importance tiers to numbers", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "high signal",
          content: "This entry represents a foundational constraint that should remain highly prioritized over time.",
          importance: "high",
          expiry: "permanent",
        },
        {
          type: "fact",
          subject: "standard signal",
          content: "This entry represents routine but durable project context worth keeping around for future sessions.",
          importance: "standard",
          expiry: "temporary",
        },
        {
          type: "fact",
          subject: "low signal",
          content: "This entry represents weaker context that may still be useful if future work revisits the same topic.",
          importance: "low",
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries.map((entry) => entry.importance)).toEqual([8, 6, 4]);
  });

  it("defaults unrecognized importance strings to 6 and preserves valid numeric values", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "fallback importance",
          content: "This entry uses an unrecognized importance tier and should fall back to the standard numeric score.",
          importance: "urgent",
          expiry: "temporary",
        },
        {
          type: "fact",
          subject: "numeric importance",
          content: "This entry already contains a numeric importance and that numeric value should be preserved.",
          importance: 9,
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries.map((entry) => entry.importance)).toEqual([6, 9]);
  });

  it("coerces expiry aliases", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "permanent memory",
          content: "This entry should be treated as durable personal or architectural knowledge that remains valid long-term.",
          importance: "standard",
          expiry: "perm",
        },
        {
          type: "fact",
          subject: "temporary memory",
          content: "This entry should be treated as active project context that may change soon and age out naturally.",
          importance: "standard",
          expiry: "temp",
        },
      ],
    });

    expect(result.entries.map((entry) => entry.expiry)).toEqual(["permanent", "temporary"]);
  });

  it('rejects "core" expiry from extraction and falls back to temporary', () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "reserved expiry",
          content: "This entry improperly requests the reserved core expiry level and should be downgraded to temporary.",
          importance: "standard",
          expiry: "core",
        },
      ],
    });

    expect(result.entries[0]?.expiry).toBe("temporary");
    expect(result.warnings).toContain('Entry 1: expiry "core" is reserved and was changed to "temporary".');
  });

  it("rejects blocked subjects with a warning", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "user",
          content: "This entry has a blocked meta subject and should never survive validation for storage.",
          importance: "standard",
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.warnings[0]).toMatch(/subject "user" is blocked/i);
  });

  it("rejects empty content", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "empty content",
          content: "   ",
          importance: "standard",
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.warnings[0]).toMatch(/content is required/i);
  });

  it("rejects short content", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "short content",
          content: "Too short to keep",
          importance: "standard",
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.warnings[0]).toMatch(/at least 20 characters/i);
  });

  it("normalizes tags to lowercase and caps them at four", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "tag normalization",
          content: "This entry includes more than four tags so the parser should normalize and truncate them consistently.",
          importance: "standard",
          expiry: "temporary",
          tags: ["One", "two", "THREE", "four", "five", "two"],
        },
      ],
    });

    expect(result.entries[0]?.tags).toEqual(["one", "two", "three", "four"]);
  });

  it("passes valid entries through while warning on invalid entries in the same batch", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "valid entry",
          content: "This valid entry should survive even though another entry in the same batch is invalid.",
          importance: "standard",
          expiry: "temporary",
        },
        {
          type: "unknown",
          subject: "bad entry",
          content: "This entry uses an unsupported type and should be rejected by the parser immediately.",
          importance: "standard",
          expiry: "temporary",
        },
      ],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/invalid type/i);
  });

  it("drops malformed claim keys while keeping the entry", () => {
    const result = parseExtractionResponse({
      entries: [
        {
          type: "fact",
          subject: "malformed claim key",
          content: "This durable fact survives even if the extracted claim key is malformed.",
          importance: "standard",
          expiry: "temporary",
          claim_key: "///",
        },
      ],
    });

    expect(result.entries[0]?.claim_key).toBeUndefined();
    expect(result.warnings[0]).toMatch(/dropped claim_key/i);
  });
});
