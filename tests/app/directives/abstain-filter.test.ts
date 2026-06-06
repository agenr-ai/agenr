import { describe, expect, it, vi } from "vitest";

import {
  ABSTAIN_DIRECTIVE_LOOKUP_FAILED_NOTICE,
  type AbstainInjectionDiagnostics,
  applyAbstainDirectives,
  applyAbstainDirectivesForInjection,
} from "../../../src/app/directives/abstain-filter.js";
import { MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX } from "../../../src/core/directives/model.js";
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
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildItem(entry: Durable): { entry: Durable } {
  return { entry };
}

const directiveRow = buildDurable({
  id: "dir-stan",
  claim_key: `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}do_not_mention_stan`,
  subject: "memory directive",
  content: "Do not mention Stan.",
});

describe("applyAbstainDirectives", () => {
  it("returns all items unchanged when there are no items", async () => {
    const result = await applyAbstainDirectives(
      [],
      vi.fn(async () => [directiveRow]),
    );
    expect(result.kept).toEqual([]);
    expect(result.suppressed).toEqual([]);
  });

  it("drops directive rows from injection without a lookup", async () => {
    const directiveItem = buildItem(directiveRow);
    const factItem = buildItem(buildDurable({ id: "fact-1", subject: "home", content: "Lives in Lisbon." }));

    const result = await applyAbstainDirectives([directiveItem, factItem], undefined);

    expect(result.kept).toEqual([factItem]);
    expect(result.suppressed).toEqual([{ entryId: "dir-stan", reason: "directive_self" }]);
  });

  it("suppresses candidates that violate an active directive", async () => {
    const stanItem = buildItem(buildDurable({ id: "fact-stan", subject: "colleague", content: "Stan prefers async standups." }));
    const otherItem = buildItem(buildDurable({ id: "fact-other", subject: "ops", content: "Deploys ship on Tuesday." }));
    const lookup = vi.fn(async () => [directiveRow]);

    const result = await applyAbstainDirectives([stanItem, otherItem], lookup);

    expect(result.kept).toEqual([otherItem]);
    expect(result.suppressed).toEqual([{ entryId: "fact-stan", reason: "directive_topic", directiveId: "dir-stan", blockedTerm: "stan" }]);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("does not invoke the lookup when only directive rows remain", async () => {
    const directiveItem = buildItem(directiveRow);
    const lookup = vi.fn(async () => [directiveRow]);

    const result = await applyAbstainDirectives([directiveItem], lookup);

    expect(result.kept).toEqual([]);
    expect(result.suppressed).toEqual([{ entryId: "dir-stan", reason: "directive_self" }]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("records diagnostics when injection candidates are suppressed", async () => {
    const stanItem = buildItem(buildDurable({ id: "fact-stan", subject: "colleague", content: "Stan prefers async standups." }));
    const diagnostics: AbstainInjectionDiagnostics = { notices: [] };
    const lookup = vi.fn(async () => [directiveRow]);

    const kept = await applyAbstainDirectivesForInjection([stanItem], lookup, diagnostics);

    expect(kept).toEqual([]);
    expect(diagnostics.directiveAbstentions).toEqual([{ entryId: "fact-stan", reason: "directive_topic", directiveId: "dir-stan", blockedTerm: "stan" }]);
    expect(diagnostics.notices[0]).toContain("dir-stan");
  });

  it("fails open and keeps non-directive items when the lookup throws", async () => {
    const stanItem = buildItem(buildDurable({ id: "fact-stan", subject: "colleague", content: "Stan prefers async standups." }));
    const lookup = vi.fn(async () => {
      throw new Error("directive store unavailable");
    });

    const result = await applyAbstainDirectives([stanItem], lookup);

    expect(result.kept).toEqual([stanItem]);
    expect(result.suppressed).toEqual([]);
    expect(result.lookupFailed).toBe(true);
  });

  it("surfaces a degraded notice when the lookup throws during injection", async () => {
    const stanItem = buildItem(buildDurable({ id: "fact-stan", subject: "colleague", content: "Stan prefers async standups." }));
    const diagnostics: AbstainInjectionDiagnostics = { notices: [] };
    const lookup = vi.fn(async () => {
      throw new Error("directive store unavailable");
    });

    const kept = await applyAbstainDirectivesForInjection([stanItem], lookup, diagnostics);

    expect(kept).toEqual([stanItem]);
    expect(diagnostics.notices).toContain(ABSTAIN_DIRECTIVE_LOOKUP_FAILED_NOTICE);
    expect(diagnostics.directiveAbstentions).toBeUndefined();
  });
});
