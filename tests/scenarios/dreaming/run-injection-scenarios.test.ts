import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { listActiveAbstainDirectives } from "../../../src/adapters/db/directives-repository.js";
import { createRecallAdapter } from "../../../src/adapters/db/recall-adapter.js";
import { createSessionStartRepository } from "../../../src/adapters/db/session-start-repository.js";
import { runBeforeTurn } from "../../../src/app/before-turn/index.js";
import type { BeforeTurnPolicy } from "../../../src/app/before-turn/index.js";
import { runSessionStart } from "../../../src/app/session-start/index.js";
import type { SessionStartPolicy } from "../../../src/app/session-start/index.js";
import type { EmbeddingPort } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

/**
 * Fixture-backed injection scenarios for the dreaming program.
 *
 * Each JSON fixture in this directory seeds a real (lexical-only) recall stack
 * and runs the production session-start or before-turn service against it. The
 * scenarios are the runnable skeleton the `agenr-evals` injection-filtering and
 * directive-abstention suites build on. They prove, end to end, that expired or
 * not-yet-valid durables never auto-inject and that abstain directives suppress
 * blocked topics.
 */

interface ScenarioDurable {
  id: string;
  subject: string;
  content: string;
  type?: Durable["type"];
  expiry?: Durable["expiry"];
  importance?: number;
  claim_key?: string;
  claim_key_status?: Durable["claim_key_status"];
  valid_from?: string;
  valid_to?: string;
  superseded_by?: string;
  retired?: boolean;
  created_at?: string;
}

interface ScenarioExpectation {
  injectedEntryIds?: string[];
  includesEntryIds?: string[];
  excludesEntryIds?: string[];
  directiveAbstentions?: Array<{ entryId: string; reason: string; directiveId?: string; blockedTerm?: string }>;
}

interface DreamingScenario {
  id: string;
  description: string;
  kind: "before_turn" | "session_start";
  now: string;
  durables: ScenarioDurable[];
  directives?: ScenarioDurable[];
  beforeTurn?: { currentTurnText: string; recentTurns?: Array<{ role: "user" | "assistant"; text: string }> };
  sessionStart?: { continuitySummaryText?: string; recentSessionText?: string; policy?: SessionStartPolicy };
  policy?: BeforeTurnPolicy;
  expect: ScenarioExpectation;
}

const scenariosDir = path.dirname(fileURLToPath(import.meta.url));
const scenarios = loadScenarios(scenariosDir);

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

const throwingEmbedding: EmbeddingPort = {
  async embed(): Promise<number[][]> {
    throw new Error("Embeddings are disabled in the dreaming scenario harness; lexical recall only.");
  },
};

describe("dreaming injection scenarios", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      // Fake only Date so libSQL's async I/O and any internal timers keep working.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(scenario.now));

      const database = await createTestDatabase();
      await seedDurables(database, [...scenario.durables, ...(scenario.directives ?? [])]);
      const recall = createRecallAdapter(database, throwingEmbedding);

      const injectedEntryIds = await runScenario(scenario, database, recall);

      assertExpectations(scenario, injectedEntryIds);
    });
  }
});

/**
 * Runs one scenario against the seeded recall stack and returns the injected ids.
 */
async function runScenario(scenario: DreamingScenario, database: SqlDatabase, recall: ReturnType<typeof createRecallAdapter>): Promise<string[]> {
  const fetchDirectives = (): Promise<Durable[]> => listActiveAbstainDirectives(database);

  if (scenario.kind === "before_turn") {
    if (!scenario.beforeTurn) {
      throw new Error(`Scenario ${scenario.id} is kind before_turn but has no beforeTurn input.`);
    }

    const result = await runBeforeTurn(
      {
        currentTurnText: scenario.beforeTurn.currentTurnText,
        ...(scenario.beforeTurn.recentTurns ? { recentTurns: scenario.beforeTurn.recentTurns } : {}),
        ...(scenario.policy ? { policy: scenario.policy } : {}),
      },
      {
        recall,
        procedures: database,
        listActiveAbstainDirectives: fetchDirectives,
      },
    );

    assertDirectiveAbstentions(scenario, result.diagnostics.directiveAbstentions);
    return result.durableMemory.map((item) => item.entry.id);
  }

  const result = await runSessionStart(
    {
      ...(scenario.sessionStart?.continuitySummaryText ? { continuitySummaryText: scenario.sessionStart.continuitySummaryText } : {}),
      ...(scenario.sessionStart?.recentSessionText ? { recentSessionText: scenario.sessionStart.recentSessionText } : {}),
      ...(scenario.sessionStart?.policy ? { policy: scenario.sessionStart.policy } : {}),
    },
    {
      repository: createSessionStartRepository(database),
      recall,
      listActiveAbstainDirectives: fetchDirectives,
    },
  );

  assertDirectiveAbstentions(scenario, result.diagnostics.directiveAbstentions);
  return result.durableMemory.map((item) => item.entry.id);
}

/**
 * Asserts the injection expectations for one scenario.
 */
function assertExpectations(scenario: DreamingScenario, injectedEntryIds: string[]): void {
  if (scenario.expect.injectedEntryIds) {
    expect([...injectedEntryIds].sort()).toEqual([...scenario.expect.injectedEntryIds].sort());
  }

  for (const id of scenario.expect.includesEntryIds ?? []) {
    expect(injectedEntryIds).toContain(id);
  }

  for (const id of scenario.expect.excludesEntryIds ?? []) {
    expect(injectedEntryIds).not.toContain(id);
  }
}

/**
 * Asserts the directive-abstention expectations for one scenario when present.
 */
function assertDirectiveAbstentions(
  scenario: DreamingScenario,
  actual: Array<{ entryId: string; reason: string; directiveId?: string; blockedTerm?: string }> | undefined,
): void {
  if (!scenario.expect.directiveAbstentions) {
    return;
  }

  expect(actual).toBeDefined();
  for (const expected of scenario.expect.directiveAbstentions) {
    expect(actual).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  }
}

/**
 * Loads and parses every scenario JSON fixture in the directory.
 */
function loadScenarios(directory: string): DreamingScenario[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(path.join(directory, file), "utf8")) as DreamingScenario);
}

/**
 * Inserts scenario durables into the database with deterministic defaults.
 */
async function seedDurables(database: SqlDatabase, durables: ScenarioDurable[]): Promise<void> {
  for (const durable of durables) {
    await database.insertDurable(toDurable(durable), [], `${durable.id}-hash`);
  }
}

/**
 * Expands a fixture durable into a full Durable row.
 */
function toDurable(durable: ScenarioDurable): Durable {
  const createdAt = durable.created_at ?? "2026-03-01T00:00:00.000Z";
  return {
    id: durable.id,
    type: durable.type ?? "fact",
    subject: durable.subject,
    content: durable.content,
    importance: durable.importance ?? 7,
    expiry: durable.expiry ?? "permanent",
    tags: [],
    quality_score: 0.5,
    recall_count: 0,
    superseded_by: durable.superseded_by,
    valid_from: durable.valid_from,
    valid_to: durable.valid_to,
    claim_key: durable.claim_key,
    claim_key_status: durable.claim_key_status,
    retired: durable.retired ?? false,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-dreaming-scenario-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}
