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
