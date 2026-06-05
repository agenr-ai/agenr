import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { listActiveAbstainDirectives } from "../../../src/adapters/db/directives-repository.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";
import type { Durable } from "../../../src/core/types.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

describe("listActiveAbstainDirectives", () => {
  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("returns active, currently valid memory directives only", async () => {
    const database = await createTestDatabase();

    const activeDirective = createEntry({
      id: "dir-active",
      subject: "memory directive",
      content: "Do not mention Stan.",
      claim_key: "user/memory_directive/do_not_mention_stan",
    });
    const expiredDirective = createEntry({
      id: "dir-expired",
      subject: "memory directive",
      content: "Do not mention the move.",
      claim_key: "user/memory_directive/do_not_mention_move",
      valid_to: "2000-01-01T00:00:00.000Z",
    });
    const retiredDirective = createEntry({
      id: "dir-retired",
      subject: "memory directive",
      content: "Do not mention the layoff.",
      claim_key: "user/memory_directive/do_not_mention_layoff",
      retired: true,
      retired_at: "2026-01-01T00:00:00.000Z",
      retired_reason: "no longer relevant",
    });
    const regularFact = createEntry({
      id: "fact-1",
      subject: "home",
      content: "Lives in Lisbon.",
      claim_key: "user/location/home",
    });

    await database.insertDurable(activeDirective, [], "dir-active-hash");
    await database.insertDurable(expiredDirective, [], "dir-expired-hash");
    await database.insertDurable(retiredDirective, [], "dir-retired-hash");
    await database.insertDurable(regularFact, [], "fact-1-hash");

    const directives = await listActiveAbstainDirectives(database);

    expect(directives.map((entry) => entry.id)).toEqual(["dir-active"]);
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-directives-db-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
  const now = "2026-03-01T00:00:00.000Z";
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "preference",
    subject: overrides.subject ?? "subject",
    content: overrides.content ?? "content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "core",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    claim_key_status: overrides.claim_key_status,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? overrides.created_at ?? now,
  };
}
