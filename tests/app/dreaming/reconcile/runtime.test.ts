import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createTestClient, insertDurable, MockClaimLlm, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

import { getLastDreamRun, getDreamRunActions, getDreamRunProposals } from "../../../../src/adapters/db/dreaming-run-log.js";

describe("reconcile dreaming pass - runtime", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("uses trusted cleanup hints only and does not propagate same-run repairs into later hints", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, { id: "trusted-seed", subject: "Timezone seed", type: "fact", claim_key: "jim/timezone" });
    await insertDurable(client, { id: "bad-seed-1", subject: "Project details", type: "fact", claim_key: "project/details" });
    await insertDurable(client, { id: "bad-seed-2", subject: "Legacy home city", type: "fact", claim_key: " Jim / Home City " });
    await insertDurable(client, { id: "missing-1", subject: "Status one", type: "fact", content: "The project is active." });
    await insertDurable(client, { id: "missing-2", subject: "Status two", type: "fact", content: "The project is healthy." });
    const llm = new MockClaimLlm((callIndex, systemPrompt) => {
      if (callIndex === 0) {
        expect(systemPrompt).toContain("jim/timezone");
        expect(systemPrompt).not.toContain("project/details");
        expect(systemPrompt).not.toContain(" Jim / Home City ");
        return { entity: "project", attribute: "status", confidence: 0.96 };
      }

      expect(systemPrompt).toContain("jim/timezone");
      expect(systemPrompt).not.toContain("project/status");
      return { entity: "Jim", attribute: "health_status", confidence: 0.95 };
    });

    await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
    });
  });

  it("trips the anomaly breaker on pathological convergence onto one claim key", async () => {
    const client = await createTestClient(clients);
    for (let index = 0; index < 26; index += 1) {
      await insertDurable(client, {
        id: `concentrated-${index}`,
        subject: `Timezone ${index}`,
        type: "fact",
        content: `Jim's timezone note ${index}.`,
      });
    }
    const llm = new MockClaimLlm(() => ({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.97,
    }));

    const result = await runClaimKeyPass(client, {
      createClaimExtractionLlm: () => llm,
    });
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("failed");
    expect(summary?.circuitBreaker).toMatchObject({
      kind: "claim_key_concentration",
    });
  });

  it("allows a larger distributed cleanup batch without tiny-run throttling", async () => {
    const client = await createTestClient(clients);
    for (let index = 0; index < 12; index += 1) {
      await insertDurable(client, {
        id: `distributed-${index}`,
        subject: `Slot ${index}`,
        type: "fact",
        content: `Fact ${index}.`,
      });
    }
    const llm = new MockClaimLlm((callIndex) => ({
      entity: `entity_${callIndex}`,
      attribute: `attribute_${callIndex}`,
      confidence: 0.97,
    }));

    const result = await runClaimKeyPass(client, {
      createClaimExtractionLlm: () => llm,
    });
    const summary = (await getLastDreamRun(client))?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    expect(summary?.circuitBreaker).toBeNull();
    expect(summary?.counts.identifiedBackfills).toBe(12);
  });

  it("emits structured progress snapshots for deterministic claim-key cleanup stages", async () => {
    const client = await createTestClient(clients);
    const progress: DreamProgressEvent[] = [];
    await insertDurable(client, { id: "normalize-1", subject: "Home city", type: "fact", claim_key: " Jim / Home City " });
    await insertDurable(client, { id: "backfill-1", subject: "Timezone", type: "fact", content: "Jim's timezone is America/Chicago." });
    await insertDurable(client, { id: "suspect-1", subject: "Project status", type: "fact", claim_key: "project/status", content: "The project is active." });
    await insertDurable(client, { id: "mixed-a", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/manual_update_policy" });
    await insertDurable(client, { id: "mixed-b", subject: "Mac mini update policy", type: "preference", claim_key: "mac_mini/update_window" });
    const llm = new MockClaimLlm((callIndex) =>
      callIndex === 0 ? { entity: "Jim", attribute: "timezone", confidence: 0.96 } : { entity: "Agenr", attribute: "status", confidence: 0.88 },
    );

    const result = await runClaimKeyPass(client, {
      apply: true,
      createClaimExtractionLlm: () => llm,
      reportProgress: (event) => progress.push(event),
    });

    expect(result.status).toBe("completed");
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "phase", phase: "load_working_set_complete", workingSetSize: 5 }),
        expect.objectContaining({ kind: "phase", phase: "pass_start", tier: "standard" }),
        expect.objectContaining({
          kind: "reconcile_progress",
          stage: "health",
          status: "snapshot",
          health: expect.objectContaining({
            malformedOrNoncanonicalCount: 1,
            missingCount: 1,
            suspectCanonicalCount: 1,
            mixedGroupCount: 1,
          }),
        }),
        expect.objectContaining({ kind: "reconcile_progress", stage: "invalid_noncanonical", status: "started", total: 1 }),
        expect.objectContaining({
          kind: "reconcile_progress",
          stage: "invalid_noncanonical",
          status: "completed",
          counts: expect.objectContaining({
            appliedNormalizations: 1,
          }),
        }),
        expect.objectContaining({
          kind: "reconcile_progress",
          stage: "missing",
          status: "started",
          previewQueued: 1,
          previewTotal: 1,
          previewConcurrency: 10,
        }),
        expect.objectContaining({
          kind: "reconcile_progress",
          stage: "missing",
          status: "preview_progress",
          previewCompleted: 1,
          previewTotal: 1,
          completed: 0,
        }),
        expect.objectContaining({ kind: "reconcile_progress", stage: "missing", status: "completed" }),
        expect.objectContaining({
          kind: "reconcile_progress",
          stage: "suspect_canonical",
          status: "started",
          previewQueued: 1,
          previewTotal: 1,
        }),
        expect.objectContaining({
          kind: "reconcile_progress",
          stage: "suspect_canonical",
          status: "completed",
          counts: expect.objectContaining({
            appliedBackfills: 1,
            proposalsEmitted: 1,
          }),
        }),
        expect.objectContaining({
          kind: "reconcile_progress",
          stage: "mixed_key_groups",
          status: "completed",
          total: 1,
          unitLabel: "groups",
          counts: expect.objectContaining({
            proposalsEmitted: 2,
          }),
        }),
      ]),
    );
  });
});
