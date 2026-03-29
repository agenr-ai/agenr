import { describe, expect, it } from "vitest";

import { getSurgeonRetirementPassPrompt, getSurgeonSystemPrompt } from "../../../src/adapters/surgeon/prompts.js";

describe("surgeon prompts", () => {
  it("system prompt contains the v1 corpus field glossary", () => {
    const prompt = getSurgeonSystemPrompt();

    expect(prompt).toContain("importance");
    expect(prompt).toContain("expiry");
    expect(prompt).toContain("quality_score");
    expect(prompt).toContain("recall_count");
    expect(prompt).toContain("source_file");
    expect(prompt).not.toContain("entry_kind");
    expect(prompt).not.toContain("temporal_class");
    expect(prompt).not.toContain("confirmations");
    expect(prompt).not.toContain("subject_key");
    expect(prompt).not.toContain("claim_predicate");
    expect(prompt).not.toContain("claimObject");
  });

  it("system prompt teaches conservative retirement philosophy", () => {
    const prompt = getSurgeonSystemPrompt();

    expect(prompt).toContain("Conservative by default");
    expect(prompt).toContain("Age alone is not staleness");
    expect(prompt).toContain("The cost of retiring something useful is higher");
  });

  it("system prompt does not reference review-queue tooling", () => {
    const prompt = getSurgeonSystemPrompt();

    expect(prompt).not.toContain("flag_for_review");
  });

  it("retirement prompt describes the actionable-first workflow", () => {
    const prompt = getSurgeonRetirementPassPrompt();

    expect(prompt).toContain("actionable");
    expect(prompt).toContain("scope = 'all'");
    expect(prompt).toContain("complete_pass");
  });

  it("retirement prompt includes type-specific heuristics", () => {
    const prompt = getSurgeonRetirementPassPrompt();

    expect(prompt).toContain("todo");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("event");
    expect(prompt).toContain("preference");
  });

  it("retirement prompt does not reference removed supersession tooling", () => {
    const prompt = getSurgeonRetirementPassPrompt();

    expect(prompt).not.toContain("query_supersession_candidates");
  });
});
