import { describe, expect, it } from "vitest";

import { evaluateSiblingSlotResonance } from "../../src/core/claim-key-slot-resonance.js";

describe("evaluateSiblingSlotResonance", () => {
  it("fires when multiple grounded siblings converge on the same compact slot shape", () => {
    const evaluation = evaluateSiblingSlotResonance({
      candidateClaimKey: "openclaw/session_start_context_flag",
      localLexicalTokens: ["openclaw", "session", "start", "context", "flag"],
      groundedSiblings: [
        {
          entryId: "sib-1",
          claimKey: "openclaw/session_start_context_window",
        },
        {
          entryId: "sib-2",
          claimKey: "openclaw/session_start_context_toggle",
        },
        {
          entryId: "sib-3",
          claimKey: "openclaw/cross_surface_session_pickup",
        },
      ],
    });

    expect(evaluation).toMatchObject({
      applicable: true,
      fired: true,
      groundedSiblingCount: 3,
      resonantSiblingCount: 2,
      dominantShape: "session_start_context",
      dominantShapeCount: 2,
      localShapeTokenCoverage: 1,
      dominantSiblingEntryIds: ["sib-1", "sib-2"],
    });
  });

  it("stays off when siblings only echo a broad family token", () => {
    const evaluation = evaluateSiblingSlotResonance({
      candidateClaimKey: "jim/project_value_prop_focus",
      localLexicalTokens: ["jim", "project", "value", "prop", "focus"],
      groundedSiblings: [
        {
          entryId: "sib-1",
          claimKey: "jim/project_scope_boundary",
        },
        {
          entryId: "sib-2",
          claimKey: "jim/project_status_workflow",
        },
        {
          entryId: "sib-3",
          claimKey: "jim/project_priority_policy",
        },
      ],
    });

    expect(evaluation).toMatchObject({
      applicable: true,
      fired: false,
      groundedSiblingCount: 3,
      resonantSiblingCount: 0,
      dominantShape: null,
      dominantShapeCount: 0,
      familyGenericTokens: ["project"],
    });
  });

  it("does not fire when only one sibling carries the shape", () => {
    const evaluation = evaluateSiblingSlotResonance({
      candidateClaimKey: "documentation/docs_style_preference",
      localLexicalTokens: ["docs", "style", "preference"],
      groundedSiblings: [
        {
          entryId: "sib-1",
          claimKey: "documentation/docs_style_policy",
        },
      ],
    });

    expect(evaluation).toMatchObject({
      applicable: true,
      fired: false,
      groundedSiblingCount: 1,
      resonantSiblingCount: 1,
      dominantShape: "docs_style",
      dominantShapeCount: 1,
    });
  });
});
