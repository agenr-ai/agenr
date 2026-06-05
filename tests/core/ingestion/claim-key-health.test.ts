import { describe, expect, it } from "vitest";

import { summarizeIngestClaimKeyHealth } from "../../../src/core/ingestion/claim-key-health.js";
import type { ClaimExtractionDiagnostic } from "../../../src/core/store/claim-extraction.js";
import type { StoreDurableInput } from "../../../src/core/types.js";

describe("summarizeIngestClaimKeyHealth", () => {
  it("surfaces suspicious singleton alias families while ignoring scoped namespace nesting", () => {
    const entries: StoreDurableInput[] = [
      createEntry({ subject: "Jim timezone", claim_key: "jim/timezone", claim_key_status: "trusted", claim_key_source: "model" }),
      createEntry({
        subject: "Jim editor preference",
        claim_key: "jim/editor_preference",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      createEntry({
        subject: "Jim review preference",
        claim_key: "jim/code_review_preference",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      createEntry({
        subject: "Jim Martin skunk identity",
        claim_key: "jim_martin/skunk_theme",
        claim_key_status: "tentative",
        claim_key_source: "deterministic_repair",
      }),
      createEntry({ subject: "Agenr release strategy", claim_key: "agenr/release_strategy", claim_key_status: "trusted", claim_key_source: "model" }),
      createEntry({
        subject: "Agenr workflow source of truth",
        claim_key: "agenr/source_of_truth",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      createEntry({
        subject: "Agenr rebuild order",
        claim_key: "agenr/brain_rebuild_workflow",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      createEntry({
        subject: "MacBook agenr repo source of truth",
        claim_key: "macbook_agenr_repo/source_of_truth",
        claim_key_status: "tentative",
        claim_key_source: "deterministic_repair",
      }),
    ];

    const summary = summarizeIngestClaimKeyHealth(entries, new Map<number, ClaimExtractionDiagnostic>(), ["fact", "decision", "preference", "lesson"]);

    expect(summary.suspiciousSingletonAliasCount).toBe(1);
    expect(summary.suspiciousSingletonNamespaceHints).toEqual([expect.stringContaining("jim_martin -> jim")]);
    expect(summary.suspiciousSingletonNamespaceHints.join(" ")).not.toContain("macbook_agenr_repo");
  });
});

function createEntry(overrides: Partial<StoreDurableInput> = {}): StoreDurableInput {
  return {
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "subject",
    content: overrides.content ?? overrides.subject ?? "content",
    claim_key: overrides.claim_key,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    user_id: overrides.user_id,
    project: overrides.project,
    tags: overrides.tags,
  };
}
