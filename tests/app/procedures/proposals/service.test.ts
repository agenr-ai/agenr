import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../../src/adapters/db/client.js";
import { createProcedureProposalRepository } from "../../../../src/adapters/db/procedure-proposal-repository.js";
import type { ProcedureProposalRepository } from "../../../../src/app/procedures/proposals/repository.js";
import { applyProcedureProposal, rejectProcedureProposal, renderProcedureProposalDraft } from "../../../../src/app/procedures/proposals/service.js";
import { validateProcedureContent } from "../../../../src/app/web/procedure-editor-service.js";
import type { EmbeddingPort } from "../../../../src/core/ports.js";
import { closeTestDatabase, removeTestPath } from "../../../helpers/temp-paths.js";

const NOW = "2026-06-11T12:00:00.000Z";

describe("renderProcedureProposalDraft", () => {
  it("renders a valid procedure YAML draft with working-set provenance", () => {
    const draft = renderProcedureProposalDraft({
      subject: "Release the agenr packages",
      content: "Run pnpm check, bump versions, publish all three packages.",
      workingSetId: "ws-1",
      evidenceEventSequences: [3, 5],
    });

    expect(draft.procedureKey).toBe("proposed/release-the-agenr-packages");
    expect(draft.relativePath).toBe("proposed/release-the-agenr-packages.yaml");
    expect(draft.content).toContain("working_set:ws-1#events:3,5");

    const validation = validateProcedureContent(draft.content, draft.relativePath);
    expect(validation).toMatchObject({ valid: true, procedureKey: "proposed/release-the-agenr-packages" });
  });

  it("honors explicit key and path overrides", () => {
    const draft = renderProcedureProposalDraft(
      { subject: "Release", content: "Steps.", workingSetId: "ws-1", evidenceEventSequences: [] },
      { procedureKey: "agenr/release", relativePath: "agenr/release.yaml" },
    );

    expect(draft.procedureKey).toBe("agenr/release");
    expect(draft.relativePath).toBe("agenr/release.yaml");
    expect(validateProcedureContent(draft.content, draft.relativePath).valid).toBe(true);
  });
});

describe("procedure proposal review service", () => {
  let database: SqlDatabase;
  let dbPath: string;
  let proceduresDir: string;
  let repository: ProcedureProposalRepository;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agenr-proposal-service-${randomUUID()}.sqlite`);
    proceduresDir = await mkdtemp(path.join(os.tmpdir(), "agenr-proposal-procedures-"));
    database = await createDatabase(dbPath);
    repository = createProcedureProposalRepository(database);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    await removeTestPath(dbPath);
    await rm(proceduresDir, { recursive: true, force: true });
  });

  it("applies one open proposal by writing the draft YAML and syncing procedures", async () => {
    const proposal = await repository.createProposal(buildCreateInput());

    const result = await applyProcedureProposal(
      { repository, embedding: createStubEmbedding(), proceduresDir, dbPath },
      { proposalId: proposal.id, reason: "Looks right.", now: NOW },
    );
    if (!result.ok) {
      throw new Error(`expected apply success, got ${JSON.stringify(result.failure)}`);
    }

    expect(result.proposal.status).toBe("applied");
    expect(result.proposal.appliedProcedurePath).toBe(result.relativePath);
    expect(result.save.execution?.totals.created).toBe(1);

    const written = await readFile(path.join(proceduresDir, result.relativePath), "utf-8");
    expect(written).toContain("procedure_key: proposed/release-the-agenr-packages");
    expect(written).toContain("working_set:ws-1");
  });

  it("blocks applying an already-reviewed proposal", async () => {
    const proposal = await repository.createProposal(buildCreateInput());
    await repository.reviewProposal({ proposalId: proposal.id, decision: "rejected", reason: "No.", now: NOW });

    const result = await applyProcedureProposal(
      { repository, embedding: createStubEmbedding(), proceduresDir, dbPath },
      { proposalId: proposal.id, reason: "Try again.", now: NOW },
    );

    expect(result).toEqual({ ok: false, failure: { kind: "already_reviewed", status: "rejected" } });
  });

  it("releases the apply claim when the procedure write fails", async () => {
    const proposal = await repository.createProposal(buildCreateInput());

    await expect(
      applyProcedureProposal(
        { repository, embedding: createStubEmbedding(), proceduresDir, dbPath },
        { proposalId: proposal.id, reason: "Looks right.", relativePath: "../escape.yaml", now: NOW },
      ),
    ).rejects.toThrow(/within the configured procedures directory/u);

    await expect(repository.getProposal(proposal.id)).resolves.toMatchObject({ status: "open" });
  });

  it("rejects one open proposal with a reviewer reason", async () => {
    const proposal = await repository.createProposal(buildCreateInput());

    const result = await rejectProcedureProposal({ repository }, { proposalId: proposal.id, reason: "Not a procedure.", now: NOW });
    if (!result.ok) {
      throw new Error(`expected reject success, got ${JSON.stringify(result.failure)}`);
    }

    expect(result.proposal.status).toBe("rejected");
    expect(result.proposal.reviewReason).toBe("Not a procedure.");
  });

  it("returns not_found for unknown proposals", async () => {
    const result = await applyProcedureProposal(
      { repository, embedding: createStubEmbedding(), proceduresDir, dbPath },
      { proposalId: "missing", reason: "n/a", now: NOW },
    );

    expect(result).toEqual({ ok: false, failure: { kind: "not_found" } });
  });

  /** Builds one create-proposal input for the temp repository. */
  function buildCreateInput() {
    return {
      workingSetId: "ws-1",
      candidateFingerprint: "fingerprint-1",
      subject: "Release the agenr packages",
      content: "Run pnpm check, bump versions, publish all three packages.",
      evidenceEventSequences: [3, 5],
      now: NOW,
    };
  }
});

/** Builds a deterministic 1024-dim embedding stub for procedure sync. */
function createStubEmbedding(): EmbeddingPort {
  return {
    embed: async (texts) => texts.map((_, index) => Array.from({ length: 1024 }, () => index + 1)),
  };
}
