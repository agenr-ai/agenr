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

  it("system prompt teaches corpus age awareness for recent rebuilds", () => {
    const prompt = getSurgeonSystemPrompt();

    expect(prompt).toContain("lastBulkIngestAt");
    expect(prompt).toContain("recently rebuilt");
    expect(prompt).toContain("never use `recall_count = 0` as the sole or primary retirement reason");
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

    expect(prompt).toContain("milestone");
    expect(prompt).toContain("decision");
    expect(prompt).not.toContain("todo");
    expect(prompt).not.toContain("event");
    expect(prompt).toContain("preference");
  });

  it("retirement prompt protects personal knowledge from low-signal retirement", () => {
    const prompt = getSurgeonRetirementPassPrompt();

    expect(prompt).toContain("## Personal Knowledge");
    expect(prompt).toContain("pets");
    expect(prompt).toContain("Do NOT retire personal knowledge entries because:");
    expect(prompt).toContain("## What Looks Like a Pattern But Is Not");
    expect(prompt).toContain("Hardware, infrastructure, and environment details");
  });

  it("retirement prompt does not reference removed supersession tooling", () => {
    const prompt = getSurgeonRetirementPassPrompt();

    expect(prompt).not.toContain("query_supersession_candidates");
  });
});
