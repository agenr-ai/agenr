import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { runBeforeTurn } from "../../../src/app/before-turn/index.js";
import type { BeforeTurnDeps } from "../../../src/app/before-turn/index.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../src/core/procedures/hashing.js";
import { composeProcedureRecallText } from "../../../src/core/procedures/recall-text.js";
import type { ProcedureDatabasePort, RecallPorts } from "../../../src/core/ports.js";
import type { RecallCandidateDurable } from "../../../src/core/recall/types.js";
import type { Durable, Procedure } from "../../../src/core/types.js";
import { finalizeTestDurable } from "../../helpers/durable-fixtures.js";

describe("runBeforeTurn", () => {
  it("abstains when the current turn is empty after normalization", async () => {
    const deps = createDeps();

    const result = await runBeforeTurn(
      {
        currentTurnText: "   ",
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics.abstained).toBe(true);
    expect(result.diagnostics.abstentionReasons).toContain("Current turn text was empty after normalization.");
    expect(deps.recall.embed).not.toHaveBeenCalled();
    expect(deps.procedures.procedureFtsSearch).not.toHaveBeenCalled();
  });

  it("skips short social turns before recall runs", async () => {
    const deps = createDeps();

    const result = await runBeforeTurn(
      {
        currentTurnText: "hello",
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics.abstained).toBe(true);
    expect(result.diagnostics.suppressedTurnCategory).toBe("short_social");
    expect(result.diagnostics.abstentionReasons).toContain("Current turn was short or social without clear factual, procedural, or task intent.");
    expect(deps.recall.embed).not.toHaveBeenCalled();
    expect(deps.procedures.procedureFtsSearch).not.toHaveBeenCalled();
  });

  it("requires factual, procedural, or task signal before recall runs", async () => {
    const deps = createDeps();

    const result = await runBeforeTurn(
      {
        currentTurnText: "This feels a bit noisy overall and I am thinking aloud.",
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics.abstained).toBe(true);
    expect(result.diagnostics.suppressedTurnCategory).toBe("low_signal");
    expect(result.diagnostics.abstentionReasons).toContain("Current turn lacked clear factual, procedural, or task signal, so before-turn recall abstained.");
    expect(deps.recall.embed).not.toHaveBeenCalled();
    expect(deps.procedures.procedureFtsSearch).not.toHaveBeenCalled();
  });

  it("treats non-code action requests as task signal", async () => {
    const deps = createDeps();

    const result = await runBeforeTurn(
      {
        currentTurnText: "Can you draft an email to my landlord about the lease renewal?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 1,
        },
      },
      deps,
    );

    expect(result.diagnostics.suppressedTurnCategory).toBeUndefined();
    expect(result.diagnostics.turnSignalLabels).toContain("task");
    expect(result.diagnostics.abstentionReasons).toContain("No durable memory entries cleared the before-turn threshold.");
    expect(deps.recall.embed).toHaveBeenCalledOnce();
  });

  it("treats non-code factual questions as factual signal", async () => {
    const deps = createDeps();

    const result = await runBeforeTurn(
      {
        currentTurnText: "What time is my dentist appointment on Friday?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 1,
        },
      },
      deps,
    );

    expect(result.diagnostics.suppressedTurnCategory).toBeUndefined();
    expect(result.diagnostics.turnSignalLabels).toContain("factual");
    expect(result.diagnostics.abstentionReasons).toContain("No durable memory entries cleared the before-turn threshold.");
    expect(deps.recall.embed).toHaveBeenCalledOnce();
  });

  it("treats non-code how-to requests as procedural signal", async () => {
    const deps = createDeps();

    const result = await runBeforeTurn(
      {
        currentTurnText: "Walk me through the best way to prepare for a visa interview.",
        policy: {
          recallThreshold: 1,
          procedureThreshold: 1,
        },
      },
      deps,
    );

    expect(result.diagnostics.suppressedTurnCategory).toBeUndefined();
    expect(result.diagnostics.turnSignalLabels).toContain("procedural");
    expect(result.diagnostics.abstentionReasons).toEqual(
      expect.arrayContaining([
        "No durable memory entries cleared the before-turn threshold.",
        "No canonical procedure suggestion cleared the before-turn threshold.",
      ]),
    );
    expect(deps.recall.embed).toHaveBeenCalledOnce();
  });

  it("returns a bounded durable-only patch when procedure suggestion is disabled", async () => {
    const entry = createEntry({
      id: "entry-decision",
      type: "decision",
      subject: "feature branch workflow",
      content: "Branch from local master and keep the change on a feature branch until ready to merge.",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(entry)],
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        sessionKey: "agent:main:webchat:test",
        currentTurnText: "Should I work on this directly on master or use a feature branch?",
        recentTurns: [{ role: "assistant", text: "We are changing a shared runtime slice." }],
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory).toMatchObject([
      {
        rank: 1,
        entry: {
          id: "entry-decision",
        },
        sourceKind: "turn_recall",
      },
    ]);
    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics).toMatchObject({
      durableRecallUsed: true,
      durableRecallCandidateCount: 1,
      procedureRecallUsed: false,
      procedureCandidateCount: 0,
      abstained: false,
    });
  });

  it("uses current-turn-only durable queries by default", async () => {
    const entry = createEntry({
      id: "entry-current-only",
      subject: "feature branch workflow",
      content: "Use a feature branch and merge back to master when the change is ready.",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(entry)],
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Should I work on this directly on master or use a feature branch?",
        recentTurns: [{ role: "assistant", text: "We are changing a shared runtime slice." }],
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.diagnostics.query).toBe("Should I work on this directly on master or use a feature branch?");
    expect(result.diagnostics.queryPolicy).toBe("current_only");
    expect(result.diagnostics.queryVariants).toEqual([
      {
        kind: "current_only",
        query: "Should I work on this directly on master or use a feature branch?",
        candidateCount: 1,
        selected: true,
      },
    ]);
    expect(result.diagnostics.query).not.toContain("Current turn:");
    expect(result.diagnostics.query).not.toContain("We are changing a shared runtime slice.");
  });

  it("keeps the primary variant selected when fallback is available but not needed", async () => {
    const entry = createEntry({
      id: "entry-context-primary",
      subject: "what should we do next",
      content: "What should we do next?",
      importance: 8,
    });
    const ftsSearch = vi.fn<RecallPorts["ftsSearch"]>(async (params) => {
      if (params.text === "What should we do next?") {
        return [
          {
            entry: toRecallCandidateDurable(entry),
            rank: -1,
            tier: "all_tokens",
          },
        ];
      }

      return [];
    });
    const deps = createDeps({
      ftsSearchImplementation: ftsSearch,
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What should we do next?",
        recentTurns: [{ role: "user", text: "Finish the release notes for the before-turn slice." }],
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
          highConfidenceRecallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["entry-context-primary"]);
    expect(result.diagnostics.queryPolicy).toBe("current_only");
    expect(result.diagnostics.queryVariants).toEqual([
      {
        kind: "current_only",
        query: "What should we do next?",
        candidateCount: 1,
        selected: true,
      },
    ]);
    expect(ftsSearch).toHaveBeenCalledTimes(1);
  });

  it("uses contextual fallback when a continuation turn needs topic recovery", async () => {
    const entry = createEntry({
      id: "entry-context-fallback",
      subject: "before-turn release notes",
      content: "The next step is to finish the release notes for the before-turn slice.",
      importance: 8,
    });
    const ftsSearch = vi.fn<RecallPorts["ftsSearch"]>(async (params) => {
      if (params.text === "What should we do next?") {
        return [
          {
            entry: toRecallCandidateDurable(entry),
            rank: -1,
            tier: "all_tokens",
          },
        ];
      }

      if (params.text.includes("Topic: Finish the release notes for the before-turn slice.")) {
        return [
          {
            entry: toRecallCandidateDurable(entry),
            rank: -1,
            tier: "all_tokens",
          },
        ];
      }

      return [];
    });
    const deps = createDeps({
      ftsSearchImplementation: ftsSearch,
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What should we do next?",
        recentTurns: [{ role: "user", text: "Finish the release notes for the before-turn slice." }],
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
          highConfidenceRecallThreshold: 1,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["entry-context-fallback"]);
    expect(result.diagnostics.queryPolicy).toBe("contextual_fallback");
    expect(result.diagnostics.query).toBe("What should we do next?\nTopic: Finish the release notes for the before-turn slice.");
    expect(result.diagnostics.queryVariants).toEqual([
      {
        kind: "current_only",
        query: "What should we do next?",
        candidateCount: 1,
        selected: false,
      },
      {
        kind: "contextual_anchor",
        query: "What should we do next?\nTopic: Finish the release notes for the before-turn slice.",
        candidateCount: 1,
        selected: true,
      },
    ]);
    expect(ftsSearch).toHaveBeenCalledTimes(2);
  });

  it("retries with contextual fallback when the primary score clears the old 0.85 gate but not the recalibrated default", async () => {
    // Regression guard for before-turn.contextual-follow-up.fallback.inject. Pin
    // "now" so recency math is deterministic. A permanent importance-6 entry
    // that is 100 days old and the only RRF leader composes to ~0.890, which
    // passes the pre-RRF 0.85 gate but stays below the recalibrated 0.97 gate,
    // so the selector must escalate to the contextual variant.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T12:00:00.000Z"));

    try {
      const entry = createEntry({
        id: "entry-threshold-recalibration-moderate",
        subject: "before-turn release notes",
        content: "The next step is to finish the release notes for the before-turn slice.",
        importance: 6,
        expiry: "permanent",
        created_at: "2026-01-09T12:00:00.000Z",
      });
      const ftsSearch = vi.fn<RecallPorts["ftsSearch"]>(async () => [
        {
          entry: toRecallCandidateDurable(entry),
          rank: -1,
          tier: "all_tokens",
        },
      ]);
      const deps = createDeps({
        ftsSearchImplementation: ftsSearch,
        hydratedEntries: [entry],
      });

      const result = await runBeforeTurn(
        {
          currentTurnText: "What should we do next?",
          recentTurns: [{ role: "user", text: "Finish the release notes for the before-turn slice." }],
          policy: {
            enableProcedureSuggestion: false,
            recallThreshold: 0,
          },
        },
        deps,
      );

      const topScore = result.durableMemory[0]?.score;
      expect(topScore).toBeDefined();
      expect(topScore as number).toBeGreaterThan(0.85);
      expect(topScore as number).toBeLessThan(0.97);
      expect(result.diagnostics.queryPolicy).toBe("contextual_fallback");
      expect(result.diagnostics.queryVariants).toEqual([
        expect.objectContaining({ kind: "current_only", selected: false }),
        expect.objectContaining({ kind: "contextual_anchor", selected: true }),
      ]);
      expect(ftsSearch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries with contextual fallback when a single-entry pool inflates the primary score past 0.92 but not 0.97", async () => {
    // Regression guard for rows 22 and 23 in the phase-0 attribution sweep at
    // `artifacts/regression-attribution/2026-04-19T23-07-52-044Z/`.
    //
    // The continuation-style follow-up eval seeds a single permanent
    // importance-6 entry created moments before the turn fires. With only one
    // candidate in the pool the reciprocal rank fusion relevance lands at 1.0,
    // recency is ~1.0, and the importance-6 normalization maps to ~0.733, so
    // the composite settles at ~0.933. That clears the phase-2 0.92 gate but
    // stays below the phase-2-followup 0.97 gate, which is exactly the
    // "contextual_fallback" behavior the eval expects.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T12:00:00.000Z"));

    try {
      const entry = createEntry({
        id: "before-turn-release-notes",
        subject: "before-turn release notes",
        content: "The next step is to finish the release notes for the before-turn slice.",
        importance: 6,
        expiry: "permanent",
        created_at: "2026-04-19T11:59:59.000Z",
      });
      const ftsSearch = vi.fn<RecallPorts["ftsSearch"]>(async () => [
        {
          entry: toRecallCandidateDurable(entry),
          rank: -1,
          tier: "all_tokens",
        },
      ]);
      const deps = createDeps({
        ftsSearchImplementation: ftsSearch,
        hydratedEntries: [entry],
      });

      const result = await runBeforeTurn(
        {
          currentTurnText: "What should we do next?",
          recentTurns: [{ role: "user", text: "Finish the release notes for the before-turn slice." }],
          policy: {
            enableProcedureSuggestion: false,
            recallThreshold: 0,
          },
        },
        deps,
      );

      const topScore = result.durableMemory[0]?.score;
      expect(topScore).toBeDefined();
      expect(topScore as number).toBeGreaterThan(0.92);
      expect(topScore as number).toBeLessThan(0.97);
      expect(result.diagnostics.queryPolicy).toBe("contextual_fallback");
      expect(result.diagnostics.queryVariants).toEqual([
        expect.objectContaining({ kind: "current_only", selected: false }),
        expect.objectContaining({ kind: "contextual_anchor", selected: true }),
      ]);
      expect(ftsSearch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the current-turn-only variant when the primary score clears the recalibrated default", async () => {
    // Precision floor for the recalibrated 0.97 default. A very recent
    // importance-10 entry that is the single RRF leader composes to ~0.999,
    // which clears the new default so the selector must not fire the
    // contextual fallback retry on continuation-style turns.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T12:00:00.000Z"));

    try {
      const entry = createEntry({
        id: "entry-threshold-recalibration-high",
        subject: "before-turn release notes",
        content: "The next step is to finish the release notes for the before-turn slice.",
        importance: 10,
        expiry: "permanent",
        created_at: "2026-04-18T12:00:00.000Z",
      });
      const ftsSearch = vi.fn<RecallPorts["ftsSearch"]>(async () => [
        {
          entry: toRecallCandidateDurable(entry),
          rank: -1,
          tier: "all_tokens",
        },
      ]);
      const deps = createDeps({
        ftsSearchImplementation: ftsSearch,
        hydratedEntries: [entry],
      });

      const result = await runBeforeTurn(
        {
          currentTurnText: "What should we do next?",
          recentTurns: [{ role: "user", text: "Finish the release notes for the before-turn slice." }],
          policy: {
            enableProcedureSuggestion: false,
            recallThreshold: 0,
          },
        },
        deps,
      );

      const topScore = result.durableMemory[0]?.score;
      expect(topScore).toBeDefined();
      expect(topScore as number).toBeGreaterThan(0.97);
      expect(result.diagnostics.queryPolicy).toBe("current_only");
      expect(result.diagnostics.queryVariants).toEqual([expect.objectContaining({ kind: "current_only", selected: true })]);
      expect(ftsSearch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses compact contextual anchors immediately for strongly underspecified turns", async () => {
    const entry = createEntry({
      id: "entry-context-required",
      subject: "duke identity",
      content: "Duke is Jim's dog.",
      importance: 8,
    });
    const ftsSearch = vi.fn<RecallPorts["ftsSearch"]>(async (params) => {
      if (params.text === "What about him?\nTopic: Duke is Jim's dog.") {
        return [
          {
            entry: toRecallCandidateDurable(entry),
            rank: -1,
            tier: "all_tokens",
          },
        ];
      }

      return [];
    });
    const deps = createDeps({
      ftsSearchImplementation: ftsSearch,
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What about him?",
        recentTurns: [{ role: "assistant", text: "Duke is Jim's dog." }],
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["entry-context-required"]);
    expect(result.diagnostics.queryPolicy).toBe("contextual_required");
    expect(result.diagnostics.queryVariants).toEqual([
      {
        kind: "contextual_anchor",
        query: "What about him?\nTopic: Duke is Jim's dog.",
        candidateCount: 1,
        selected: true,
      },
    ]);
    expect(ftsSearch).toHaveBeenCalledTimes(1);
  });

  it("keeps a clean identity entry ahead of adjacent relationship lore", async () => {
    const adjacent = createEntry({
      id: "duke-family-relationships",
      subject: "duke family relationships",
      content: "Family relationships: Duke is Jim's dog; Duke's cousins are Comet and Pepper.",
      importance: 10,
    });
    const identity = createEntry({
      id: "duke-identity",
      subject: "duke identity",
      content: "Duke is Jim's dog.",
      importance: 8,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(adjacent), toRecallCandidateDurable(identity)],
      hydratedEntries: [adjacent, identity],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who is Duke?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["duke-identity"]);
    expect(result.diagnostics.directness).toMatchObject({
      queryKind: "entity_definition",
      entity: "Duke",
      decision: "reranked",
      winnerEntryId: "duke-identity",
      runnerUpEntryId: "duke-family-relationships",
    });
    expect(result.diagnostics.directness?.candidates).toEqual([
      expect.objectContaining({
        entryId: "duke-identity",
        signals: expect.arrayContaining(["subject_identity_wrapper", "definitional_content"]),
      }),
      expect.objectContaining({
        entryId: "duke-family-relationships",
        signals: expect.arrayContaining(["definitional_content", "adjacent_relationship"]),
      }),
    ]);
  });

  it("accepts a relationship role statement when it is the best available answer", async () => {
    const familySummary = createEntry({
      id: "kurt-martin-family",
      subject: "kurt martin family",
      content: "Kurt Martin has two daughters and lives near Springtown.",
      importance: 10,
    });
    const relationshipRole = createEntry({
      id: "martin-family-relationships",
      subject: "martin family relationships",
      content: "Kurt Martin has two daughters. Kurt is the oldest brother in Springtown; Kevin is the Navy guy.",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(familySummary), toRecallCandidateDurable(relationshipRole)],
      hydratedEntries: [familySummary, relationshipRole],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who is Kurt?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["martin-family-relationships"]);
    expect(result.diagnostics.directness).toMatchObject({
      queryKind: "entity_definition",
      entity: "Kurt",
      decision: "reranked",
      winnerEntryId: "martin-family-relationships",
      runnerUpEntryId: "kurt-martin-family",
    });
    expect(result.diagnostics.directness?.candidates).toEqual([
      expect.objectContaining({
        entryId: "martin-family-relationships",
        signals: expect.arrayContaining(["definitional_content", "adjacent_relationship"]),
      }),
      expect.objectContaining({
        entryId: "kurt-martin-family",
        signals: expect.arrayContaining(["adjacent_relationship"]),
      }),
    ]);
  });

  it("accepts a full-name family summary for a short-name identity question", async () => {
    const familySummary = createEntry({
      id: "kevin-martin-family",
      subject: "kevin martin family",
      content: "Kevin Martin is married to Kate, and they have three children: Luke, Caroline, and Maddie.",
      importance: 10,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(familySummary)],
      hydratedEntries: [familySummary],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who is Kevin?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["kevin-martin-family"]);
    expect(result.diagnostics.directness).toMatchObject({
      queryKind: "entity_definition",
      entity: "Kevin",
      decision: "kept",
      winnerEntryId: "kevin-martin-family",
    });
    expect(result.diagnostics.directness?.candidates).toEqual([
      expect.objectContaining({
        entryId: "kevin-martin-family",
        signals: expect.arrayContaining(["definitional_content", "adjacent_relationship"]),
      }),
    ]);
  });

  it("widens the durable recall window for entity-definition turns before directness rerank", async () => {
    const cousins = createEntry({
      id: "duke-cousins",
      subject: "duke cousins",
      content: "Duke is cousins with Lady, Oliver, and Tucker.",
      importance: 6,
      created_at: "2026-04-05T05:20:47.357Z",
    });
    const bedNote = createEntry({
      id: "jim-and-duke",
      subject: "jim martin and duke",
      content: "Jim's dog Duke sleeps in Jim's bed at night, not just on the couch.",
      importance: 6,
      created_at: "2026-03-01T08:47:34.958Z",
    });
    const owner = createEntry({
      id: "jim-family-dogs",
      subject: "jim family dogs",
      content: "Duke is Jim's dog; Tucker and Oliver are his mom's golden doodles, and Lady is his dad's German Shepherd.",
      importance: 4,
      created_at: "2026-02-23T01:13:28.045Z",
      claim_key: "duke/owner",
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(cousins), toRecallCandidateDurable(bedNote), toRecallCandidateDurable(owner)],
      hydratedEntries: [cousins, bedNote, owner],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who is Duke?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["jim-family-dogs"]);
    expect(result.diagnostics.durableRecallCandidateCount).toBe(3);
    expect(result.diagnostics.directness).toMatchObject({
      queryKind: "entity_definition",
      entity: "Duke",
      winnerEntryId: "jim-family-dogs",
    });
    expect(result.diagnostics.directness?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: "jim-family-dogs",
          signals: expect.arrayContaining(["definitional_content", "claim_key_entity_match"]),
        }),
      ]),
    );
  });

  it("keeps a definitional winner when only the runner-up lacks identity signals", async () => {
    const relationshipDefinition = createEntry({
      id: "duke-family-relationships",
      subject: "duke family relationships",
      content: "Family relationships: Duke is Jim's dog; Duke's cousins are Comet and Pepper.",
      importance: 9,
    });
    const habits = createEntry({
      id: "duke-habits",
      subject: "duke habits",
      content: "Duke likes fetch and naps.",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(relationshipDefinition), toRecallCandidateDurable(habits)],
      hydratedEntries: [relationshipDefinition, habits],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who is Duke?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["duke-family-relationships"]);
    expect(result.diagnostics.directness).toMatchObject({
      queryKind: "entity_definition",
      entity: "Duke",
      decision: "kept",
      winnerEntryId: "duke-family-relationships",
      runnerUpEntryId: "duke-habits",
    });
    // The phase-4 small-pool RRF sharpening widens the relevance gap on
    // two-candidate pools, so the post-rerank `winnerGap` is larger than
    // the pre-phase-4 calibration (~0.05). The test still protects the
    // original intent — that the definitional winner sits clearly above
    // the identity-poor runner-up without hitting the too-close
    // abstention — by holding the gap below the post-sharpening ceiling.
    expect(result.diagnostics.directness?.winnerGap).toBeLessThan(0.12);
    expect(result.diagnostics.directness?.reason).not.toContain("too close after reranking");
    expect(result.diagnostics.directness?.candidates).toEqual([
      expect.objectContaining({
        entryId: "duke-family-relationships",
        signals: expect.arrayContaining(["definitional_content", "adjacent_relationship"]),
      }),
      expect.objectContaining({
        entryId: "duke-habits",
      }),
    ]);
    expect(result.diagnostics.directness?.candidates[1]?.signals).not.toContain("definitional_content");
    expect(result.diagnostics.directness?.candidates[1]?.signals).not.toContain("subject_entity_match");
    expect(result.diagnostics.directness?.candidates[1]?.signals).not.toContain("subject_identity_wrapper");
  });

  it("still abstains when two definitional candidates remain too close", async () => {
    const identity = createEntry({
      id: "duke-identity",
      subject: "duke identity",
      content: "Duke is Jim's dog.",
      importance: 9,
    });
    const biography = createEntry({
      id: "duke-biography",
      subject: "duke biography",
      content: "Duke is Jim's dog.",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(identity), toRecallCandidateDurable(biography)],
      hydratedEntries: [identity, biography],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who is Duke?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.diagnostics.directness).toMatchObject({
      queryKind: "entity_definition",
      entity: "Duke",
      decision: "abstained",
    });
    expect(result.diagnostics.directness?.reason).toContain("too close after reranking");
    expect(result.diagnostics.directness?.candidates).toEqual([
      expect.objectContaining({
        entryId: "duke-identity",
        signals: expect.arrayContaining(["subject_identity_wrapper", "definitional_content"]),
      }),
      expect.objectContaining({
        entryId: "duke-biography",
        signals: expect.arrayContaining(["subject_identity_wrapper", "definitional_content"]),
      }),
    ]);
  });

  it("abstains when definitional candidates stay indirect after directness rerank", async () => {
    const notes = createEntry({
      id: "duke-notes",
      subject: "duke notes",
      content: "Duke likes fetch and naps.",
      importance: 9,
    });
    const background = createEntry({
      id: "duke-background",
      subject: "duke background",
      content: "Duke enjoys long walks.",
      importance: 9,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(notes), toRecallCandidateDurable(background)],
      hydratedEntries: [notes, background],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who is Duke again?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.diagnostics.directness).toMatchObject({
      queryKind: "entity_definition",
      entity: "Duke",
      decision: "abstained",
    });
    expect(result.diagnostics.abstentionReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Before-turn directness check abstained for "Duke"'),
        "No durable memory entries cleared the before-turn threshold.",
      ]),
    );
  });

  it("does not apply definitional rerank to relationship questions", async () => {
    const adjacent = createEntry({
      id: "duke-cousins",
      subject: "duke cousins",
      content: "Duke's cousins are Comet and Pepper.",
      importance: 10,
    });
    const identity = createEntry({
      id: "duke-identity",
      subject: "duke identity",
      content: "Duke is Jim's dog.",
      importance: 8,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(adjacent), toRecallCandidateDurable(identity)],
      hydratedEntries: [adjacent, identity],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Who are Duke's cousins?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
          // Cap the durable window so the RRF-based high-confidence expansion
          // cannot surface the related identity entry alongside the primary
          // cousins hit; we only care that relationship questions skip the
          // definitional rerank path.
          maxHighConfidenceDurableEntries: 1,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["duke-cousins"]);
    expect(result.diagnostics.directness).toBeUndefined();
  });

  it("returns durable memory plus one canonical procedure suggestion when both are strong", async () => {
    const entry = createEntry({
      id: "entry-before-turn",
      type: "lesson",
      subject: "before-turn injection pattern",
      content: "Inject a bounded patch through prependContext rather than rebuilding a large persistent prompt block.",
      importance: 8,
    });
    const procedure = createProcedure({
      procedure_key: "agenr/before-turn-slice",
      title: "Implement the before-turn memory patch",
      goal: "Add the app contract, OpenClaw hook wiring, and tests for the before-turn slice.",
      when_to_use: ["Use this when implementing the post-sessionStart proactive surfacing slice."],
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(entry)],
      hydratedEntries: [entry],
      procedureFtsMatches: [{ procedure, rank: -1 }],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "How should I implement the before-turn memory patch after session start?",
        recentTurns: [{ role: "assistant", text: "We need a bounded, inspectable patch." }],
        policy: {
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory).toHaveLength(1);
    expect(result.procedure?.procedure.procedure_key).toBe("agenr/before-turn-slice");
    expect(result.procedure?.whySurfaced.summary).toContain("canonical procedure match");
    expect(result.diagnostics).toMatchObject({
      procedureRecallUsed: true,
      procedureCandidateCount: 1,
      abstained: false,
    });
  });

  it("abstains from procedure suggestion when top candidates are ambiguous", async () => {
    const alpha = createProcedure({
      procedure_key: "alpha/procedure",
      title: "Rotate the production signing key",
      goal: "Rotate the production signing key safely.",
    });
    const beta = createProcedure({
      procedure_key: "beta/procedure",
      title: "Rotate the production signing key",
      goal: "Rotate the production signing key safely.",
    });
    const deps = createDeps({
      procedureFtsMatches: [
        { procedure: alpha, rank: -1 },
        { procedure: beta, rank: -1 },
      ],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "How do I rotate the production signing key?",
        policy: {
          enableDurableRecall: false,
        },
      },
      deps,
    );

    expect(result.procedure).toBeUndefined();
    expect(result.diagnostics.procedureRecallUsed).toBe(true);
    expect(result.diagnostics.procedureCandidateCount).toBe(2);
    expect(result.diagnostics.abstentionReasons).toContain("No canonical procedure suggestion cleared the before-turn threshold.");
  });

  it("captures degraded lexical fallback notices when durable recall embeddings fail", async () => {
    const entry = createEntry({
      id: "entry-lexical",
      subject: "lexical fallback",
      content: "If embeddings fail, before-turn durable recall should degrade rather than abort.",
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(entry)],
      hydratedEntries: [entry],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What should happen if embeddings fail during before-turn recall?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      deps,
    );

    expect(result.diagnostics.notices).toEqual(expect.arrayContaining(["Embeddings failed during recall, so Agenr fell back to lexical-only entry ranking."]));
    expect(result.durableMemory).toHaveLength(1);
  });

  it("keeps the durable patch bounded and preserves rank order", async () => {
    const first = createEntry({
      id: "entry-1",
      subject: "first durable match",
      content: "First ranked durable result.",
      importance: 9,
    });
    const second = createEntry({
      id: "entry-2",
      subject: "second durable match",
      content: "Second ranked durable result.",
      importance: 8,
    });
    const third = createEntry({
      id: "entry-3",
      subject: "third durable match",
      content: "Third ranked durable result.",
      importance: 7,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(first), toRecallCandidateDurable(second), toRecallCandidateDurable(third)],
      hydratedEntries: [first, second, third],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "Find the most relevant durable matches for this turn.",
        policy: {
          maxDurableEntries: 2,
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["entry-1", "entry-2"]);
    expect(result.durableMemory.map((item) => item.rank)).toEqual([1, 2]);
    expect(result.diagnostics.durableRecallCandidateCount).toBe(2);
  });

  it("keeps only one durable item unless additional candidates are very high confidence", async () => {
    const first = createEntry({
      id: "entry-1",
      subject: "first durable match",
      content: "First ranked durable result.",
      importance: 9,
    });
    const second = createEntry({
      id: "entry-2",
      subject: "second durable match",
      content: "Second ranked durable result.",
      importance: 8,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(first), toRecallCandidateDurable(second)],
      hydratedEntries: [first, second],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What durable decisions should I reuse for this implementation?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
          maxDurableEntries: 1,
          maxHighConfidenceDurableEntries: 2,
          highConfidenceRecallThreshold: 1,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["entry-1"]);
    expect(result.diagnostics.notices).toContain("Before-turn durable recall kept the top 1 item because additional candidates were not high confidence.");
  });

  it("expands to a second durable item when all surfaced candidates are very high confidence", async () => {
    const first = createEntry({
      id: "entry-1",
      subject: "first durable match",
      content: "First ranked durable result.",
      importance: 9,
    });
    const second = createEntry({
      id: "entry-2",
      subject: "second durable match",
      content: "Second ranked durable result.",
      importance: 8,
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(first), toRecallCandidateDurable(second)],
      hydratedEntries: [first, second],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What durable decisions should I reuse for this implementation?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
          maxDurableEntries: 1,
          maxHighConfidenceDurableEntries: 2,
          highConfidenceRecallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["entry-1", "entry-2"]);
    expect(result.diagnostics.notices).toContain("Before-turn durable recall expanded to 2 high-confidence items.");
  });

  it("suppresses durable memory that violates an active abstain directive", async () => {
    const stanEntry = createEntry({
      id: "fact-stan",
      subject: "colleague preferences",
      content: "Stan prefers async standups and quiet afternoons.",
    });
    const directiveRow = createEntry({
      id: "dir-stan",
      subject: "memory directive",
      content: "Do not mention Stan.",
      claim_key: "user/memory_directive/do_not_mention_stan",
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(stanEntry)],
      hydratedEntries: [stanEntry],
      listActiveAbstainDirectives: vi.fn(async () => [directiveRow]),
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What does Stan prefer for standups?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.diagnostics.directiveAbstentions).toEqual([
      { entryId: "fact-stan", reason: "directive_topic", directiveId: "dir-stan", blockedTerm: "stan" },
    ]);
    expect(result.diagnostics.abstained).toBe(true);
  });

  it("surfaces proactive topic directives when the current turn mentions the topic", async () => {
    const proactiveDirective = createEntry({
      id: "dir-stan-topic",
      type: "directive",
      subject: "stan check-in directive",
      content: "When Stan comes up, ask whether his async standup preference still holds.",
      claim_key: "user/memory_directive/stan_check_in",
      directive_polarity: "proactive",
      directive_trigger: "topic:stan",
      expiry: "core",
      importance: 9,
    });
    const deps = createDeps({
      listActiveTopicProactiveDirectives: vi.fn(async () => [proactiveDirective]),
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What does Stan prefer for standups?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 1,
        },
      },
      deps,
    );

    expect(result.durableMemory).toMatchObject([
      {
        sourceKind: "directive",
        entry: { id: "dir-stan-topic" },
      },
    ]);
    expect(result.diagnostics.topicProactiveDirectiveCandidateCount).toBe(1);
    expect(result.diagnostics.topicProactiveDirectiveMatchedCount).toBe(1);
    expect(result.diagnostics.abstained).toBe(false);
  });

  it("suppresses proactive topic directives when an abstain directive blocks the same topic", async () => {
    const proactiveDirective = createEntry({
      id: "dir-stan-topic",
      type: "directive",
      subject: "stan check-in directive",
      content: "When Stan comes up, ask whether his async standup preference still holds.",
      claim_key: "user/memory_directive/stan_check_in",
      directive_polarity: "proactive",
      directive_trigger: "topic:stan",
      expiry: "core",
      importance: 9,
    });
    const abstainDirective = createEntry({
      id: "dir-no-stan",
      type: "directive",
      subject: "memory directive",
      content: "Do not mention Stan.",
      claim_key: "user/memory_directive/do_not_mention_stan",
      directive_polarity: "abstain",
      directive_trigger: "always",
      expiry: "core",
      importance: 10,
    });
    const deps = createDeps({
      listActiveTopicProactiveDirectives: vi.fn(async () => [proactiveDirective]),
      listActiveAbstainDirectives: vi.fn(async () => [abstainDirective]),
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What does Stan prefer for standups?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 1,
        },
      },
      deps,
    );

    expect(result.durableMemory).toEqual([]);
    expect(result.diagnostics.directiveAbstentions).toEqual([
      { entryId: "dir-stan-topic", reason: "directive_topic", directiveId: "dir-no-stan", blockedTerm: "stan" },
    ]);
    expect(result.diagnostics.abstained).toBe(true);
  });

  it("leaves durable memory untouched when no directive lookup is wired", async () => {
    const stanEntry = createEntry({
      id: "fact-stan",
      subject: "colleague preferences",
      content: "Stan prefers async standups and quiet afternoons.",
    });
    const deps = createDeps({
      ftsCandidates: [toRecallCandidateDurable(stanEntry)],
      hydratedEntries: [stanEntry],
    });

    const result = await runBeforeTurn(
      {
        currentTurnText: "What does Stan prefer for standups?",
        policy: {
          enableProcedureSuggestion: false,
          recallThreshold: 0,
        },
      },
      deps,
    );

    expect(result.durableMemory.map((item) => item.entry.id)).toEqual(["fact-stan"]);
    expect(result.diagnostics.directiveAbstentions).toBeUndefined();
  });
});

function createDeps(
  options: {
    ftsCandidates?: RecallCandidateDurable[];
    hydratedEntries?: Durable[];
    ftsSearchImplementation?: RecallPorts["ftsSearch"];
    procedureFtsMatches?: Array<{ procedure: Procedure; rank: number }>;
    procedureVectorMatches?: Array<{ procedure: Procedure; vectorSim: number }>;
    embedQuery?: BeforeTurnDeps["embedQuery"];
    listActiveAbstainDirectives?: BeforeTurnDeps["listActiveAbstainDirectives"];
    listActiveTopicProactiveDirectives?: BeforeTurnDeps["listActiveTopicProactiveDirectives"];
  } = {},
): BeforeTurnDeps & {
  procedures: ProcedureDatabasePort & {
    procedureFtsSearch: ReturnType<typeof vi.fn>;
    procedureVectorSearch: ReturnType<typeof vi.fn>;
  };
} {
  const recallEntries = new Map((options.hydratedEntries ?? []).map((entry) => [entry.id, entry]));
  const recall: RecallPorts = {
    embed: vi.fn(async () => {
      throw new Error("embeddings unavailable");
    }),
    vectorSearch: vi.fn(async () => []),
    ftsSearch:
      options.ftsSearchImplementation ??
      vi.fn(async (_params) =>
        (options.ftsCandidates ?? []).map((entry) => ({
          entry,
          rank: -1,
          tier: "all_tokens" as const,
        })),
      ),
    hydrateEntries: vi.fn(async (ids: string[]) => ids.flatMap((id) => recallEntries.get(id) ?? [])),
    recordRecallEvents: vi.fn(async () => undefined),
  };
  const procedures = createProcedureDatabase({
    procedureFtsSearch: vi.fn(async () => options.procedureFtsMatches ?? []),
    procedureVectorSearch: vi.fn(async () => options.procedureVectorMatches ?? []),
  });

  return {
    recall,
    procedures,
    ...(options.embedQuery ? { embedQuery: options.embedQuery } : {}),
    ...(options.listActiveAbstainDirectives ? { listActiveAbstainDirectives: options.listActiveAbstainDirectives } : {}),
    ...(options.listActiveTopicProactiveDirectives ? { listActiveTopicProactiveDirectives: options.listActiveTopicProactiveDirectives } : {}),
  };
}

function createProcedureDatabase(
  overrides: Partial<{
    procedureFtsSearch: ReturnType<typeof vi.fn>;
    procedureVectorSearch: ReturnType<typeof vi.fn>;
  }> = {},
): ProcedureDatabasePort & {
  procedureFtsSearch: ReturnType<typeof vi.fn>;
  procedureVectorSearch: ReturnType<typeof vi.fn>;
} {
  return {
    upsertProcedure: vi.fn(),
    getProcedure: vi.fn(),
    hydrateProcedures: vi.fn(),
    findActiveProcedureByKey: vi.fn(),
    procedureFtsSearch: overrides.procedureFtsSearch ?? vi.fn(async () => []),
    procedureVectorSearch: overrides.procedureVectorSearch ?? vi.fn(async () => []),
    listProceduresWithoutEmbeddings: vi.fn(),
    updateProcedureEmbedding: vi.fn(),
    closeProcedureValidity: vi.fn(),
    supersedeProcedure: vi.fn(),
    replaceProcedureRevision: vi.fn(),
  };
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
  const now = "2026-04-14T10:00:00.000Z";
  return finalizeTestDurable({
    id: overrides.id ?? "entry-1",
    type: overrides.type ?? "decision",
    subject: overrides.subject ?? "test subject",
    content: overrides.content ?? "test content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
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
    directive_polarity: overrides.directive_polarity,
    directive_trigger: overrides.directive_trigger,
    claim_key: overrides.claim_key,
    claim_key_raw: overrides.claim_key_raw,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_key_confidence: overrides.claim_key_confidence,
    claim_key_rationale: overrides.claim_key_rationale,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    user_id: overrides.user_id,
    project: overrides.project,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  });
}

function toRecallCandidateDurable(entry: Durable): RecallCandidateDurable {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    importance: entry.importance,
    expiry: entry.expiry,
    created_at: entry.created_at,
    embedding: entry.embedding,
    superseded_by: entry.superseded_by,
    claim_key: entry.claim_key,
    claim_key_status: entry.claim_key_status,
    claim_support_observed_at: entry.claim_support_observed_at,
    valid_from: entry.valid_from,
    valid_to: entry.valid_to,
  };
}

function createProcedure(overrides: Partial<Procedure> = {}): Procedure {
  const now = overrides.created_at ?? "2026-04-01T00:00:00.000Z";
  const body = {
    procedure_key: overrides.procedure_key ?? "agenr/release",
    title: overrides.title ?? "Release agenr and publish packages",
    goal: overrides.goal ?? "Cut a release and publish packages safely.",
    when_to_use: overrides.when_to_use ?? ["Use this when you need to ship a new agenr release."],
    when_not_to_use: overrides.when_not_to_use ?? ["Do not use this for a local dry run."],
    prerequisites: overrides.prerequisites ?? ["A clean repo state is available."],
    steps: overrides.steps ?? [
      {
        id: "read-doc",
        kind: "read_reference" as const,
        instruction: "Read the release procedure reference.",
        ref: {
          kind: "manual" as const,
          label: "release docs",
        },
      },
    ],
    verification: overrides.verification ?? ["The workflow completed successfully."],
    failure_modes: overrides.failure_modes ?? ["Validation fails before publish."],
    sources: overrides.sources ?? [
      {
        kind: "manual" as const,
        label: "fixture",
      },
    ],
  };

  return {
    id: overrides.id ?? randomUUID(),
    ...body,
    recall_text: overrides.recall_text ?? composeProcedureRecallText(body),
    revision_hash: overrides.revision_hash ?? computeProcedureRevisionHash(body),
    source_hash: overrides.source_hash ?? computeProcedureSourceHash(JSON.stringify(body)),
    source_file: overrides.source_file,
    embedding: overrides.embedding,
    superseded_by: overrides.superseded_by,
    created_at: now,
    updated_at: overrides.updated_at ?? now,
  };
}
