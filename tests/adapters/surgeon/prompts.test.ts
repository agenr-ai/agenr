import { describe, expect, it } from "vitest";

import { getSurgeonRetirementPassPrompt, getSurgeonSupersessionPassPrompt, getSurgeonSystemPrompt } from "../../../src/adapters/surgeon/prompts.js";

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

  it("system prompt teaches conservative surgeon philosophy", () => {
    const prompt = getSurgeonSystemPrompt();

    expect(prompt).toContain("Conservative by default");
    expect(prompt).toContain("The cost of retiring something useful is higher");
    expect(prompt).toContain("Skip ambiguous cases");
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

  it("system prompt stays pass-agnostic", () => {
    const prompt = getSurgeonSystemPrompt();

    expect(prompt).not.toContain("Retirement is the only pass in scope.");
    expect(prompt).not.toContain("query_candidates starts with `scope = 'actionable'`");
    expect(prompt).not.toContain("# Retirement Pass");
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

  it("supersession prompt emphasizes coexistence and claim-key-first review", () => {
    const prompt = getSurgeonSupersessionPassPrompt();

    expect(prompt).toContain("Coexistence is the most common case");
    expect(prompt).toContain("query_supersession_candidates");
    expect(prompt).toContain("scope = 'claim_key'");
    expect(prompt).toContain("assign_claim_key");
    expect(prompt).toContain("set_validity");
  });

  it("supersession prompt keeps retirement out of scope", () => {
    const prompt = getSurgeonSupersessionPassPrompt();

    expect(prompt).toContain("You are not retiring entries");
    expect(prompt).not.toContain("retire_entry");
  });
});
