import { describe, expect, it } from "vitest";

import { collectAbstainDirectives, findAbstainViolation, parseAbstainDirective } from "../../../src/core/directives/abstain.js";
import {
  isDirectiveDurable,
  MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX,
  normalizeMemoryDirectiveClaimKey,
  parseDirectiveMetadata,
} from "../../../src/core/directives/model.js";
import type { Durable } from "../../../src/core/types.js";

function buildDurable(overrides: Partial<Durable> & Pick<Durable, "id" | "subject" | "content">): Durable {
  return {
    type: "fact",
    importance: 5,
    expiry: "core",
    tags: [],
    embedding: [],
    quality_score: 0.5,
    recall_count: 0,
    retired: false,
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isDirectiveDurable", () => {
  it("recognizes the memory-directive claim-key family", () => {
    expect(isDirectiveDurable({ claim_key: `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}do_not_mention_stan` })).toBe(true);
  });

  it("rejects the bare prefix and unrelated keys", () => {
    expect(isDirectiveDurable({ claim_key: MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX })).toBe(false);
    expect(isDirectiveDurable({ claim_key: "user/location/home" })).toBe(false);
    expect(isDirectiveDurable({ claim_key: undefined })).toBe(false);
  });
});

describe("directive metadata", () => {
  it("normalizes the three-segment memory-directive claim-key family", () => {
    expect(normalizeMemoryDirectiveClaimKey(" User / Memory Directive / Weekly Goals ")).toBe("user/memory_directive/weekly_goals");
    expect(normalizeMemoryDirectiveClaimKey("user/location/home")).toBeUndefined();
  });

  it("parses proactive directive polarity and trigger", () => {
    const metadata = parseDirectiveMetadata(
      buildDurable({
        id: "dir-goals",
        type: "directive",
        claim_key: `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}weekly_goals`,
        directive_polarity: "proactive",
        directive_trigger: "session_start",
        subject: "weekly goals directive",
        content: "Ask about weekly goals at session start.",
      }),
    );

    expect(metadata).toEqual({ polarity: "proactive", trigger: "session_start" });
  });
});

describe("parseAbstainDirective", () => {
  it("extracts a blocked topic from directive content", () => {
    const directive = parseAbstainDirective(
      buildDurable({
        id: "dir-1",
        claim_key: `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}do_not_mention_stan`,
        subject: "memory directive",
        content: "Do not mention Stan again.",
      }),
    );

    expect(directive).not.toBeNull();
    expect(directive?.blockedTerms).toContain("stan");
  });

  it("strips leading determiners and trailing qualifiers", () => {
    const directive = parseAbstainDirective(
      buildDurable({
        id: "dir-2",
        claim_key: `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}sf`,
        subject: "memory directive",
        content: "Please don't bring up the San Francisco move anymore.",
      }),
    );

    expect(directive?.blockedTerms).toContain("san francisco move");
  });

  it("falls back to the claim-key suffix when content yields nothing", () => {
    const directive = parseAbstainDirective(
      buildDurable({
        id: "dir-3",
        claim_key: `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}do_not_mention_old_job`,
        subject: "memory directive",
        content: "Keep this off-limits.",
      }),
    );

    expect(directive?.blockedTerms).toContain("old job");
  });

  it("returns null for non-directive durables", () => {
    expect(
      parseAbstainDirective(
        buildDurable({
          id: "fact-1",
          claim_key: "user/location/home",
          subject: "home",
          content: "Lives in Lisbon.",
        }),
      ),
    ).toBeNull();
  });
});

describe("findAbstainViolation", () => {
  const directives = collectAbstainDirectives([
    buildDurable({
      id: "dir-stan",
      claim_key: `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}do_not_mention_stan`,
      subject: "memory directive",
      content: "Do not mention Stan.",
    }),
  ]);

  it("suppresses a candidate that mentions the blocked topic", () => {
    const violation = findAbstainViolation(
      buildDurable({
        id: "fact-stan",
        subject: "colleague note",
        content: "Stan prefers async standups.",
      }),
      directives,
    );

    expect(violation).toEqual({ directiveId: "dir-stan", blockedTerm: "stan" });
  });

  it("allows candidates that do not mention the blocked topic", () => {
    const violation = findAbstainViolation(
      buildDurable({
        id: "fact-other",
        subject: "colleague note",
        content: "Standups are async on Mondays.",
      }),
      directives,
    );

    expect(violation).toBeNull();
  });

  it("matches blocked phrases only on word boundaries", () => {
    const violation = findAbstainViolation(
      buildDurable({
        id: "fact-substring",
        subject: "logistics",
        content: "The constants module was renamed.",
      }),
      directives,
    );

    expect(violation).toBeNull();
  });

  it("never suppresses the directive row against itself", () => {
    const violation = findAbstainViolation(
      buildDurable({
        id: "dir-stan",
        subject: "memory directive",
        content: "Do not mention Stan.",
      }),
      directives,
    );

    expect(violation).toBeNull();
  });
});
