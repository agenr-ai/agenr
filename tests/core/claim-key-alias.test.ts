import { describe, expect, it } from "vitest";

import { detectClaimKeyAliasCandidates } from "../../src/core/claim-key-alias.js";
import type { Durable } from "../../src/core/types.js";
import { buildDurable } from "../helpers/dreaming-reconcile.js";

describe("claim-key alias detector", () => {
  it("detects same-entity quality score aliases", () => {
    const candidates = detectClaimKeyAliasCandidates([
      durable({
        id: "quality-default",
        subject: "Agenr quality score",
        content: "Agenr durable quality scoring uses a default score when no evaluator is available.",
        claim_key: "agenr/quality_score_default",
        tags: ["agenr", "quality", "scoring"],
        source_context: "Dreaming quality score implementation notes",
        claim_key_status: "trusted",
        claim_key_source: "manual",
        claim_key_confidence: 1,
      }),
      durable({
        id: "quality-heuristic",
        subject: "Agenr quality score",
        content: "Agenr durable quality scoring falls back to a heuristic score when no evaluator is available.",
        claim_key: "agenr/quality_score_heuristic",
        tags: ["agenr", "quality", "scoring"],
        source_context: "Dreaming quality score implementation notes",
        claim_key_status: "tentative",
        claim_key_source: "dreaming_extract",
        claim_key_confidence: 0.91,
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      entityPrefix: "agenr",
      claimKeys: ["agenr/quality_score_default", "agenr/quality_score_heuristic"],
      proposedClaimKey: "agenr/quality_score_default",
      deterministicAutoApplyEligible: true,
    });
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(candidates[0]?.evidence.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["same_entity", "attribute_token_overlap", "subject_overlap", "content_overlap", "shared_tags", "same_type"]),
    );
  });

  it("does not collapse distinct same-entity slots", () => {
    const candidates = detectClaimKeyAliasCandidates([
      durable({
        id: "package-manager",
        subject: "Agenr package manager",
        content: "Agenr uses pnpm as the package manager.",
        claim_key: "agenr/package_manager",
        tags: ["agenr", "package"],
      }),
      durable({
        id: "release-policy",
        subject: "Agenr release policy",
        content: "Agenr releases follow calendar-versioned OpenClaw packages.",
        claim_key: "agenr/release_policy",
        tags: ["agenr", "release"],
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("does not emit cross-entity aliases", () => {
    const candidates = detectClaimKeyAliasCandidates([
      durable({
        id: "agenr-quality",
        subject: "Agenr quality score",
        content: "Agenr quality scoring uses a default heuristic.",
        claim_key: "agenr/quality_score_default",
        tags: ["quality", "scoring"],
      }),
      durable({
        id: "skeln-quality",
        subject: "Skeln quality score",
        content: "Skeln quality scoring uses a default heuristic.",
        claim_key: "skeln/quality_score_heuristic",
        tags: ["quality", "scoring"],
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("merges transitive alias clusters when adjacent pairs qualify", () => {
    const sharedSubject = "Agenr quality score";
    const sharedTags = ["agenr", "quality", "scoring"];
    const sharedContext = "Dreaming quality score implementation notes";
    const candidates = detectClaimKeyAliasCandidates([
      durable({
        id: "quality-default",
        subject: sharedSubject,
        content: "Agenr durable quality scoring uses a default score when no evaluator is available.",
        claim_key: "agenr/quality_score_default",
        tags: sharedTags,
        source_context: sharedContext,
        claim_key_status: "trusted",
        claim_key_source: "manual",
      }),
      durable({
        id: "quality-heuristic",
        subject: sharedSubject,
        content: "Agenr durable quality scoring falls back to a heuristic score when no evaluator is available.",
        claim_key: "agenr/quality_score_heuristic",
        tags: sharedTags,
        source_context: sharedContext,
      }),
      durable({
        id: "quality-fallback",
        subject: sharedSubject,
        content: "Agenr durable quality scoring uses a fallback score when no evaluator is available.",
        claim_key: "agenr/quality_score_fallback",
        tags: sharedTags,
        source_context: sharedContext,
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.claimKeys).toEqual(["agenr/quality_score_default", "agenr/quality_score_fallback", "agenr/quality_score_heuristic"]);
  });

  it("bounds oversized noisy entity groups", () => {
    const durables = Array.from({ length: 45 }, (_, index) =>
      durable({
        id: `noisy-${index}`,
        subject: `Agenr noisy attribute ${index}`,
        content: `Agenr noisy attribute ${index} records unrelated detail ${index}.`,
        claim_key: `agenr/noisy_attribute_${index}`,
        tags: ["agenr", "noise"],
      }),
    );

    expect(detectClaimKeyAliasCandidates(durables)).toEqual([]);
  });
});

function durable(overrides: Partial<Durable> & Pick<Durable, "id" | "subject" | "claim_key">): Durable {
  return buildDurable({
    type: "fact",
    project: "agenr",
    importance: 7,
    ...overrides,
  });
}
