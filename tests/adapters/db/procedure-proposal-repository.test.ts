import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createProcedureProposalRepository } from "../../../src/adapters/db/procedure-proposal-repository.js";
import type { ProcedureProposalRepository } from "../../../src/app/procedures/proposals/repository.js";
import { closeTestDatabase, removeTestPath } from "../../helpers/temp-paths.js";

const NOW = "2026-06-11T12:00:00.000Z";

describe("procedure proposal repository", () => {
  let database: SqlDatabase;
  let dbPath: string;
  let repository: ProcedureProposalRepository;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agenr-procedure-proposals-${randomUUID()}.sqlite`);
    database = await createDatabase(dbPath);
    repository = createProcedureProposalRepository(database);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    await removeTestPath(dbPath);
  });

  it("creates and loads one open proposal", async () => {
    const created = await repository.createProposal(buildCreateInput());

    expect(created.status).toBe("open");
    expect(created.evidenceEventSequences).toEqual([3, 5]);
    expect(created.sourceRef).toBe("goal:release");

    await expect(repository.getProposal(created.id)).resolves.toEqual(created);
    await expect(repository.findProposalByFingerprint("ws-1", "fingerprint-1")).resolves.toEqual(created);
    await expect(repository.findProposalByFingerprint("ws-1", "other")).resolves.toBeNull();
  });

  it("lists proposals filtered by status", async () => {
    const first = await repository.createProposal(buildCreateInput({ candidateFingerprint: "fp-1" }));
    const second = await repository.createProposal(buildCreateInput({ candidateFingerprint: "fp-2", now: "2026-06-12T12:00:00.000Z" }));
    await repository.reviewProposal({ proposalId: first.id, decision: "rejected", reason: "Not a procedure.", now: NOW });

    const open = await repository.listProposals({ statuses: ["open"] });
    expect(open.map((proposal) => proposal.id)).toEqual([second.id]);

    const all = await repository.listProposals({});
    expect(all).toHaveLength(2);
  });

  it("settles one open proposal and blocks a second review", async () => {
    const created = await repository.createProposal(buildCreateInput());

    const applied = await repository.reviewProposal({
      proposalId: created.id,
      decision: "applied",
      reason: "Looks right.",
      appliedProcedurePath: "proposed/release.yaml",
      now: NOW,
    });
    if ("kind" in applied) {
      throw new Error(`expected applied proposal, got ${applied.kind}`);
    }

    expect(applied.proposal.status).toBe("applied");
    expect(applied.proposal.reviewReason).toBe("Looks right.");
    expect(applied.proposal.reviewedAt).toBe(NOW);
    expect(applied.proposal.appliedProcedurePath).toBe("proposed/release.yaml");

    await expect(repository.reviewProposal({ proposalId: created.id, decision: "rejected", reason: "Changed my mind.", now: NOW })).resolves.toEqual({
      kind: "already_reviewed",
      status: "applied",
    });
  });

  it("returns not_found for unknown proposals", async () => {
    await expect(repository.reviewProposal({ proposalId: "missing", decision: "rejected", reason: "n/a", now: NOW })).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("rejects duplicate fingerprints per working set", async () => {
    await repository.createProposal(buildCreateInput());

    await expect(repository.createProposal(buildCreateInput())).rejects.toThrow(/unique/i);
  });
});

/** Builds one create-proposal input with overridable fields. */
function buildCreateInput(overrides: Partial<Parameters<ProcedureProposalRepository["createProposal"]>[0]> = {}) {
  return {
    workingSetId: overrides.workingSetId ?? "ws-1",
    candidateFingerprint: overrides.candidateFingerprint ?? "fingerprint-1",
    subject: overrides.subject ?? "Release the agenr packages",
    content: overrides.content ?? "Run pnpm check, bump versions, publish.",
    evidenceEventSequences: overrides.evidenceEventSequences ?? [3, 5],
    sourceRef: overrides.sourceRef ?? "goal:release",
    now: overrides.now ?? NOW,
  };
}
