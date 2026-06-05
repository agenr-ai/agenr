import { createClient, type Client, type InArgs, type InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  BULK_WRITE_STATE_META_KEY,
  PROCEDURE_VECTOR_INDEX_NAME,
  DURABLE_VECTOR_INDEX_NAME,
  finalizeBulkWrites,
  getLastBulkIngestAt,
  initSchema,
  prepareBulkWrites,
} from "../../../src/adapters/db/schema.js";

const FTS_REBUILD_SQLS = ["INSERT INTO durables_fts(durables_fts) VALUES ('rebuild')", "INSERT INTO procedures_fts(procedures_fts) VALUES ('rebuild')"];

describe("initSchema", () => {
  const clients: Array<ReturnType<typeof createClient>> = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("creates the core tables and FTS triggers", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);

    const tablesResult = await client.execute({
      sql: `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'durables',
            'durables_fts',
            'ingest_log',
            'episodes',
            'procedures',
            'procedures_fts',
            'recall_events',
            'dream_runs',
            'dream_run_actions',
            'dream_proposals',
            'dream_state',
            'profile_snapshots',
            'working_sets',
            'working_events',
            'session_lineage_edges',
            'session_artifacts',
            '_meta'
          )
      `,
    });
    const tableNames = new Set(
      tablesResult.rows.map((row) => {
        const value = row.name;
        return typeof value === "string" ? value : "";
      }),
    );

    expect(tableNames).toEqual(
      new Set([
        "durables",
        "durables_fts",
        "ingest_log",
        "episodes",
        "procedures",
        "procedures_fts",
        "recall_events",
        "dream_runs",
        "dream_run_actions",
        "dream_proposals",
        "dream_state",
        "profile_snapshots",
        "working_sets",
        "working_events",
        "session_lineage_edges",
        "session_artifacts",
        "_meta",
      ]),
    );
    expect(await tableColumns(client, "durables")).toEqual([
      "id",
      "type",
      "subject",
      "content",
      "importance",
      "expiry",
      "tags",
      "source_file",
      "source_context",
      "embedding",
      "content_hash",
      "norm_content_hash",
      "minhash_sig",
      "quality_score",
      "recall_count",
      "last_recalled_at",
      "superseded_by",
      "valid_from",
      "valid_to",
      "claim_key",
      "claim_key_raw",
      "claim_key_status",
      "claim_key_source",
      "claim_key_confidence",
      "claim_key_rationale",
      "claim_support_source_kind",
      "claim_support_locator",
      "claim_support_observed_at",
      "claim_support_mode",
      "supersession_kind",
      "supersession_reason",
      "cluster_id",
      "user_id",
      "project",
      "retired",
      "retired_at",
      "retired_reason",
      "created_at",
      "updated_at",
    ]);
    expect(await tableColumns(client, "episodes")).toEqual([
      "id",
      "source",
      "source_id",
      "source_ref",
      "transcript_hash",
      "summary_hash",
      "agent_id",
      "surface",
      "started_at",
      "ended_at",
      "summary",
      "tags",
      "activity_level",
      "user_id",
      "project",
      "gen_model",
      "gen_version",
      "message_count",
      "embedding",
      "retired",
      "retired_at",
      "retired_reason",
      "superseded_by",
      "created_at",
      "updated_at",
    ]);
    expect(await tableColumns(client, "procedures")).toEqual([
      "id",
      "procedure_key",
      "title",
      "goal",
      "body_json",
      "recall_text",
      "source_file",
      "source_hash",
      "revision_hash",
      "embedding",
      "retired",
      "retired_at",
      "retired_reason",
      "superseded_by",
      "created_at",
      "updated_at",
    ]);
    const triggersResult = await client.execute({
      sql: `
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN ('durables_ai', 'durables_ad', 'durables_au', 'procedures_ai', 'procedures_ad', 'procedures_au')
      `,
    });
    const triggerNames = new Set(
      triggersResult.rows.map((row) => {
        const value = row.name;
        return typeof value === "string" ? value : "";
      }),
    );

    expect(triggerNames).toEqual(new Set(["durables_ai", "durables_ad", "durables_au", "procedures_ai", "procedures_ad", "procedures_au"]));
    expect(await tableColumns(client, "dream_runs")).toEqual([
      "id",
      "tier",
      "project",
      "started_at",
      "completed_at",
      "status",
      "input_tokens",
      "output_tokens",
      "estimated_cost_usd",
      "model",
      "actions_taken",
      "actions_skipped",
      "durables_retired",
      "summary",
      "summary_json",
      "error",
      "dry_run",
      "config_json",
    ]);
    expect(await tableColumns(client, "dream_run_actions")).toEqual([
      "id",
      "run_id",
      "action_type",
      "durable_id",
      "durable_ids",
      "reasoning",
      "evidence_refs_json",
      "recall_delta",
      "details_json",
      "created_at",
    ]);
    expect(await tableColumns(client, "dream_proposals")).toEqual([
      "id",
      "run_id",
      "group_id",
      "issue_kind",
      "scope",
      "durable_ids",
      "current_claim_keys",
      "proposed_claim_keys",
      "rationale",
      "confidence",
      "source",
      "eligible_for_apply",
      "review_status",
      "reviewed_at",
      "review_reason",
      "applied_action_count",
      "created_at",
    ]);
    expect(await tableColumns(client, "dream_state")).toEqual([
      "id",
      "last_successful_run_at",
      "last_scan_cursor_json",
      "active_profile_snapshot_id",
      "unsynthesized_importance_sum",
      "updated_at",
    ]);
    expect(await tableColumns(client, "profile_snapshots")).toEqual(["id", "durable_ids", "directive_ids", "as_of", "content_hash", "run_id", "created_at"]);
    expect(await tableColumns(client, "working_sets")).toEqual([
      "id",
      "scope_key",
      "scope_kind",
      "title",
      "objective",
      "status",
      "summary",
      "snapshot_json",
      "revision",
      "project",
      "session_id",
      "conversation_key",
      "cwd",
      "git_root",
      "git_branch",
      "task_id",
      "source",
      "created_at",
      "updated_at",
      "last_active_at",
      "closed_at",
      "close_reason",
      "episode_id",
    ]);
    expect(await tableColumns(client, "working_events")).toEqual([
      "id",
      "working_set_id",
      "sequence",
      "event_type",
      "payload_json",
      "actor",
      "source",
      "host_event_id",
      "turn_id",
      "created_at",
    ]);
    expect(await tableColumns(client, "session_lineage_edges")).toEqual([
      "id",
      "child_session_key",
      "parent_session_key",
      "parent_source_ref",
      "reason",
      "fork_durable_id",
      "fork_position",
      "observed_at",
    ]);
    expect(await tableColumns(client, "session_artifacts")).toEqual([
      "id",
      "kind",
      "session_key",
      "source",
      "source_id",
      "source_ref",
      "content_hash",
      "summary",
      "metadata_json",
      "created_at",
      "expires_at",
    ]);
    expect(await indexExists(client, "idx_dream_run_actions_run_id")).toBe(true);
    expect(await indexExists(client, "idx_dream_run_actions_durable_id")).toBe(true);
    expect(await indexExists(client, "idx_dream_run_actions_created_at")).toBe(true);
    expect(await indexExists(client, "idx_dream_proposals_run_id")).toBe(true);
    expect(await indexExists(client, "idx_dream_proposals_group_id")).toBe(true);
    expect(await indexExists(client, "idx_dream_proposals_created_at")).toBe(true);
    expect(await indexExists(client, "idx_dream_proposals_review_status")).toBe(true);
    expect(await indexExists(client, "idx_dream_proposals_open_issue")).toBe(true);
    expect(await indexExists(client, "idx_working_sets_status_last_active")).toBe(true);
    expect(await indexExists(client, "idx_working_sets_scope_status")).toBe(true);
    expect(await indexExists(client, "idx_working_events_working_set_created_at")).toBe(true);
    expect(await indexExists(client, "working_sets_one_open_per_scope")).toBe(true);
    expect(await indexExists(client, "idx_session_lineage_edges_child_observed")).toBe(true);
    expect(await indexExists(client, "idx_session_lineage_edges_parent_observed")).toBe(true);
    expect(await indexExists(client, "idx_session_lineage_edges_reason_observed")).toBe(true);
    expect(await indexExists(client, "idx_session_artifacts_session_kind")).toBe(true);
    expect(await indexExists(client, "idx_session_artifacts_source")).toBe(true);
    expect(await indexExists(client, "idx_session_artifacts_source_ref_kind")).toBe(true);
    expect(await indexExists(client, "idx_session_artifacts_content_hash")).toBe(true);
    expect(await indexExists(client, "idx_session_artifacts_expires_at")).toBe(true);
    expect(await indexExists(client, "idx_durables_claim_key")).toBe(true);
    expect(await indexExists(client, "idx_durables_valid_from")).toBe(true);
    expect(await indexExists(client, "idx_durables_valid_to")).toBe(true);
    expect(await indexExists(client, "idx_episodes_started_at")).toBe(true);
    expect(await indexExists(client, "idx_episodes_ended_at")).toBe(true);
    expect(await indexExists(client, "idx_episodes_source")).toBe(true);
    expect(await indexExists(client, "idx_episodes_source_id")).toBe(true);
    expect(await indexExists(client, "idx_episodes_retired")).toBe(true);
    expect(await indexExists(client, "idx_episodes_source_source_id")).toBe(true);
    expect(await indexExists(client, "idx_procedures_procedure_key")).toBe(true);
    expect(await indexExists(client, "idx_procedures_revision_hash")).toBe(true);
    expect(await indexExists(client, "idx_procedures_source_hash")).toBe(true);
    expect(await indexExists(client, "idx_procedures_retired")).toBe(true);
    expect(await indexExists(client, "idx_procedures_created_at")).toBe(true);
    expect(await indexExists(client, "idx_procedures_active_procedure_key")).toBe(true);
  });

  it("is idempotent when episode vector index creation runs more than once", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await expect(initSchema(client)).resolves.toBeUndefined();
    await expect(initSchema(client)).resolves.toBeUndefined();

    const version = await client.execute("SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1");
    expect(version.rows[0]?.value).toBe("1");
    expect(await indexExists(client, "idx_episodes_started_at")).toBe(true);
  });

  it("enforces one active procedure revision per procedure key", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    await insertTestProcedure(client, "procedure-a", "First active revision.", "agenr/release");

    await expect(insertTestProcedure(client, "procedure-b", "Second active revision.", "agenr/release")).rejects.toThrow();
  });

  it("enforces one open working set per scope", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    await insertTestWorkingSet(client, "working-a", "scope:one", "active");

    await expect(insertTestWorkingSet(client, "working-b", "scope:one", "blocked")).rejects.toThrow();
    await expect(insertTestWorkingSet(client, "working-c", "scope:one", "closed")).resolves.toBeUndefined();
  });

  for (const version of ["2", "3", "4", "5", "7", "9", "11", "12"] as const) {
    it(`rejects unsupported schema version ${version}`, async () => {
      const client = createClient({ url: ":memory:" });
      clients.push(client);

      await client.execute("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
      await client.execute({
        sql: `
          INSERT INTO _meta (key, value)
          VALUES ('schema_version', ?)
        `,
        args: [version],
      });

      await expect(initSchema(client)).rejects.toThrow(new RegExp(`schema version "${version}"`, "i"));
      await expect(initSchema(client)).rejects.toThrow(/agenr db reset/i);
    });
  }

  it("rejects an existing database without schema metadata", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await client.execute(`
      CREATE TABLE dream_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        actions_taken INTEGER DEFAULT 0,
        summary TEXT
      )
    `);

    await expect(initSchema(client)).rejects.toThrow(/without schema metadata/i);
    expect(await tableColumns(client, "dream_run_actions")).toEqual([]);
  });

  it("rebuilds FTS on first initialization", async () => {
    const tracker = createTrackedClient();
    clients.push(tracker.client);

    await initSchema(tracker.trackedClient);

    expect(tracker.rebuildCount()).toBe(2);
  });

  it("skips the FTS rebuild when the schema version is unchanged", async () => {
    const tracker = createTrackedClient();
    clients.push(tracker.client);

    await initSchema(tracker.trackedClient);
    tracker.reset();

    await initSchema(tracker.trackedClient);

    expect(tracker.rebuildCount()).toBe(0);
  });

  it("is idempotent when initSchema runs multiple times on an initialized database", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    await initSchema(client);

    expect(await tableColumns(client, "dream_runs")).toEqual([
      "id",
      "tier",
      "project",
      "started_at",
      "completed_at",
      "status",
      "input_tokens",
      "output_tokens",
      "estimated_cost_usd",
      "model",
      "actions_taken",
      "actions_skipped",
      "durables_retired",
      "summary",
      "summary_json",
      "error",
      "dry_run",
      "config_json",
    ]);
    expect(await tableColumns(client, "dream_run_actions")).toEqual([
      "id",
      "run_id",
      "action_type",
      "durable_id",
      "durable_ids",
      "reasoning",
      "evidence_refs_json",
      "recall_delta",
      "details_json",
      "created_at",
    ]);
    expect(await tableColumns(client, "dream_proposals")).toEqual([
      "id",
      "run_id",
      "group_id",
      "issue_kind",
      "scope",
      "durable_ids",
      "current_claim_keys",
      "proposed_claim_keys",
      "rationale",
      "confidence",
      "source",
      "eligible_for_apply",
      "review_status",
      "reviewed_at",
      "review_reason",
      "applied_action_count",
      "created_at",
    ]);
  });

  it("rejects a database whose stored schema version changes away from the current version", async () => {
    const tracker = createTrackedClient();
    clients.push(tracker.client);

    await initSchema(tracker.trackedClient);
    await tracker.client.execute({
      sql: `
        UPDATE _meta
        SET value = '0'
        WHERE key = 'schema_version'
      `,
    });
    tracker.reset();

    await expect(initSchema(tracker.trackedClient)).rejects.toThrow(/schema version "0"/i);
    expect(tracker.rebuildCount()).toBe(0);
  });

  it("drops FTS triggers during bulk-write preparation and restores searchability on finalize", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    const vectorIndexExisted = await indexExists(client, DURABLE_VECTOR_INDEX_NAME);
    const procedureVectorIndexExisted = await indexExists(client, PROCEDURE_VECTOR_INDEX_NAME);

    await prepareBulkWrites(client);

    expect(await triggerNames(client)).toEqual(new Set());
    expect(await indexExists(client, DURABLE_VECTOR_INDEX_NAME)).toBe(false);
    expect(await indexExists(client, PROCEDURE_VECTOR_INDEX_NAME)).toBe(false);

    await insertTestEntry(client, "entry-1", "Bulk finalize restores FTS searchability.");
    await insertTestProcedure(client, "procedure-1", "Bulk finalize restores procedure FTS searchability.");

    const beforeFinalize = await client.execute({
      sql: "SELECT rowid FROM durables_fts WHERE durables_fts MATCH 'searchability'",
    });
    expect(beforeFinalize.rows).toHaveLength(0);
    const procedureBeforeFinalize = await client.execute({
      sql: "SELECT rowid FROM procedures_fts WHERE procedures_fts MATCH 'searchability'",
    });
    expect(procedureBeforeFinalize.rows).toHaveLength(0);

    await finalizeBulkWrites(client);

    expect(await triggerNames(client)).toEqual(new Set(["durables_ai", "durables_ad", "durables_au", "procedures_ai", "procedures_ad", "procedures_au"]));
    expect(await indexExists(client, DURABLE_VECTOR_INDEX_NAME)).toBe(vectorIndexExisted);
    expect(await indexExists(client, PROCEDURE_VECTOR_INDEX_NAME)).toBe(procedureVectorIndexExisted);
    const lastBulkIngestAt = await getLastBulkIngestAt(client);
    expect(lastBulkIngestAt).toEqual(expect.any(String));
    expect(Date.parse(lastBulkIngestAt ?? "")).not.toBeNaN();

    const afterFinalize = await client.execute({
      sql: "SELECT rowid FROM durables_fts WHERE durables_fts MATCH 'searchability'",
    });
    expect(afterFinalize.rows).toHaveLength(1);
    const procedureAfterFinalize = await client.execute({
      sql: "SELECT rowid FROM procedures_fts WHERE procedures_fts MATCH 'searchability'",
    });
    expect(procedureAfterFinalize.rows).toHaveLength(1);
  });

  it("recovers and finalizes an interrupted bulk-write state during schema init", async () => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);

    await initSchema(client);
    await prepareBulkWrites(client);
    await insertTestEntry(client, "entry-2", "Crash recovery should rebuild FTS and clear dirty bulk state.");
    await insertTestProcedure(client, "procedure-2", "Crash recovery should rebuild procedure FTS and clear dirty bulk state.");

    await initSchema(client);

    expect(await triggerNames(client)).toEqual(new Set(["durables_ai", "durables_ad", "durables_au", "procedures_ai", "procedures_ad", "procedures_au"]));

    const recovered = await client.execute({
      sql: "SELECT rowid FROM durables_fts WHERE durables_fts MATCH 'dirty'",
    });
    expect(recovered.rows).toHaveLength(1);
    const recoveredProcedure = await client.execute({
      sql: "SELECT rowid FROM procedures_fts WHERE procedures_fts MATCH 'dirty'",
    });
    expect(recoveredProcedure.rows).toHaveLength(1);

    const meta = await client.execute({
      sql: "SELECT value FROM _meta WHERE key = ?",
      args: [BULK_WRITE_STATE_META_KEY],
    });
    expect(meta.rows).toHaveLength(0);
    const lastBulkIngestAt = await getLastBulkIngestAt(client);
    expect(lastBulkIngestAt).toEqual(expect.any(String));
    expect(Date.parse(lastBulkIngestAt ?? "")).not.toBeNaN();
  });
});

function createTrackedClient(): {
  client: ReturnType<typeof createClient>;
  trackedClient: Client;
  rebuildCount: () => number;
  reset: () => void;
} {
  const client = createClient({ url: ":memory:" });
  let rebuilds = 0;

  const trackedClient = {
    execute: async (statement: InStatement | string, args?: InArgs) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (FTS_REBUILD_SQLS.some((rebuildSql) => sql.includes(rebuildSql))) {
        rebuilds += 1;
      }

      return typeof statement === "string" ? client.execute(statement, args) : client.execute(statement);
    },
    close: () => {
      client.close();
    },
  } as unknown as Client;

  return {
    client,
    trackedClient,
    rebuildCount: () => rebuilds,
    reset: () => {
      rebuilds = 0;
    },
  };
}

async function insertTestEntry(client: Client, id: string, content: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO durables (
        id,
        type,
        subject,
        content,
        importance,
        expiry,
        tags,
        source_file,
        source_context,
        embedding,
        content_hash,
        norm_content_hash,
        minhash_sig,
        quality_score,
        recall_count,
        last_recalled_at,
        superseded_by,
        cluster_id,
        retired,
        retired_at,
        retired_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      "fact",
      "bulk write",
      content,
      7,
      "permanent",
      "[]",
      "/tmp/session.jsonl",
      null,
      null,
      `hash-${id}`,
      `norm-${id}`,
      null,
      0.5,
      0,
      null,
      null,
      null,
      0,
      null,
      null,
      "2026-03-26T00:00:00.000Z",
      "2026-03-26T00:00:00.000Z",
    ],
  });
}

async function insertTestProcedure(client: Client, id: string, content: string, procedureKey = `agenr/${id}`): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO procedures (
        id,
        procedure_key,
        title,
        goal,
        body_json,
        recall_text,
        source_file,
        source_hash,
        revision_hash,
        embedding,
        retired,
        retired_at,
        retired_reason,
        superseded_by,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      procedureKey,
      "Bulk procedure",
      "Exercise procedure FTS rebuilds.",
      JSON.stringify({
        procedure_key: procedureKey,
        title: "Bulk procedure",
        goal: "Exercise procedure FTS rebuilds.",
        when_to_use: [],
        when_not_to_use: [],
        prerequisites: [],
        steps: [
          {
            id: "step-1",
            kind: "run_command",
            instruction: "Rebuild procedure searchability.",
            command: "pnpm check",
          },
        ],
        verification: ["Procedure searchability is restored."],
        failure_modes: ["FTS rebuild is skipped."],
        sources: [{ kind: "manual", label: "bulk write fixture" }],
      }),
      content,
      "/tmp/procedures/bulk.yaml",
      `source-${id}`,
      `revision-${id}`,
      null,
      0,
      null,
      null,
      null,
      "2026-03-26T00:00:00.000Z",
      "2026-03-26T00:00:00.000Z",
    ],
  });
}

async function insertTestWorkingSet(client: Client, id: string, scopeKey: string, status: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO working_sets (
        id,
        scope_key,
        scope_kind,
        status,
        snapshot_json,
        revision,
        created_at,
        updated_at,
        last_active_at,
        closed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      scopeKey,
      "conversation",
      status,
      JSON.stringify({ objective: `Objective ${id}` }),
      1,
      "2026-05-30T00:00:00.000Z",
      "2026-05-30T00:00:00.000Z",
      "2026-05-30T00:00:00.000Z",
      status === "closed" ? "2026-05-30T00:00:00.000Z" : null,
    ],
  });
}

async function triggerNames(client: Client): Promise<Set<string>> {
  const result = await client.execute({
    sql: `
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('durables_ai', 'durables_ad', 'durables_au', 'procedures_ai', 'procedures_ad', 'procedures_au')
    `,
  });

  return new Set(
    result.rows.map((row) => {
      const value = row.name;
      return typeof value === "string" ? value : "";
    }),
  );
}

async function tableColumns(client: Client, tableName: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info('${tableName}')`);

  return result.rows.flatMap((row) => {
    const name = row.name;
    return typeof name === "string" ? [name] : [];
  });
}

async function indexExists(client: Client, indexName: string): Promise<boolean> {
  const result = await client.execute({
    sql: `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'index'
        AND name = ?
      LIMIT 1
    `,
    args: [indexName],
  });

  return result.rows.length > 0;
}
