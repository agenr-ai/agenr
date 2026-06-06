import { describe, expect, it } from "vitest";

import {
  detectClaimKeyEntityFamilyCandidates,
  detectClaimKeySingletonAliasCandidates,
  detectClaimKeySingletonAliasCandidatesFromStats,
  summarizeClaimKeyEntityPrefixStats,
} from "../../src/core/claim-key-entity-family.js";
import type { Durable } from "../../src/core/types.js";

describe("detectClaimKeyEntityFamilyCandidates", () => {
  it("detects strong short-name and full-name style family splits when structural grounding is repeated", () => {
    const candidates = detectClaimKeyEntityFamilyCandidates([
      buildEntry({
        id: "jim-timezone",
        subject: "Jim timezone",
        claim_key: "jim/timezone",
        tags: ["profile", "user"],
        source_context: "Jim profile handbook timezone defaults",
      }),
      buildEntry({
        id: "jim-review",
        subject: "Jim review preference",
        claim_key: "jim/code_review_preference",
        tags: ["profile", "user"],
        source_context: "Jim profile handbook review defaults",
      }),
      buildEntry({
        id: "james-timezone",
        subject: "James Martin timezone",
        claim_key: "james_martin/timezone",
        tags: ["profile", "user"],
        source_context: "Jim profile handbook timezone defaults",
      }),
      buildEntry({
        id: "james-review",
        subject: "James Martin review preference",
        claim_key: "james_martin/code_review_preference",
        tags: ["profile", "user"],
        source_context: "Jim profile handbook review defaults",
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      entityPrefixes: ["james_martin", "jim"],
      canonicalEntityPrefix: null,
      autoConverge: false,
      unresolvedReason: expect.any(String),
    });
    expect(candidates[0]?.pairSupport).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityPrefixes: ["james_martin", "jim"],
          sharedAttributes: ["code_review_preference", "timezone"],
          evidence: expect.arrayContaining([
            expect.objectContaining({ kind: "shared_attribute_overlap" }),
            expect.objectContaining({ kind: "shared_tag_grounding" }),
            expect.objectContaining({ kind: "shared_source_context_grounding" }),
          ]),
        }),
      ]),
    );
  });

  it("does not merge unrelated entities that only overlap on common attributes", () => {
    const candidates = detectClaimKeyEntityFamilyCandidates([
      buildEntry({
        id: "postgres-version",
        subject: "Postgres version",
        claim_key: "postgres/version",
        tags: ["database"],
        source_context: "Database runtime checklist",
      }),
      buildEntry({
        id: "postgres-status",
        subject: "Postgres status",
        claim_key: "postgres/status",
        tags: ["database"],
        source_context: "Database runtime checklist",
      }),
      buildEntry({
        id: "redis-version",
        subject: "Redis version",
        claim_key: "redis/version",
        tags: ["cache"],
        source_context: "Cache runtime checklist",
      }),
      buildEntry({
        id: "redis-status",
        subject: "Redis status",
        claim_key: "redis/status",
        tags: ["cache"],
        source_context: "Cache runtime checklist",
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("prefers a dominant higher-quality canonical family over a compact alias", () => {
    const candidates = detectClaimKeyEntityFamilyCandidates([
      buildEntry({
        id: "gateway-canonical-restart",
        subject: "Gateway restart policy",
        claim_key: "openclaw_gateway/restart_policy",
        quality_score: 0.9,
        tags: ["gateway", "auth"],
        source_context: "Gateway auth docs",
      }),
      buildEntry({
        id: "gateway-canonical-log-level",
        subject: "Gateway log level",
        claim_key: "openclaw_gateway/log_level",
        quality_score: 0.88,
        tags: ["gateway", "auth"],
        source_context: "Gateway auth docs",
      }),
      buildEntry({
        id: "gateway-alias-restart",
        subject: "Gateway restart policy alias",
        claim_key: "openclawgateway/restart_policy",
        quality_score: 0.42,
        tags: ["gateway", "auth"],
        source_context: "Gateway auth docs",
      }),
      buildEntry({
        id: "gateway-alias-log-level",
        subject: "Gateway log level alias",
        claim_key: "openclawgateway/log_level",
        quality_score: 0.41,
        tags: ["gateway", "auth"],
        source_context: "Gateway auth docs",
      }),
      buildEntry({
        id: "gateway-alias-auth-mode",
        subject: "Gateway auth mode alias",
        claim_key: "openclawgateway/auth_mode",
        quality_score: 0.4,
        tags: ["gateway", "auth"],
        source_context: "Gateway auth docs",
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      entityPrefixes: ["openclaw_gateway", "openclawgateway"],
      canonicalEntityPrefix: "openclaw_gateway",
      autoConverge: true,
    });
    expect(candidates[0]?.canonicalSelectionReasons).toEqual(expect.arrayContaining(["broader trusted attribute coverage", "less abbreviated lexical form"]));
  });

  it("keeps three-way family splits unresolved when more than one canonical prefix is plausible", () => {
    const candidates = detectClaimKeyEntityFamilyCandidates([
      buildEntry({
        id: "jim-timezone",
        subject: "Jim timezone",
        claim_key: "jim/timezone",
        tags: ["profile", "user"],
        source_context: "Personal profile handbook",
      }),
      buildEntry({
        id: "jim-editor",
        subject: "Jim editor preference",
        claim_key: "jim/editor_preference",
        tags: ["profile", "user"],
        source_context: "Personal profile handbook",
      }),
      buildEntry({
        id: "james-timezone",
        subject: "James Martin timezone",
        claim_key: "james_martin/timezone",
        tags: ["profile", "user"],
        source_context: "Personal profile handbook",
      }),
      buildEntry({
        id: "james-editor",
        subject: "James Martin editor preference",
        claim_key: "james_martin/editor_preference",
        tags: ["profile", "user"],
        source_context: "Personal profile handbook",
      }),
      buildEntry({
        id: "jm-timezone",
        subject: "JM timezone",
        claim_key: "jm/timezone",
        tags: ["profile", "user"],
        source_context: "Personal profile handbook",
      }),
      buildEntry({
        id: "jm-editor",
        subject: "JM editor preference",
        claim_key: "jm/editor_preference",
        tags: ["profile", "user"],
        source_context: "Personal profile handbook",
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      entityPrefixes: ["james_martin", "jim", "jm"],
      canonicalEntityPrefix: null,
      autoConverge: false,
      unresolvedReason: "Multiple plausible canonical entity prefixes remain after conservative scoring.",
    });
  });
});

describe("detectClaimKeySingletonAliasCandidates", () => {
  it("detects a low-trust singleton alias next to a dominant trusted family", () => {
    const candidates = detectClaimKeySingletonAliasCandidates([
      buildEntry({ id: "jim-timezone", subject: "Jim timezone", claim_key: "jim/timezone", claim_key_status: "trusted", claim_key_source: "model" }),
      buildEntry({
        id: "jim-review",
        subject: "Jim review preference",
        claim_key: "jim/code_review_preference",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      buildEntry({
        id: "jim-editor",
        subject: "Jim editor preference",
        claim_key: "jim/editor_preference",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      buildEntry({
        id: "jim-skunk",
        subject: "Jim Martin skunk identity",
        claim_key: "jim_martin/skunk_theme",
        claim_key_status: "tentative",
        claim_key_source: "deterministic_repair",
      }),
    ]);

    expect(candidates).toEqual([
      expect.objectContaining({
        aliasEntityPrefix: "jim_martin",
        dominantEntityPrefix: "jim",
        aliasFamilySize: 1,
        dominantTrustedCount: 3,
        canonicalReuseSafe: true,
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: "singleton_family_size" }),
          expect.objectContaining({ kind: "dominant_trusted_family" }),
          expect.objectContaining({ kind: "low_trust_creation_path" }),
          expect.objectContaining({ kind: "lexical_token_subset" }),
        ]),
      }),
    ]);
  });

  it("skips keyed observations that are missing lifecycle status", () => {
    const stats = summarizeClaimKeyEntityPrefixStats([
      {
        claim_key: "jim/timezone",
        claim_key_source: "manual",
      },
      {
        claim_key: "jim/language",
        claim_key_status: "trusted",
        claim_key_source: "manual",
      },
    ]);

    expect(stats).toEqual([
      expect.objectContaining({
        entityPrefix: "jim",
        activeEntryCount: 1,
        trustedEntryCount: 1,
      }),
    ]);
  });

  it("does not treat intentional scope nesting as a singleton alias family", () => {
    const stats = summarizeClaimKeyEntityPrefixStats([
      buildEntry({
        id: "agenr-policy-1",
        subject: "Agenr policy one",
        claim_key: "agenr/release_strategy",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      buildEntry({
        id: "agenr-policy-2",
        subject: "Agenr policy two",
        claim_key: "agenr/store_input_format",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      buildEntry({
        id: "agenr-policy-3",
        subject: "Agenr policy three",
        claim_key: "agenr/brain_rebuild_workflow",
        claim_key_status: "trusted",
        claim_key_source: "model",
      }),
      buildEntry({
        id: "scoped-repo",
        subject: "MacBook agenr repo path",
        claim_key: "macbook_agenr_repo/source_of_truth",
        claim_key_status: "tentative",
        claim_key_source: "deterministic_repair",
      }),
    ]);

    expect(detectClaimKeySingletonAliasCandidatesFromStats(stats)).toEqual([]);
  });
});

function buildEntry(overrides: Partial<Durable> & Pick<Durable, "id" | "subject" | "claim_key">): Durable {
  return {
    id: overrides.id,
    type: overrides.type ?? "fact",
    subject: overrides.subject,
    content: overrides.content ?? overrides.subject,
    importance: overrides.importance ?? 5,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: undefined,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.6,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    user_id: overrides.user_id,
    project: overrides.project,
    created_at: overrides.created_at ?? "2026-04-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-01T00:00:00.000Z",
  };
}
