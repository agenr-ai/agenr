import type { Row } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { mapDurableRow } from "../../../src/adapters/db/row-mapping.js";

describe("mapDurableRow", () => {
  it("rejects keyed durables missing claim_key_status", () => {
    expect(() =>
      mapDurableRow({
        length: 0,
        id: "entry-1",
        type: "fact",
        subject: "Jim timezone",
        content: "Jim uses America/Chicago.",
        importance: 7,
        expiry: "temporary",
        tags: "[]",
        source_file: null,
        source_context: null,
        embedding: null,
        content_hash: "hash",
        norm_content_hash: "norm-hash",
        quality_score: 0.5,
        recall_count: 0,
        last_recalled_at: null,
        superseded_by: null,
        valid_from: null,
        valid_to: null,
        claim_key: "jim/timezone",
        claim_key_raw: "Jim/timezone",
        claim_key_status: null,
        claim_key_source: "manual",
        claim_key_confidence: 1,
        claim_key_rationale: "manual claim key supplied by caller",
        claim_support_source_kind: null,
        claim_support_locator: null,
        claim_support_observed_at: null,
        claim_support_mode: "explicit",
        supersession_kind: null,
        supersession_reason: null,
        user_id: null,
        project: null,
        created_at: "2026-04-01T10:00:00.000Z",
        updated_at: "2026-04-01T10:00:00.000Z",
      } as Row),
    ).toThrow(/claim_key_status/i);
  });
});
