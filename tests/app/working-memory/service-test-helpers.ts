import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createWorkingMemoryRepository } from "../../../src/adapters/db/working-memory-repository.js";
import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";
import type { WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import { closeTestDatabase, removeTestPath } from "../../helpers/temp-paths.js";

/** Options accepted by the working-memory service test helper. */
export interface CreateWorkingMemoryTestServiceOptions {
  /** Whether goal working sets are enabled for the test service. */
  goalWorkingSetsEnabled?: boolean;
}

/** Creates an isolated working-memory service backed by a temp database. */
export async function createWorkingMemoryTestService(options: CreateWorkingMemoryTestServiceOptions = {}): Promise<{
  database: SqlDatabase;
  dbPath: string;
  repository: WorkingMemoryRepository;
  service: ReturnType<typeof createWorkingMemoryService>;
}> {
  const dbPath = path.join(os.tmpdir(), `agenr-working-memory-${randomUUID()}.sqlite`);
  const database = await createDatabase(dbPath);
  const repository = createWorkingMemoryRepository(database);
  const service = createWorkingMemoryService(
    { workingMemory: true },
    {
      repository,
      sourceLabel: "test",
      now: () => new Date("2026-05-30T12:00:00.000Z"),
      ...(options.goalWorkingSetsEnabled === undefined ? {} : { goalWorkingSetsEnabled: options.goalWorkingSetsEnabled }),
    },
  );

  return { database, dbPath, repository, service };
}

/** Closes and removes one temp working-memory database. */
export async function closeWorkingMemoryTestService(database: SqlDatabase, dbPath: string): Promise<void> {
  await closeTestDatabase(database);
  await removeTestPath(dbPath);
}

/** Builds one working-set record for projection-focused service tests. */
export function createTestWorkingSet(input: Pick<WorkingSetRecord, "id" | "scopeKind" | "scopeKey"> & Partial<WorkingSetRecord>): WorkingSetRecord {
  return {
    id: input.id,
    scopeKind: input.scopeKind,
    scopeKey: input.scopeKey,
    status: input.status ?? "active",
    snapshot: input.snapshot ?? {},
    revision: input.revision ?? 1,
    createdAt: input.createdAt ?? "2026-05-30T12:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-30T12:00:00.000Z",
    lastActiveAt: input.lastActiveAt ?? "2026-05-30T12:00:00.000Z",
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.project !== undefined ? { project: input.project } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.conversationKey !== undefined ? { conversationKey: input.conversationKey } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.gitRoot !== undefined ? { gitRoot: input.gitRoot } : {}),
    ...(input.gitBranch !== undefined ? { gitBranch: input.gitBranch } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.closedAt !== undefined ? { closedAt: input.closedAt } : {}),
    ...(input.closeReason !== undefined ? { closeReason: input.closeReason } : {}),
    ...(input.episodeId !== undefined ? { episodeId: input.episodeId } : {}),
  };
}

/** Builds a repository double for projection bundle tests. */
export function createProjectionRepository(session: WorkingSetRecord, goals: WorkingSetRecord[]): WorkingMemoryRepository {
  return {
    getWorkingSet: async () => null,
    findCurrentWorkingSets: async (scope) => (scope.scopeKind === "session" ? [session] : goals),
    listWorkingSets: async () => [],
    listWorkingEvents: async () => [],
    createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
    updateWorkingSet: async () => ({ kind: "not_found" }),
    patchWorkingSetUsage: async () => ({ kind: "not_found" }),
    patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
    recordEpisodePromotion: async () => ({ kind: "not_found" }),
    recordCandidateConsolidation: async () => ({ kind: "not_found" }),
  };
}
