import { describe, expect, it } from "vitest";

import {
  applyClaimKeyLifecycle,
  buildClaimKeyLifecycleAuditDetails,
  buildClaimKeyLifecycleUpdateFields,
  buildExtractedClaimKeyLifecycle,
  buildManualClaimKeyLifecycle,
  buildManualClaimKeyUpdateFields,
  buildSurgeonAppliedClaimKeyLifecycle,
  buildSurgeonAppliedClaimKeyLifecycleBundle,
  buildSurgeonProposalClaimKeyAuditDetails,
  buildSurgeonProposalClaimKeyLifecycle,
  parseClaimKeySource,
  parseClaimKeyStatus,
  parseClaimSupportMode,
  validateDirectClaimKeyLifecycleUpdate,
} from "../../src/core/claim-key-lifecycle.js";
import type { StoreEntryInput } from "../../src/core/types.js";

describe("claim-key lifecycle helpers", () => {
  it("builds canonical manual lifecycle metadata", () => {
    expect(
      buildManualClaimKeyLifecycle({
        claimKey: "jim/timezone",
        rawClaimKey: " Jim / Timezone ",
        supportSourceKind: "tool_call",
        supportLocator: "session.jsonl#entry:1",
        supportObservedAt: "2026-04-01T10:00:00.000Z",
        supportMode: "explicit",
      }),
    ).toEqual({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim / Timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "session.jsonl#entry:1",
      claim_support_observed_at: "2026-04-01T10:00:00.000Z",
      claim_support_mode: "explicit",
    });
  });

  it("builds direct-update fields for manual claim keys through the shared manual helper", () => {
    expect(
      buildManualClaimKeyUpdateFields({
        claimKey: " Jim / Timezone ",
        supportSourceKind: "tool_call",
        supportLocator: "session.jsonl#agenr_update",
        supportObservedAt: "2026-04-01T10:00:00.000Z",
        supportMode: "explicit",
      }),
    ).toEqual({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim / Timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_locator: "session.jsonl#agenr_update",
      claim_support_observed_at: "2026-04-01T10:00:00.000Z",
      claim_support_mode: "explicit",
    });
  });

  it("builds deterministic-repair lifecycle metadata consistently across callers", () => {
    expect(
      buildExtractedClaimKeyLifecycle({
        claimKey: "jim/timezone",
        confidence: 0.86,
        rawEntity: "Jim",
        rawAttribute: "timezone",
        path: "deterministic_repair",
      }),
    ).toEqual({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim/timezone",
      claim_key_status: "tentative",
      claim_key_source: "deterministic_repair",
      claim_key_confidence: 0.86,
      claim_key_rationale: "claim key inferred by deterministic possessive-slot repair",
    });
  });

  it("lets surgeon reuse the shared lifecycle source and status rules", () => {
    expect(
      buildSurgeonAppliedClaimKeyLifecycle({
        targetClaimKey: "jim/timezone",
        priorClaimKey: null,
        rawClaimKey: "Jim/timezone",
        source: "deterministic_repair",
      }),
    ).toEqual({
      rawClaimKey: "Jim/timezone",
      status: "tentative",
      source: "deterministic_repair",
    });

    expect(
      buildSurgeonProposalClaimKeyLifecycle({
        proposedClaimKeys: ["jim/timezone"],
        source: "entity_family_auto_convergence",
        rawClaimKey: "Jim/timezone",
      }),
    ).toEqual({
      deferredUntilReview: true,
      proposedStatus: "trusted",
      proposedSource: "surgeon_family_reuse",
      proposedRawClaimKey: "Jim/timezone",
    });
  });

  it("builds full surgeon-applied lifecycle bundles for persistence", () => {
    expect(
      buildSurgeonAppliedClaimKeyLifecycleBundle({
        targetClaimKey: "jim/home_city",
        priorClaimKey: " Jim / Home City ",
        rawClaimKey: " Jim / Home City ",
        source: "normalize",
        confidence: 0.99,
        rationale: 'Canonical normalization preserves the slot while rewriting " Jim / Home City " to "jim/home_city".',
      }),
    ).toEqual({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "surgeon_compaction",
      claim_key_confidence: 0.99,
      claim_key_rationale: 'Canonical normalization preserves the slot while rewriting " Jim / Home City " to "jim/home_city".',
    });
  });

  it("maps shared lifecycle bundles into update and audit field shapes", () => {
    const lifecycle = buildSurgeonAppliedClaimKeyLifecycleBundle({
      targetClaimKey: "jim/home_city",
      priorClaimKey: " Jim / Home City ",
      rawClaimKey: " Jim / Home City ",
      source: "normalize",
      confidence: 0.99,
      rationale: 'Canonical normalization preserves the slot while rewriting " Jim / Home City " to "jim/home_city".',
    });

    expect(buildClaimKeyLifecycleUpdateFields(lifecycle)).toEqual({
      claim_key: "jim/home_city",
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "surgeon_compaction",
      claim_key_confidence: 0.99,
      claim_key_rationale: 'Canonical normalization preserves the slot while rewriting " Jim / Home City " to "jim/home_city".',
      claim_support_source_kind: undefined,
      claim_support_locator: undefined,
      claim_support_observed_at: undefined,
      claim_support_mode: undefined,
    });
    expect(buildClaimKeyLifecycleAuditDetails(lifecycle)).toEqual({
      claim_key_raw: "Jim / Home City",
      claim_key_status: "trusted",
      claim_key_source: "surgeon_compaction",
      claim_key_confidence: 0.99,
      claim_key_rationale: 'Canonical normalization preserves the slot while rewriting " Jim / Home City " to "jim/home_city".',
    });
  });

  it("maps deferred surgeon proposal lifecycle metadata into audit details", () => {
    expect(
      buildSurgeonProposalClaimKeyAuditDetails(
        buildSurgeonProposalClaimKeyLifecycle({
          proposedClaimKeys: ["agenr/status"],
          source: "metadata_backfill_rewrite",
          rawClaimKey: "project/status",
        }),
      ),
    ).toEqual({
      proposal_deferred_until_review: true,
      proposal_claim_key_status: "trusted",
      proposal_claim_key_source: "surgeon_metadata_rewrite",
      proposal_claim_key_raw: "project/status",
    });
  });

  it("applies one resolved lifecycle payload directly onto store inputs", () => {
    const entry: StoreEntryInput = {
      type: "fact",
      subject: "Jim timezone",
      content: "Jim uses America/Chicago.",
    };

    applyClaimKeyLifecycle(
      entry,
      buildManualClaimKeyLifecycle({
        claimKey: "jim/timezone",
        rawClaimKey: "Jim/timezone",
      }),
    );

    expect(entry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
    });
  });

  it("parses only supported lifecycle boundary values", () => {
    expect(parseClaimKeyStatus("trusted")).toBe("trusted");
    expect(parseClaimKeyStatus("legacy")).toBeUndefined();
    expect(parseClaimKeySource("surgeon_compaction")).toBe("surgeon_compaction");
    expect(parseClaimKeySource("handwritten")).toBeUndefined();
    expect(parseClaimSupportMode("explicit")).toBe("explicit");
    expect(parseClaimSupportMode("copied")).toBeUndefined();
  });

  it("rejects partial direct lifecycle update payloads", () => {
    expect(() =>
      validateDirectClaimKeyLifecycleUpdate({
        claim_key: "jim/timezone",
      }),
    ).toThrow(/complete lifecycle payload/i);
  });
});
