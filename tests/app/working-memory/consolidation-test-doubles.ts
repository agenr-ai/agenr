import { randomUUID } from "node:crypto";

import type { CreateProcedureProposalInput, ProcedureProposalRecord, ProcedureProposalRepository } from "../../../src/app/procedures/proposals/repository.js";
import type { RecordWorkingSetCandidateConsolidationInput, WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingDurableCandidate } from "../../../src/app/working-memory/snapshot.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import type { DatabasePort, EmbeddingPort } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";

/** Builds one pending semantic candidate. */
export function semanticCandidate(overrides: Partial<WorkingDurableCandidate> = {}): WorkingDurableCandidate {
  return {
    kind: "semantic",
    subject: overrides.subject ?? "Release cadence decision",
    content: overrides.content ?? "Releases ship on the first Tuesday of each month.",
    provenance: overrides.provenance ?? { evidenceEventSequences: [3, 5], sourceRef: "goal:release" },
    promotionStatus: overrides.promotionStatus ?? "pending",
    ...(overrides.suggestedClaimKey ? { suggestedClaimKey: overrides.suggestedClaimKey } : {}),
    ...(overrides.suggestedKind ? { suggestedKind: overrides.suggestedKind } : {}),
  };
}

/** Builds one pending procedural candidate. */
export function proceduralCandidate(overrides: Partial<WorkingDurableCandidate> = {}): WorkingDurableCandidate {
  return {
    kind: "procedural",
    subject: overrides.subject ?? "Release the agenr packages",
    content: overrides.content ?? "Run pnpm check, bump versions, publish all three packages.",
    provenance: overrides.provenance ?? { evidenceEventSequences: [3, 5] },
    promotionStatus: overrides.promotionStatus ?? "pending",
  };
}

/** Builds a deterministic embedding stub. */
export function createStubEmbedding(): EmbeddingPort {
  return {
    embed: async (texts) => texts.map((_, index) => [index + 1, index + 2]),
  };
}

/** Capture wrapper around a working-memory repository double. */
export interface CapturingWorkingMemoryRepository {
  /** Repository double backed by one in-memory working set. */
  repository: WorkingMemoryRepository;
  /** Consolidation writes recorded by the double. */
  consolidationWrites: RecordWorkingSetCandidateConsolidationInput[];
  /** When set, consolidation writes fail with this result. */
  failWith?: { kind: "revision_conflict"; actualRevision: number };
}

/** Builds a working-memory repository double that captures consolidation writes. */
export function createCapturingWorkingMemoryRepository(workingSet: WorkingSetRecord): CapturingWorkingMemoryRepository {
  const consolidationWrites: RecordWorkingSetCandidateConsolidationInput[] = [];
  const capture: CapturingWorkingMemoryRepository = {
    consolidationWrites,
    repository: {
      getWorkingSet: async (id) => (id === workingSet.id ? workingSet : null),
      findCurrentWorkingSets: async () => [],
      listWorkingSets: async () => [],
      listWorkingEvents: async () => [],
      createWorkingSet: async () => ({ kind: "active_set_exists", scopeKey: "test" }),
      updateWorkingSet: async () => ({ kind: "not_found" }),
      patchWorkingSetUsage: async () => ({ kind: "not_found" }),
      patchWorkingSetUsageAndUpdate: async () => ({ kind: "not_found" }),
      recordEpisodePromotion: async () => ({ kind: "not_found" }),
      recordCandidateConsolidation: async (input) => {
        if (capture.failWith) {
          return capture.failWith;
        }

        consolidationWrites.push(input);
        return {
          workingSet: { ...workingSet, snapshot: input.snapshot, updatedAt: input.now },
          event: {
            id: randomUUID(),
            workingSetId: workingSet.id,
            sequence: 99,
            eventType: "consolidated",
            payload: input.auditEvent.payload,
            createdAt: input.now,
          },
        };
      },
    },
  };

  return capture;
}

/** Builds an in-memory procedure-proposal repository double. */
export function createInMemoryProposalRepository(): { repository: ProcedureProposalRepository; records: ProcedureProposalRecord[] } {
  const records: ProcedureProposalRecord[] = [];

  const createProposal = async (input: CreateProcedureProposalInput): Promise<ProcedureProposalRecord> => {
    const record: ProcedureProposalRecord = {
      id: randomUUID(),
      workingSetId: input.workingSetId,
      candidateFingerprint: input.candidateFingerprint,
      subject: input.subject,
      content: input.content,
      evidenceEventSequences: input.evidenceEventSequences,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      status: "open",
      createdAt: input.now,
    };
    records.push(record);
    return record;
  };

  return {
    records,
    repository: {
      getProposal: async (id) => records.find((record) => record.id === id) ?? null,
      listProposals: async () => [...records],
      findProposalByFingerprint: async (workingSetId, fingerprint) =>
        records.find((record) => record.workingSetId === workingSetId && record.candidateFingerprint === fingerprint) ?? null,
      createProposal,
      reviewProposal: async () => ({ kind: "not_found" }),
    },
  };
}

/** Minimal database port double for the store pipeline. */
export class ConsolidationMockDatabase implements DatabasePort {
  public readonly insertions: Durable[] = [];
  public readonly existingHashes = new Set<string>();

  public async insertDurable(durable: Durable): Promise<string> {
    this.insertions.push(durable);
    return durable.id;
  }

  public async prepareForBulkWrites(): Promise<void> {}

  public async finalizeBulkWrites(): Promise<void> {}

  public async getDurables(): Promise<Durable[]> {
    return [];
  }

  public async getDurable(): Promise<Durable | null> {
    return null;
  }

  public async findExistingHashes(hashes: string[]): Promise<Set<string>> {
    return new Set(hashes.filter((hash) => this.existingHashes.has(hash)));
  }

  public async findExistingNormHashes(): Promise<Set<string>> {
    return new Set();
  }

  public async closeDurableValidity(): Promise<boolean> {
    return true;
  }

  public async supersedeDurable(): Promise<boolean> {
    return true;
  }

  public async findActiveDurablesByClaimKey(): Promise<Durable[]> {
    return [];
  }

  public async findSimilarActiveDurables(): Promise<Array<{ durable: Durable; similarity: number }>> {
    return [];
  }

  public async getDistinctClaimKeyPrefixes(): Promise<string[]> {
    return [];
  }

  public async updateDurable(): Promise<boolean> {
    return true;
  }

  public async getIngestLogEntry(): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return null;
  }

  public async insertIngestLogEntry(): Promise<void> {}

  public async init(): Promise<void> {}

  public async close(): Promise<void> {}
}
