import { describe, expect, it, vi } from "vitest";

import type { DatabasePort, LlmPort } from "../../../src/core/ports.js";
import { extractClaimKey, extractClaimKeyDecision, getEntityHints, runBatchClaimExtraction } from "../../../src/core/store/claim-extraction.js";
import type { Entry, StoreEntryInput } from "../../../src/core/types.js";

describe("extractClaimKey", () => {
  it("extracts a normalized claim key for an eligible fact entry", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Jim",
      attribute: "home city",
      confidence: 0.93,
    }));

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "Jim's home city",
        content: "Jim lives in Denver, Colorado.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
    );

    expect(result).toEqual({
      claimKey: "jim/home_city",
      confidence: 0.93,
      rawEntity: "Jim",
      rawAttribute: "home city",
      path: "model",
    });
  });

  it("includes positive examples, negative examples, no_claim guidance, and stability guidance in the prompt", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "jim",
      attribute: "timezone",
      confidence: 0.95,
    }));

    await extractClaimKey(
      {
        type: "fact",
        subject: "Jim timezone",
        content: "Jim's timezone is America/Chicago.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        hints: {
          claimKeyExamples: ["jim/timezone"],
          entityHints: ["jim"],
        },
      },
    );

    const systemPrompt = llm.calls[0]?.systemPrompt ?? "";
    expect(systemPrompt).toContain('"Jim\'s timezone is America/Chicago." -> jim/timezone');
    expect(systemPrompt).toContain('"Mac mini updates should stay manual so debugging stays predictable." -> mac_mini/manual_update_policy');
    expect(systemPrompt).toContain("- Bad: jim/america_chicago -> Good: jim/timezone");
    expect(systemPrompt).toContain(
      "If the entry states a durable rule, default, workflow, guardrail, source-of-truth rule, architecture boundary, or process constraint plus rationale",
    );
    expect(systemPrompt).toContain("Choose attribute names that still make sense if the value changes.");
    expect(systemPrompt).toContain("Prefer short noun-like slot names over sentence-like attribute phrases.");
    expect(systemPrompt).toContain("Avoid full action clauses like requires_x_to_y, preserves_x_across_y, or x_precedes_y");
    expect(systemPrompt).toContain("When unsure, prefer no_claim over inventing a weak key.");
  });

  it("includes full claim-key examples and metadata hints in the prompt", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "the project",
      attribute: "status",
      confidence: 0.95,
    }));

    await extractClaimKey(
      {
        type: "fact",
        subject: "Project status",
        content: "The project is active.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        hints: {
          claimKeyExamples: ["platform_team/deploy_strategy", "agenr/default_model"],
          entityHints: ["platform_team"],
          project: "Agenr",
          userId: "Jim",
          tags: ["architecture", "workflow"],
          sourceContext: "AGENTS.md defines the repo workflow",
        },
      },
    );

    const systemPrompt = llm.calls[0]?.systemPrompt ?? "";
    expect(systemPrompt).toContain("platform_team/deploy_strategy");
    expect(systemPrompt).toContain("agenr/default_model");
    expect(systemPrompt).toContain("Current entry metadata hints: user_id=jim, project=agenr");
    expect(systemPrompt).toContain("Current entry grounding clues: tags=architecture, workflow, source_context=AGENTS.md defines the repo workflow");
    expect(systemPrompt).toContain("Tags and source_context are local grounding clues, not proof.");
  });

  it("accepts rationale-heavy architecture decisions when the primary durable slot is clear", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Agenr",
      attribute: "core adapter boundary",
      confidence: 0.9,
    }));

    const result = await extractClaimKey(
      {
        type: "decision",
        subject: "Core-adapter boundary",
        content:
          "Keep pure logic in src/core and adapters outside it so future hosts can plug in cleanly and tests stay isolated from infrastructure concerns.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        hints: {
          tags: ["architecture", "workflow"],
          sourceContext: "Architecture guidance from the repo operating docs",
        },
      },
    );

    expect(result?.claimKey).toBe("agenr/core_adapter_boundary");
  });

  it("compacts verbose sentence-like model attributes into canonical slots before returning them", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "OpenClaw before prompt build hook",
      attribute: "requires real agent turn or message to trigger",
      confidence: 0.89,
    }));

    const result = await extractClaimKey(
      {
        type: "decision",
        subject: "Before-prompt-build trigger contract",
        content: "The before-prompt-build hook only triggers after a real agent turn or message.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
    );

    expect(result).toEqual({
      claimKey: "openclaw_before_prompt_build_hook/trigger_condition",
      confidence: 0.89,
      rawEntity: "OpenClaw before prompt build hook",
      rawAttribute: "requires real agent turn or message to trigger",
      path: "model",
      compactedFrom: "openclaw_before_prompt_build_hook/requires_real_agent_turn_or_message_to_trigger",
      compactionReason: "collapsed a sentence-like trigger requirement into a stable condition slot",
    });
  });

  it("resolves self-references when exactly one entity hint exists", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "the user",
      attribute: "timezone",
      confidence: 0.88,
    }));

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "User timezone",
        content: "The user's timezone is America/Chicago.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        hints: {
          entityHints: ["research_agent"],
        },
      },
    );

    expect(result?.claimKey).toBe("research_agent/timezone");
  });

  it("uses project metadata to resolve project self-references", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "the project",
      attribute: "status",
      confidence: 0.9,
    }));

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "Project status",
        content: "The project is active.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        hints: {
          project: "Project X",
        },
      },
    );

    expect(result?.claimKey).toBe("project_x/status");
  });

  it("rejects unresolved self-referential entities when multiple hints make resolution ambiguous", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "we",
      attribute: "deployment process",
      confidence: 0.88,
    }));
    const warnings: string[] = [];

    const result = await extractClaimKey(
      {
        type: "decision",
        subject: "Deployment process",
        content: "We deploy with blue-green cutovers.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        hints: {
          entityHints: ["platform_team", "deploy_pipeline"],
        },
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/self-referential/i);
  });

  it("skips ineligible milestone entries", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Jim",
      attribute: "home city",
      confidence: 0.95,
    }));

    await expect(
      extractClaimKey(
        {
          type: "milestone",
          subject: "Jim moved",
          content: "Jim moved to Denver.",
        },
        llm,
        {
          enabled: true,
          confidenceThreshold: 0.8,
          eligibleTypes: ["fact", "preference", "decision", "lesson"],
        },
      ),
    ).resolves.toBeNull();
    expect(llm.calls).toEqual([]);
  });

  it("allows lesson entries when configured and the slot is stable", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "postgres",
      attribute: "connection_pooling_lesson",
      confidence: 0.9,
    }));

    const result = await extractClaimKey(
      {
        type: "lesson",
        subject: "Postgres pooling lesson",
        content: "Lesson: Postgres needs connection pooling under bursty load.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
    );

    expect(result?.claimKey).toBe("postgres/connection_pooling_lesson");
  });

  it("returns no claim for narrative lesson entries", async () => {
    const llm = new MockLlmPort(() => ({
      no_claim: true,
      confidence: 0.3,
    }));

    await expect(
      extractClaimKey(
        {
          type: "lesson",
          subject: "Long incident retrospective",
          content: "We chased several hypotheses, rotated credentials, and eventually recovered after a long debugging session.",
        },
        llm,
        {
          enabled: true,
          confidenceThreshold: 0.8,
          eligibleTypes: ["fact", "preference", "decision", "lesson"],
        },
      ),
    ).resolves.toBeNull();
  });

  it("rejects generic extracted attributes", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Project X",
      attribute: "details",
      confidence: 0.95,
    }));
    const warnings: string[] = [];

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "Project X",
        content: "Project X uses blue-green deploys.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/too generic/i);
  });

  it("rejects value-shaped extracted attributes", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "React Router",
      attribute: "v7",
      confidence: 0.95,
    }));
    const warnings: string[] = [];

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "React Router version",
        content: "The project currently uses React Router v7.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/value-shaped/i);
  });

  it("retries once after malformed JSON and exposes the retry path", async () => {
    const llm = new MockLlmPort((callIndex) =>
      callIndex === 0
        ? new Error("Unexpected token 'J' in JSON at position 0")
        : {
            entity: "Jim",
            attribute: "timezone",
            confidence: 0.92,
          },
    );

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "Jim timezone",
        content: "Jim's timezone is America/Chicago.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
    );

    expect(result?.claimKey).toBe("jim/timezone");
    expect(result?.path).toBe("json_retry");
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.systemPrompt).toContain("Your previous answer was invalid JSON.");
  });

  it("uses deterministic repair for a simple safe possessive slot when the model confidence is too low", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.2,
    }));

    const result = await extractClaimKey(
      {
        type: "fact",
        subject: "Jim's timezone",
        content: "Jim's timezone is America/Chicago.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
    );

    expect(result).toEqual({
      claimKey: "jim/timezone",
      confidence: 0.86,
      rawEntity: "Jim",
      rawAttribute: "timezone",
      path: "deterministic_repair",
    });
  });

  it("reuses a dominant trusted family when deterministic repair would mint a singleton alias namespace", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Jim Martin",
      attribute: "skunk theme",
      confidence: 0.2,
    }));

    const decision = await extractClaimKeyDecision(
      {
        type: "fact",
        subject: "Jim Martin's skunk theme",
        content: "Jim Martin's skunk theme comes from childhood lore.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        entityPrefixStats: [
          {
            entityPrefix: "jim",
            activeEntryCount: 4,
            trustedEntryCount: 4,
            tentativeEntryCount: 0,
            unresolvedEntryCount: 0,
            legacyEntryCount: 0,
            deterministicRepairEntryCount: 0,
            manualEntryCount: 0,
            modelEntryCount: 4,
            jsonRetryEntryCount: 0,
            surgeonFamilyReuseEntryCount: 0,
          },
        ],
      },
    );

    expect(decision.result).toMatchObject({
      claimKey: "jim/skunk_theme",
      path: "deterministic_repair",
      acceptanceRationale: expect.stringContaining('reused dominant entity family "jim"'),
    });
    expect(decision.diagnostic).toMatchObject({
      outcome: "accepted",
      suggestedClaimKey: "jim/skunk_theme",
      rationale: expect.stringContaining('reused dominant family "jim"'),
    });
  });

  it("does not rewrite intentional scoped namespaces during deterministic repair", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "MacBook agenr repo",
      attribute: "status",
      confidence: 0.2,
    }));

    const decision = await extractClaimKeyDecision(
      {
        type: "decision",
        subject: "MacBook agenr repo's status",
        content: "The MacBook agenr repo's status is active.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        entityPrefixStats: [
          {
            entityPrefix: "agenr",
            activeEntryCount: 5,
            trustedEntryCount: 5,
            tentativeEntryCount: 0,
            unresolvedEntryCount: 0,
            legacyEntryCount: 0,
            deterministicRepairEntryCount: 0,
            manualEntryCount: 0,
            modelEntryCount: 5,
            jsonRetryEntryCount: 0,
            surgeonFamilyReuseEntryCount: 0,
          },
        ],
      },
    );

    expect(decision.result).toMatchObject({
      claimKey: "macbook_agenr_repo/status",
      path: "deterministic_repair",
    });
    expect(decision.diagnostic).toMatchObject({
      outcome: "accepted",
      suggestedClaimKey: "macbook_agenr_repo/status",
    });
  });

  it("does not upgrade low-quality outputs into bad claim keys", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Jim",
      attribute: "oat milk",
      confidence: 0.2,
    }));

    await expect(
      extractClaimKey(
        {
          type: "preference",
          subject: "Jim's oat milk",
          content: "Jim prefers oat milk in coffee.",
        },
        llm,
        {
          enabled: true,
          confidenceThreshold: 0.8,
          eligibleTypes: ["fact", "preference", "decision", "lesson"],
        },
      ),
    ).resolves.toBeNull();
  });

  it("accepts a supported near-miss candidate when trusted exact-key reuse and lexical grounding are strong", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "Repo workflow",
      attribute: "source of truth",
      confidence: 0.74,
    }));

    const result = await extractClaimKey(
      {
        type: "decision",
        subject: "Repo workflow docs",
        content: "AGENTS.md is the source of truth for the repo workflow, even when older notes disagree.",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        supportClaimKeys: ["repo_workflow/source_of_truth"],
      },
    );

    expect(result).toMatchObject({
      claimKey: "repo_workflow/source_of_truth",
      confidence: 0.74,
      path: "model",
    });
    expect(result?.acceptanceRationale).toContain("trusted exact-key reuse");
  });

  it("surfaces a structured review candidate when support exists but confidence stays below the ingest acceptance floor", async () => {
    const llm = new MockLlmPort(() => ({
      entity: "SQLite",
      attribute: "window function support",
      confidence: 0.68,
    }));

    const decision = await extractClaimKeyDecision(
      {
        type: "fact",
        subject: "SQLite window functions support",
        content: "SQLite in this environment supports window functions.",
        tags: ["sqlite", "database"],
        source_context: "SQLite query capability note",
      },
      llm,
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      {
        supportClaimKeys: ["sqlite/window_function_support"],
      },
    );

    expect(decision.result).toBeNull();
    expect(decision.diagnostic).toMatchObject({
      outcome: "low_confidence_candidate",
      reviewable: true,
      suggestedClaimKey: "sqlite/window_function_support",
      path: "model",
    });
  });
});

describe("runBatchClaimExtraction", () => {
  it("honors the configured batch concurrency", async () => {
    const entries: StoreEntryInput[] = [
      {
        type: "fact",
        subject: "Jim timezone",
        content: "Jim's timezone is America/Chicago.",
      },
      {
        type: "fact",
        subject: "Jim city",
        content: "Jim lives in Denver, Colorado.",
      },
      {
        type: "fact",
        subject: "Jim employer",
        content: "Jim works at Agenr.",
      },
    ];
    const responses = [
      deferred<{ entity: string; attribute: string; confidence: number }>(),
      deferred<{ entity: string; attribute: string; confidence: number }>(),
      deferred<{ entity: string; attribute: string; confidence: number }>(),
    ];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const llm = new MockLlmPort((callIndex) => {
      const response = responses[callIndex];
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      return response.promise.finally(() => {
        activeRequests -= 1;
      });
    });

    const extractionPromise = runBatchClaimExtraction(
      [{ entries }],
      {
        createLlm: () => llm,
        db: new MockDatabasePort(),
      },
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      2,
    );

    await vi.waitFor(() => {
      expect(llm.calls).toHaveLength(2);
    });
    expect(maxActiveRequests).toBe(2);

    responses[0].resolve({
      entity: "Jim",
      attribute: "timezone",
      confidence: 0.95,
    });
    await vi.waitFor(() => {
      expect(llm.calls).toHaveLength(2);
    });

    responses[1].resolve({
      entity: "Jim",
      attribute: "home city",
      confidence: 0.95,
    });
    await vi.waitFor(() => {
      expect(llm.calls).toHaveLength(3);
    });

    responses[2].resolve({
      entity: "Jim",
      attribute: "employer",
      confidence: 0.95,
    });
    await extractionPromise;

    expect(maxActiveRequests).toBe(2);
    expect(entries[0]?.claim_key).toBe("jim/timezone");
    expect(entries[1]?.claim_key).toBe("jim/home_city");
    expect(entries[2]?.claim_key).toBe("jim/employer");
  });

  it("reports progress for only eligible entries that need extraction", async () => {
    const entries: StoreEntryInput[] = [
      {
        type: "fact",
        subject: "Pre-keyed timezone",
        content: "Jim's timezone is America/Chicago.",
        claim_key: "jim/timezone",
      },
      {
        type: "milestone",
        subject: "Launch day",
        content: "Project X launched today.",
      },
      {
        type: "fact",
        subject: "Jim city",
        content: "Jim lives in Denver, Colorado.",
      },
      {
        type: "decision",
        subject: "Repo workflow",
        content: "AGENTS.md is the source of truth for the repo workflow.",
      },
    ];
    const progressEvents: Array<{ phase: string; completedEntries: number; totalEntries: number; totalEligibleEntries: number }> = [];

    await runBatchClaimExtraction(
      [{ entries }],
      {
        createLlm: () =>
          new MockLlmPort((callIndex) =>
            callIndex === 0
              ? {
                  entity: "Jim",
                  attribute: "home city",
                  confidence: 0.95,
                }
              : {
                  entity: "Repo workflow",
                  attribute: "source of truth",
                  confidence: 0.95,
                },
          ),
        db: new MockDatabasePort(),
      },
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      2,
      undefined,
      undefined,
      (event) => {
        progressEvents.push({ ...event });
      },
    );

    expect(progressEvents).toEqual([
      {
        phase: "primary",
        completedEntries: 1,
        totalEntries: 2,
        totalEligibleEntries: 2,
      },
      {
        phase: "primary",
        completedEntries: 2,
        totalEntries: 2,
        totalEligibleEntries: 2,
      },
    ]);
    expect(entries[0]?.claim_key).toBe("jim/timezone");
    expect(entries[1]?.claim_key).toBeUndefined();
    expect(entries[2]?.claim_key).toBe("jim/home_city");
    expect(entries[3]?.claim_key).toBe("repo_workflow/source_of_truth");
  });

  it("does not let later pre-keyed entries influence earlier entries in the same stage", async () => {
    const entries: StoreEntryInput[] = [
      {
        type: "fact",
        subject: "Current status",
        content: "The project is active.",
        project: "Project X",
      },
      {
        type: "fact",
        subject: "Canonical status",
        content: "Project X is active.",
        project: "Project X",
        claim_key: "project_x/status",
      },
      {
        type: "fact",
        subject: "Current owner",
        content: "The project is owned by the platform team.",
        project: "Project X",
      },
    ];
    const llm = new MockLlmPort((callIndex, systemPrompt) => {
      if (callIndex === 0) {
        expect(systemPrompt).not.toContain("project_x/status");
        return {
          no_claim: true,
        };
      }

      expect(systemPrompt).toContain("project_x/status");
      return {
        no_claim: true,
      };
    });

    await runBatchClaimExtraction(
      [{ entries }],
      {
        createLlm: () => llm,
        db: new MockDatabasePort(),
      },
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      2,
    );

    expect(llm.calls).toHaveLength(2);
    expect(entries[0]?.claim_key).toBeUndefined();
    expect(entries[1]?.claim_key).toBe("project_x/status");
    expect(entries[2]?.claim_key).toBeUndefined();
  });

  it("uses bounded full-key hints and same-batch updates for later stages", async () => {
    const entries: StoreEntryInput[] = [
      {
        type: "fact",
        subject: "Project X status",
        content: "Project X is active.",
        project: "Project X",
      },
      {
        type: "fact",
        subject: "Project X owner",
        content: "Project X is owned by the platform team.",
        project: "Project X",
      },
      {
        type: "fact",
        subject: "Current status",
        content: "The project is active.",
        project: "Project X",
      },
    ];
    const llm = new MockLlmPort((callIndex, systemPrompt) => {
      if (callIndex === 0) {
        expect(systemPrompt).toContain("seed_01/status_01");
        expect(systemPrompt).toContain("seed_08/status_08");
        expect(systemPrompt).not.toContain("seed_09/status_09");
        return {
          entity: "project_x",
          attribute: "status",
          confidence: 0.95,
        };
      }

      if (callIndex === 1) {
        return {
          entity: "project_x",
          attribute: "owner",
          confidence: 0.95,
        };
      }

      expect(systemPrompt).toContain("project_x/status");
      return {
        entity: "the project",
        attribute: "status",
        confidence: 0.95,
      };
    });
    const db = new MockDatabasePort({
      claimKeyPrefixes: ["seed_01", "seed_02"],
      claimKeyExamples: Array.from({ length: 10 }, (_, index) => `seed_${String(index + 1).padStart(2, "0")}/status_${String(index + 1).padStart(2, "0")}`),
    });

    await runBatchClaimExtraction(
      [{ entries }],
      {
        createLlm: () => llm,
        db,
      },
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      2,
    );

    expect(entries[0]?.claim_key).toBe("project_x/status");
    expect(entries[1]?.claim_key).toBe("project_x/owner");
    expect(entries[2]?.claim_key).toBe("project_x/status");
  });

  it("retries unresolved earlier entries after later trusted siblings expand same-batch support", async () => {
    const entries: StoreEntryInput[] = [
      {
        type: "decision",
        subject: "Repo workflow docs",
        content: "AGENTS.md is the source of truth for the repo workflow, even when older notes disagree.",
      },
      {
        type: "decision",
        subject: "Canonical repo workflow",
        content: "The repo workflow uses AGENTS.md as its source of truth.",
      },
    ];
    const diagnostics: string[] = [];
    const llm = new MockLlmPort((callIndex) => {
      if (callIndex === 0) {
        return {
          entity: "Repo workflow",
          attribute: "source of truth",
          confidence: 0.68,
        };
      }

      if (callIndex === 1) {
        return {
          entity: "Repo workflow",
          attribute: "source of truth",
          confidence: 0.94,
        };
      }

      return {
        entity: "Repo workflow",
        attribute: "source of truth",
        confidence: 0.74,
      };
    });

    await runBatchClaimExtraction(
      [{ entries }],
      {
        createLlm: () => llm,
        db: new MockDatabasePort(),
      },
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      4,
      undefined,
      (entry, diagnostic) => {
        diagnostics.push(`${entry.subject}|${diagnostic.outcome}|${diagnostic.suggestedClaimKey ?? ""}`);
      },
    );

    expect(entries[0]?.claim_key).toBe("repo_workflow/source_of_truth");
    expect(entries[1]?.claim_key).toBe("repo_workflow/source_of_truth");
    expect(llm.calls).toHaveLength(3);
    expect(diagnostics).toContain("Repo workflow docs|accepted|repo_workflow/source_of_truth");
  });

  it("reports retry-phase progress separately after the primary pass", async () => {
    const entries: StoreEntryInput[] = [
      {
        type: "decision",
        subject: "Repo workflow docs",
        content: "AGENTS.md is the source of truth for the repo workflow, even when older notes disagree.",
      },
      {
        type: "decision",
        subject: "Canonical repo workflow",
        content: "The repo workflow uses AGENTS.md as its source of truth.",
      },
    ];
    const progressEvents: Array<{ phase: string; completedEntries: number; totalEntries: number; totalEligibleEntries: number }> = [];

    await runBatchClaimExtraction(
      [{ entries }],
      {
        createLlm: () =>
          new MockLlmPort((callIndex) => {
            if (callIndex === 0) {
              return {
                entity: "Repo workflow",
                attribute: "source of truth",
                confidence: 0.68,
              };
            }

            if (callIndex === 1) {
              return {
                entity: "Repo workflow",
                attribute: "source of truth",
                confidence: 0.94,
              };
            }

            return {
              entity: "Repo workflow",
              attribute: "source of truth",
              confidence: 0.74,
            };
          }),
        db: new MockDatabasePort(),
      },
      {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      1,
      undefined,
      undefined,
      (event) => {
        progressEvents.push({ ...event });
      },
    );

    expect(progressEvents).toEqual([
      {
        phase: "primary",
        completedEntries: 1,
        totalEntries: 2,
        totalEligibleEntries: 2,
      },
      {
        phase: "primary",
        completedEntries: 2,
        totalEntries: 2,
        totalEligibleEntries: 2,
      },
      {
        phase: "retry",
        completedEntries: 1,
        totalEntries: 1,
        totalEligibleEntries: 2,
      },
    ]);
    expect(entries[0]?.claim_key).toBe("repo_workflow/source_of_truth");
    expect(entries[1]?.claim_key).toBe("repo_workflow/source_of_truth");
  });
});

describe("getEntityHints", () => {
  it("returns distinct entity prefixes from the database port", async () => {
    const db = new MockDatabasePort({
      claimKeyPrefixes: ["jim", "agenr"],
    });

    await expect(getEntityHints(db)).resolves.toEqual(["jim", "agenr"]);
  });
});

class MockLlmPort implements LlmPort {
  public readonly calls: Array<{ systemPrompt: string; userMessage: string }> = [];

  public constructor(private readonly responder: (callIndex: number, systemPrompt: string, userMessage: string) => unknown) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used in these tests.");
  }

  public async completeJson<T>(systemPrompt: string, userMessage: string): Promise<T> {
    const callIndex = this.calls.length;
    this.calls.push({ systemPrompt, userMessage });
    const response = this.responder(callIndex, systemPrompt, userMessage);
    if (response instanceof Error) {
      throw response;
    }

    return response as T;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

class MockDatabasePort implements DatabasePort {
  public constructor(
    private readonly values: {
      claimKeyPrefixes?: string[];
      claimKeyExamples?: string[];
    } = {},
  ) {}

  public async insertEntry(): Promise<string> {
    throw new Error("insertEntry() is not used in these tests.");
  }

  public async prepareForBulkWrites(): Promise<void> {}

  public async finalizeBulkWrites(): Promise<void> {}

  public async getEntries(): Promise<Entry[]> {
    return [];
  }

  public async getEntry(): Promise<Entry | null> {
    return null;
  }

  public async findExistingHashes(): Promise<Set<string>> {
    return new Set();
  }

  public async findExistingNormHashes(): Promise<Set<string>> {
    return new Set();
  }

  public async retireEntry(): Promise<boolean> {
    return false;
  }

  public async supersedeEntry(): Promise<boolean> {
    return false;
  }

  public async findActiveEntriesByClaimKey(): Promise<Entry[]> {
    return [];
  }

  public async getDistinctClaimKeyPrefixes(): Promise<string[]> {
    return this.values.claimKeyPrefixes ?? [];
  }

  public async getClaimKeyExamples(): Promise<string[]> {
    return this.values.claimKeyExamples ?? [];
  }

  public async updateEntry(): Promise<boolean> {
    return false;
  }

  public async getIngestLogEntry(): Promise<{ fileHash: string; ingestedAt: string } | null> {
    return null;
  }

  public async insertIngestLogEntry(): Promise<void> {}

  public async init(): Promise<void> {}

  public async close(): Promise<void> {}
}
