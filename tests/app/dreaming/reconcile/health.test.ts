import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { createTestClient, insertDurable, runClaimKeyPass } from "../../../helpers/dreaming-reconcile.js";

import { getLastDreamRun } from "../../../../src/adapters/db/dreaming-run-log.js";

describe("reconcile dreaming pass - health", () => {
  const clients: Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });

  it("discovers missing, noncanonical, suspect, mixed, and exact-key multi-active health issues", async () => {
    const client = await createTestClient(clients);
    await insertDurable(client, { id: "missing-1", subject: "Primary timezone", type: "fact" });
    await insertDurable(client, { id: "noncanonical-1", subject: "Home city", type: "fact", claim_key: " Jim / Home City " });
    await insertDurable(client, { id: "suspect-1", subject: "Project status", type: "fact", claim_key: "project/status" });
    await insertDurable(client, {
      id: "dup-1",
      subject: "Timezone old",
      type: "fact",
      claim_key: "jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "model",
    });
    await insertDurable(client, {
      id: "dup-2",
      subject: "Timezone new",
      type: "fact",
      claim_key: "jim/timezone",
      claim_key_status: "trusted",
      claim_key_source: "model",
    });
    await insertDurable(client, { id: "mixed-1", subject: "Shared policy", type: "preference", claim_key: "mac_mini/manual_update_policy" });
    await insertDurable(client, { id: "mixed-2", subject: "Shared policy", type: "preference" });
    await insertDurable(client, {
      id: "jim-editor",
      subject: "Editor preference",
      type: "fact",
      claim_key: "jim/editor_preference",
      claim_key_status: "trusted",
      claim_key_source: "model",
    });
    await insertDurable(client, {
      id: "jim-review",
      subject: "Review preference",
      type: "fact",
      claim_key: "jim/code_review_preference",
      claim_key_status: "trusted",
      claim_key_source: "model",
    });
    await insertDurable(client, {
      id: "jim-martin-skunk",
      subject: "Jim Martin skunk identity",
      type: "fact",
      claim_key: "jim_martin/skunk_theme",
      claim_key_status: "tentative",
      claim_key_source: "deterministic_repair",
    });

    const result = await runClaimKeyPass(client);
    const run = await getLastDreamRun(client);
    const summary = run?.summaryJson?.reconcile;

    expect(result.status).toBe("completed");
    expect(summary?.before).toMatchObject({
      totalDurables: 10,
      missingCount: 2,
      malformedOrNoncanonicalCount: 1,
      suspectCanonicalCount: 1,
      mixedGroupCount: 1,
      exactKeyMultiActiveClusterCount: 1,
    });
  });
});
