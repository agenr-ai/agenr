import { describe, expect, it } from "vitest";

import { buildDreamSessionStoreContext, toDreamSessionStoreDurables } from "../../../src/core/dreaming/session-store-context.js";
import { computeNormContentHash } from "../../../src/core/store/hashing.js";
import type { Durable } from "../../../src/core/types.js";

describe("dream session store context", () => {
  it("maps host-store durables into dedup sets", () => {
    const durable: Durable = {
      id: "d-1",
      type: "fact",
      subject: "user birthday",
      content: "Jim's birthday is March 15.",
      importance: 5,
      expiry: "permanent",
      tags: [],
      quality_score: 0.5,
      recall_count: 0,
      content_hash: "content-hash",
      norm_content_hash: "norm-hash",
      created_at: "2026-04-04T10:30:00.000Z",
      updated_at: "2026-04-04T10:30:00.000Z",
      source_file: "skeln-session:skeln:session:abc:cwd:/tmp/project",
      claim_key: "user/birthday",
    };

    const mapped = toDreamSessionStoreDurables([durable]);
    const context = buildDreamSessionStoreContext(mapped);

    expect(mapped[0]?.claimKey).toBe("user/birthday");
    expect(mapped[0]?.normContentHash).toBe("norm-hash");
    expect(context.claimKeys.has("user/birthday")).toBe(true);
    expect(context.normContentHashes.has("norm-hash")).toBe(true);
  });

  it("computes norm hashes when persisted rows omit them", () => {
    const durable: Durable = {
      id: "d-2",
      type: "preference",
      subject: "Coffee",
      content: "Prefers oat milk in coffee.",
      importance: 5,
      expiry: "permanent",
      tags: [],
      quality_score: 0.5,
      recall_count: 0,
      content_hash: "content-hash",
      created_at: "2026-04-04T10:30:00.000Z",
      updated_at: "2026-04-04T10:30:00.000Z",
      source_file: "skeln-session:skeln:session:abc:cwd:/tmp/project",
    };

    const mapped = toDreamSessionStoreDurables([durable]);
    expect(mapped[0]?.normContentHash).toBe(computeNormContentHash(durable.content));
  });
});
