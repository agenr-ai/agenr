import { describe, expect, it } from "vitest";

import {
  buildAliasReviewSummary,
  formatAliasAutoApplyBlocker,
  summarizeAliasEvidence,
  summarizeAliasProfiles,
} from "../../web/src/lib/alias-audit.js";

describe("alias audit web helpers", () => {
  it("builds an alias review summary from persisted audit fields", () => {
    expect(
      buildAliasReviewSummary({
        alias_entity_prefix: "agenr",
        alias_current_claim_keys: ["agenr/quality_score_default", "agenr/quality_score_heuristic"],
        alias_proposed_claim_key: "agenr/quality_score_default",
        alias_deterministic_confidence: 0.94,
        alias_llm_same_slot: true,
        alias_llm_confidence: 0.91,
        alias_llm_rationale: "Same slot.",
      }),
    ).toEqual({
      entityPrefix: "agenr",
      currentKeys: ["agenr/quality_score_default", "agenr/quality_score_heuristic"],
      proposedKey: "agenr/quality_score_default",
      deterministicConfidence: 0.94,
      llmSameSlot: true,
      llmConfidence: 0.91,
      llmRationale: "Same slot.",
    });
  });

  it("summarizes alias evidence using detail text", () => {
    const summary = summarizeAliasEvidence([
      { kind: "attribute_token_overlap", detail: "Attributes share 2 stable tokens." },
      { kind: "same_type", detail: "Both keys are used by fact durables." },
    ]);

    expect(summary.label).toBe("2 evidence items");
    expect(summary.title).toContain("Attribute Token Overlap: Attributes share 2 stable tokens.");
    expect(summary.title).toContain("Same Type: Both keys are used by fact durables.");
  });

  it("summarizes alias key profiles using durableIds and trustedOrManualCount", () => {
    const summary = summarizeAliasProfiles([
      {
        claimKey: "agenr/quality_score_default",
        durableIds: ["quality-default"],
        trustedOrManualCount: 1,
      },
      {
        claimKey: "agenr/quality_score_heuristic",
        durableIds: ["quality-heuristic", "quality-shadow"],
        trustedOrManualCount: 0,
      },
    ]);

    expect(summary.label).toBe("2 key profiles");
    expect(summary.title).toContain("agenr/quality_score_default (1 durable, trusted/manual)");
    expect(summary.title).toContain("agenr/quality_score_heuristic (2 durables, tentative)");
  });

  it("formats known blocker codes and leaves prose blockers unchanged", () => {
    expect(formatAliasAutoApplyBlocker("cross_type_collision")).toBe("Another active memory already uses that key for a different type");
    expect(formatAliasAutoApplyBlocker("LLM adjudication was unavailable.")).toBe("LLM adjudication was unavailable.");
  });
});
