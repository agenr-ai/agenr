import { describe, expect, it } from "vitest";

import {
  mapBeforeTurnEvalCaseRequestDto,
  parseBeforeTurnEvalCaseRequest,
  BeforeTurnEvalRequestValidationError,
} from "../../../../src/adapters/api/validation/before-turn-eval-request.js";

describe("parseBeforeTurnEvalCaseRequest", () => {
  it("accepts and normalizes a valid before-turn eval case request", () => {
    const result = parseBeforeTurnEvalCaseRequest({
      caseId: "  case-001  ",
      description: "  simple before-turn case  ",
      sandbox: {
        root: "  /tmp/evals/case-001  ",
        preserve: true,
      },
      memoryPool: [
        {
          type: "fact",
          subject: "  duke identity  ",
          content: "  Duke is Jim's dog.  ",
          tags: [" pets ", "identity"],
        },
      ],
      procedurePool: [
        {
          procedure_key: "security/signing-key-rotation",
          title: "  Rotate the production signing key  ",
          goal: "  Rotate the production signing key safely.  ",
          steps: [
            {
              id: "inspect-state",
              kind: "inspect_state",
              instruction: "Inspect the current signing key state before rotating it.",
              target: "signing key state",
            },
          ],
          verification: [" Downstream verification succeeds after rotation. "],
          failure_modes: [" Rotation fails before verification completes. "],
        },
      ],
      beforeTurnInput: {
        sessionKey: "  agent:main:test  ",
        currentTurnText: "  who is Duke?  ",
        recentTurns: [
          {
            role: " assistant ",
            text: "  We were just talking about dogs.  ",
          },
        ],
        trigger: "  user  ",
        policy: {
          enableDurableRecall: true,
          enableProcedureSuggestion: false,
          maxRecentTurns: 2,
          maxQueryChars: 450,
          maxDurableEntries: 1,
          maxHighConfidenceDurableEntries: 2,
          maxProcedureCandidates: 3,
          recallThreshold: 0.25,
          highConfidenceRecallThreshold: 0.9,
          procedureThreshold: 0.7,
          skipTrivialTurns: false,
          requireTurnSignal: false,
        },
      },
      options: {
        includeDiagnostics: true,
        includeRenderedPatch: true,
        includeTimings: true,
      },
    });

    expect(result).toEqual({
      caseId: "case-001",
      description: "simple before-turn case",
      sandbox: {
        root: "/tmp/evals/case-001",
        preserve: true,
      },
      memoryPool: [
        expect.objectContaining({
          subject: "duke identity",
          content: "Duke is Jim's dog.",
          tags: ["pets", "identity"],
        }),
      ],
      procedurePool: [
        expect.objectContaining({
          procedure_key: "security/signing-key-rotation",
          title: "Rotate the production signing key",
          goal: "Rotate the production signing key safely.",
          verification: ["Downstream verification succeeds after rotation."],
          failure_modes: ["Rotation fails before verification completes."],
        }),
      ],
      beforeTurnInput: {
        sessionKey: "agent:main:test",
        currentTurnText: "  who is Duke?  ",
        recentTurns: [
          {
            role: "assistant",
            text: "  We were just talking about dogs.  ",
          },
        ],
        trigger: "user",
        policy: {
          enableDurableRecall: true,
          enableProcedureSuggestion: false,
          maxRecentTurns: 2,
          maxQueryChars: 450,
          maxDurableEntries: 1,
          maxHighConfidenceDurableEntries: 2,
          maxProcedureCandidates: 3,
          recallThreshold: 0.25,
          highConfidenceRecallThreshold: 0.9,
          procedureThreshold: 0.7,
          skipTrivialTurns: false,
          requireTurnSignal: false,
        },
      },
      options: {
        includeDiagnostics: true,
        includeRenderedPatch: true,
        includeTimings: true,
      },
    });

    expect(mapBeforeTurnEvalCaseRequestDto(result)).toMatchObject({
      caseId: "case-001",
      beforeTurnInput: {
        currentTurnText: "  who is Duke?  ",
        policy: {
          maxHighConfidenceDurableEntries: 2,
          highConfidenceRecallThreshold: 0.9,
          skipTrivialTurns: false,
          requireTurnSignal: false,
        },
      },
      options: {
        includeRenderedPatch: true,
      },
    });
  });

  it("rejects unexpected top-level fields", () => {
    expect(() =>
      parseBeforeTurnEvalCaseRequest({
        caseId: "case-extra",
        memoryPool: [],
        beforeTurnInput: {
          currentTurnText: "hello",
        },
        extra: true,
      }),
    ).toThrowError(BeforeTurnEvalRequestValidationError);
  });

  it("rejects invalid recent-turn fields", () => {
    try {
      parseBeforeTurnEvalCaseRequest({
        caseId: "case-recent-turns",
        memoryPool: [],
        beforeTurnInput: {
          currentTurnText: "who is Duke?",
          recentTurns: [
            {
              role: "system",
              text: 42,
            },
          ],
        },
      });
      expect.unreachable("Expected validation failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(BeforeTurnEvalRequestValidationError);
      expect((error as BeforeTurnEvalRequestValidationError).issues).toEqual([
        {
          path: "beforeTurnInput.recentTurns[0].role",
          message: 'Expected "user" or "assistant".',
        },
        {
          path: "beforeTurnInput.recentTurns[0].text",
          message: "Expected a string.",
        },
      ]);
    }
  });

  it("accepts an explicit fixture corpus-seed block on the sandbox", () => {
    const result = parseBeforeTurnEvalCaseRequest({
      caseId: "case-before-turn-fixture-seed",
      sandbox: {
        corpusSeed: { mode: "fixture" },
      },
      memoryPool: [],
      beforeTurnInput: {
        currentTurnText: "who is Duke?",
      },
    });

    expect(result.sandbox).toEqual({
      root: undefined,
      preserve: undefined,
      corpusSeed: { mode: "fixture" },
    });
    expect(mapBeforeTurnEvalCaseRequestDto(result).sandbox?.corpusSeed).toEqual({
      mode: "fixture",
    });
  });

  it("accepts a snapshot_copy corpus-seed block with full provenance hints", () => {
    const result = parseBeforeTurnEvalCaseRequest({
      caseId: "case-before-turn-snapshot-seed",
      sandbox: {
        root: "/tmp/evals/before-turn-snapshot",
        preserve: false,
        corpusSeed: {
          mode: "snapshot_copy",
          snapshotDbPath: "  /tmp/snapshots/knowledge-2026-04-18.db  ",
          snapshotId: "  nightly-2026-04-18  ",
          snapshotLabel: "  nightly corpus snapshot  ",
          allowTelemetryWrites: true,
        },
      },
      memoryPool: [],
      beforeTurnInput: {
        currentTurnText: "who is on call?",
      },
    });

    expect(result.sandbox).toEqual({
      root: "/tmp/evals/before-turn-snapshot",
      preserve: false,
      corpusSeed: {
        mode: "snapshot_copy",
        snapshotDbPath: "/tmp/snapshots/knowledge-2026-04-18.db",
        snapshotId: "nightly-2026-04-18",
        snapshotLabel: "nightly corpus snapshot",
        allowTelemetryWrites: true,
      },
    });
    expect(mapBeforeTurnEvalCaseRequestDto(result).sandbox?.corpusSeed).toEqual({
      mode: "snapshot_copy",
      snapshotDbPath: "/tmp/snapshots/knowledge-2026-04-18.db",
      snapshotId: "nightly-2026-04-18",
      snapshotLabel: "nightly corpus snapshot",
      allowTelemetryWrites: true,
    });
  });

  it("rejects malformed corpus-seed blocks with stable paths", () => {
    try {
      parseBeforeTurnEvalCaseRequest({
        caseId: "case-before-turn-corpus-seed-invalid",
        sandbox: {
          corpusSeed: {
            mode: "snapshot_copy",
            snapshotDbPath: "   ",
            snapshotId: 42,
            allowTelemetryWrites: "yes",
            extraField: true,
          },
        },
        memoryPool: [],
        beforeTurnInput: {
          currentTurnText: "who is on call?",
        },
      });
      expect.unreachable("Expected validation failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(BeforeTurnEvalRequestValidationError);
      expect((error as BeforeTurnEvalRequestValidationError).issues).toEqual([
        {
          path: "sandbox.corpusSeed.extraField",
          message: "Unexpected field.",
        },
        {
          path: "sandbox.corpusSeed.snapshotDbPath",
          message: "Expected a non-empty string.",
        },
        {
          path: "sandbox.corpusSeed.snapshotId",
          message: "Expected a string.",
        },
        {
          path: "sandbox.corpusSeed.allowTelemetryWrites",
          message: "Expected a boolean.",
        },
      ]);
    }
  });

  it("rejects unknown corpus-seed modes", () => {
    try {
      parseBeforeTurnEvalCaseRequest({
        caseId: "case-before-turn-corpus-seed-mode",
        sandbox: {
          corpusSeed: {
            mode: "snapshot_link",
            snapshotDbPath: "/tmp/snapshots/knowledge.db",
          },
        },
        memoryPool: [],
        beforeTurnInput: {
          currentTurnText: "who is on call?",
        },
      });
      expect.unreachable("Expected validation failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(BeforeTurnEvalRequestValidationError);
      expect((error as BeforeTurnEvalRequestValidationError).issues).toEqual([
        {
          path: "sandbox.corpusSeed.mode",
          message: "Expected one of: fixture, snapshot_copy.",
        },
      ]);
    }
  });

  it("accepts the debug-artifact options with a bounded top-K override", () => {
    const result = parseBeforeTurnEvalCaseRequest({
      caseId: "case-before-turn-debug-artifact",
      memoryPool: [],
      beforeTurnInput: {
        currentTurnText: "who is Duke?",
      },
      options: {
        includeDebugArtifact: true,
        topKCandidates: 3,
      },
    });

    expect(result.options).toMatchObject({
      includeDebugArtifact: true,
      topKCandidates: 3,
    });
  });

  it("rejects debug-artifact top-K values above the maximum", () => {
    try {
      parseBeforeTurnEvalCaseRequest({
        caseId: "case-before-turn-debug-too-large",
        memoryPool: [],
        beforeTurnInput: {
          currentTurnText: "who is Duke?",
        },
        options: {
          includeDebugArtifact: true,
          topKCandidates: 500,
        },
      });
      expect.unreachable("Expected validation failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(BeforeTurnEvalRequestValidationError);
      expect((error as BeforeTurnEvalRequestValidationError).issues).toEqual([
        {
          path: "options.topKCandidates",
          message: "Expected an integer from 1 to 25.",
        },
      ]);
    }
  });

  it("rejects debug-artifact top-K values below the minimum", () => {
    try {
      parseBeforeTurnEvalCaseRequest({
        caseId: "case-before-turn-debug-zero",
        memoryPool: [],
        beforeTurnInput: {
          currentTurnText: "who is Duke?",
        },
        options: {
          topKCandidates: 0,
        },
      });
      expect.unreachable("Expected validation failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(BeforeTurnEvalRequestValidationError);
      expect((error as BeforeTurnEvalRequestValidationError).issues).toEqual([
        {
          path: "options.topKCandidates",
          message: "Expected an integer from 1 to 25.",
        },
      ]);
    }
  });

  it("rejects malformed procedure fixtures", () => {
    try {
      parseBeforeTurnEvalCaseRequest({
        caseId: "case-procedure-invalid",
        memoryPool: [],
        procedurePool: [
          {
            procedure_key: "security/signing-key-rotation",
            title: "Rotate the production signing key",
            goal: "Rotate the production signing key safely.",
            steps: [],
            verification: [],
            failure_modes: [],
          },
        ],
        beforeTurnInput: {
          currentTurnText: "How do I rotate the production signing key?",
        },
      });
      expect.unreachable("Expected validation failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(BeforeTurnEvalRequestValidationError);
      expect((error as BeforeTurnEvalRequestValidationError).issues).toEqual([
        {
          path: "procedurePool[0]",
          message: expect.stringContaining("steps"),
        },
      ]);
    }
  });
});
