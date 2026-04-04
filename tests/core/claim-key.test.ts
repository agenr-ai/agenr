import { describe, expect, it } from "vitest";

import { compactClaimKey, normalizeClaimKey, normalizeClaimKeySegment, validateExtractedClaimKey } from "../../src/core/claim-key.js";

describe("normalizeClaimKeySegment", () => {
  it("normalizes lowercase snake_case segments", () => {
    expect(normalizeClaimKeySegment(" Home City ")).toBe("home_city");
    expect(normalizeClaimKeySegment("max---connections")).toBe("max_connections");
    expect(normalizeClaimKeySegment("___Version!!!")).toBe("version");
  });
});

describe("normalizeClaimKey", () => {
  it("normalizes canonical valid claim keys", () => {
    expect(normalizeClaimKey("Jim / Home City")).toEqual({
      ok: true,
      value: {
        claimKey: "jim/home_city",
        entity: "jim",
        attribute: "home_city",
      },
    });
    expect(normalizeClaimKey("postgres / max connections")).toEqual({
      ok: true,
      value: {
        claimKey: "postgres/max_connections",
        entity: "postgres",
        attribute: "max_connections",
      },
    });
  });

  it("trims whitespace, lowercases, and collapses punctuation", () => {
    expect(normalizeClaimKey("  React Router / Version!!!  ")).toEqual({
      ok: true,
      value: {
        claimKey: "react_router/version",
        entity: "react_router",
        attribute: "version",
      },
    });
  });

  it("rejects missing separators", () => {
    expect(normalizeClaimKey("timezone")).toEqual({
      ok: false,
      reason: "missing_separator",
    });
  });

  it("rejects extra slash segments", () => {
    expect(normalizeClaimKey("jim/timezone/extra")).toEqual({
      ok: false,
      reason: "too_many_segments",
    });
    expect(normalizeClaimKey("///")).toEqual({
      ok: false,
      reason: "too_many_segments",
    });
  });

  it("rejects empty entity or attribute segments", () => {
    expect(normalizeClaimKey("/timezone")).toEqual({
      ok: false,
      reason: "empty_entity",
    });
    expect(normalizeClaimKey("jim/")).toEqual({
      ok: false,
      reason: "empty_attribute",
    });
  });

  it('rejects "unknown/unknown"', () => {
    expect(normalizeClaimKey("unknown/unknown")).toEqual({
      ok: false,
      reason: "unknown_pair",
    });
  });
});

describe("validateExtractedClaimKey", () => {
  it("rejects self-referential entities", () => {
    const normalized = normalizeClaimKey("we/deployment_process");
    if (!normalized.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(normalized.value)).toMatchObject({
      ok: false,
      reason: "self_referential_entity",
    });
  });

  it("rejects generic attributes", () => {
    const normalized = normalizeClaimKey("project_x/details");
    if (!normalized.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(normalized.value)).toMatchObject({
      ok: false,
      reason: "generic_attribute",
    });
  });

  it("rejects value-shaped attributes", () => {
    const numeric = normalizeClaimKey("router/7");
    const versionLike = normalizeClaimKey("router/v7");
    if (!numeric.ok || !versionLike.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(numeric.value)).toMatchObject({
      ok: false,
      reason: "value_shaped_attribute",
    });
    expect(validateExtractedClaimKey(versionLike.value)).toMatchObject({
      ok: false,
      reason: "value_shaped_attribute",
    });
  });

  it("accepts structurally valid non-generic claim keys", () => {
    const normalized = normalizeClaimKey("jim/timezone");
    if (!normalized.ok) {
      throw new Error("Expected normalized claim key.");
    }

    expect(validateExtractedClaimKey(normalized.value)).toEqual({
      ok: true,
      value: {
        claimKey: "jim/timezone",
        entity: "jim",
        attribute: "timezone",
      },
    });
  });
});

describe("compactClaimKey", () => {
  it("removes duplicated entity wording from the attribute", () => {
    expect(compactClaimKey("changelog/changelog_source_of_truth")).toEqual({
      claimKey: "changelog/source_of_truth",
      entity: "changelog",
      attribute: "source_of_truth",
      compactedFrom: "changelog/changelog_source_of_truth",
      reason: "removed duplicated entity prefix from attribute",
    });
  });

  it("collapses sentence-like relation phrases into stable compact slots", () => {
    expect(compactClaimKey("openclaw/heartbeat_detection_precedes_llm_handoff")).toEqual({
      claimKey: "openclaw/llm_handoff_order",
      entity: "openclaw",
      attribute: "llm_handoff_order",
      compactedFrom: "openclaw/heartbeat_detection_precedes_llm_handoff",
      reason: "collapsed a sentence-like ordering phrase into a stable order slot",
    });
    expect(compactClaimKey("libsql/vector_index_rebuild_requires_embedding_update")).toEqual({
      claimKey: "libsql/embedding_update_requirement",
      entity: "libsql",
      attribute: "embedding_update_requirement",
      compactedFrom: "libsql/vector_index_rebuild_requires_embedding_update",
      reason: "collapsed a sentence-like requirement phrase into a stable requirement slot",
    });
    expect(compactClaimKey("session_continuity_preference/durable_memory_preserves_context_across_sessions")).toEqual({
      claimKey: "session_continuity_preference/context_preservation",
      entity: "session_continuity_preference",
      attribute: "context_preservation",
      compactedFrom: "session_continuity_preference/durable_memory_preserves_context_across_sessions",
      reason: "collapsed a sentence-like preservation phrase into a stable preservation slot",
    });
  });

  it("collapses trigger requirement clauses into trigger_condition", () => {
    expect(compactClaimKey("openclaw_before_prompt_build_hook/requires_real_agent_turn_or_message_to_trigger")).toEqual({
      claimKey: "openclaw_before_prompt_build_hook/trigger_condition",
      entity: "openclaw_before_prompt_build_hook",
      attribute: "trigger_condition",
      compactedFrom: "openclaw_before_prompt_build_hook/requires_real_agent_turn_or_message_to_trigger",
      reason: "collapsed a sentence-like trigger requirement into a stable condition slot",
    });
  });

  it("leaves mixed multi-slot phrases unchanged when compaction would be ambiguous", () => {
    expect(compactClaimKey("changelog/authoritative_source_of_truth_and_archive_workflow_for_release_notes")).toEqual({
      claimKey: "changelog/authoritative_source_of_truth_and_archive_workflow_for_release_notes",
      entity: "changelog",
      attribute: "authoritative_source_of_truth_and_archive_workflow_for_release_notes",
      compactedFrom: null,
      reason: null,
    });
  });
});
