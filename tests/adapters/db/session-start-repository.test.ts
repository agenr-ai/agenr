import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createSessionStartRepository } from "../../../src/adapters/db/session-start-repository.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";
import type { Durable } from "../../../src/core/types.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

describe("createSessionStartRepository.listCoreEntries", () => {
  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("excludes expired and not-yet-valid core durables from automatic injection", async () => {
    const database = await createTestDatabase();

    const openCore = createEntry({ id: "core-open", subject: "open core", content: "Always valid core fact.", expiry: "core" });
    const validCore = createEntry({
      id: "core-valid",
      subject: "valid core",
      content: "Core fact valid across a wide window.",
      expiry: "core",
      valid_from: "2000-01-01T00:00:00.000Z",
      valid_to: "2999-01-01T00:00:00.000Z",
    });
    const expiredCore = createEntry({
      id: "core-expired",
      subject: "expired core",
      content: "Core fact whose validity has lapsed.",
      expiry: "core",
      valid_to: "2000-01-01T00:00:00.000Z",
    });
    const futureCore = createEntry({
      id: "core-future",
      subject: "future core",
      content: "Core fact not yet valid.",
      expiry: "core",
      valid_from: "2999-01-01T00:00:00.000Z",
    });
    const nonCore = createEntry({ id: "permanent-1", subject: "permanent", content: "Permanent, non-core fact.", expiry: "permanent" });

    await database.insertDurable(openCore, [], "core-open-hash");
    await database.insertDurable(validCore, [], "core-valid-hash");
    await database.insertDurable(expiredCore, [], "core-expired-hash");
    await database.insertDurable(futureCore, [], "core-future-hash");
    await database.insertDurable(nonCore, [], "permanent-hash");

    const repository = createSessionStartRepository(database);
    const coreEntries = await repository.listCoreEntries(10);

    expect(coreEntries.map((entry) => entry.id).sort()).toEqual(["core-open", "core-valid"]);
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-session-start-db-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
  const now = "2026-03-01T00:00:00.000Z";
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "fact",
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
