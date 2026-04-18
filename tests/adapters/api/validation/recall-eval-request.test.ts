import { describe, expect, it } from "vitest";

import { parseRecallEvalCaseRequest, RecallEvalRequestValidationError } from "../../../../src/adapters/api/validation/recall-eval-request.js";

describe("parseRecallEvalCaseRequest", () => {
  it("accepts and normalizes a valid recall eval case request", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "  case-001  ",
      description: "  simple recall case  ",
      recallPath: "core",
      sandbox: {
        root: "  /tmp/evals/case-001  ",
        preserve: false,
      },
      memoryPool: [
        {
          type: "fact",
          subject: "  API timeout  ",
          content: "  Increase timeout to 30s.  ",
          importance: 7,
          expiry: "permanent",
          tags: [" api ", "ops"],
          created_at: "2026-03-20T12:00:00.000Z",
        },
      ],
      recallRequest: {
        text: "  timeout guidance  ",
        limit: 5,
        threshold: 0.25,
        types: ["fact"],
        tags: [" api "],
        rankingProfile: "historical_state",
      },
      options: {
        includeDiagnostics: true,
        includeTimings: true,
      },
    });

    expect(result).toEqual({
      caseId: "case-001",
      description: "simple recall case",
      recallPath: "core",
      sandbox: {
        root: "/tmp/evals/case-001",
        preserve: false,
      },
      memoryPool: [
        {
          id: undefined,
          type: "fact",
          subject: "API timeout",
          content: "Increase timeout to 30s.",
          importance: 7,
          expiry: "permanent",
          tags: ["api", "ops"],
          source_file: undefined,
          source_context: undefined,
          created_at: "2026-03-20T12:00:00.000Z",
          updated_at: undefined,
          retired: undefined,
          retired_at: undefined,
          retired_reason: undefined,
          superseded_by: undefined,
          claim_key: undefined,
          claim_key_status: undefined,
          claim_key_source: undefined,
          claim_support_source_kind: undefined,
          claim_support_locator: undefined,
          claim_support_observed_at: undefined,
          claim_support_mode: undefined,
          valid_from: undefined,
          valid_to: undefined,
          supersession_kind: undefined,
          supersession_reason: undefined,
        },
      ],
      recallRequest: {
        text: "timeout guidance",
        limit: 5,
        threshold: 0.25,
        budget: undefined,
        types: ["fact"],
        tags: ["api"],
        since: undefined,
        until: undefined,
        around: undefined,
        aroundRadius: undefined,
        asOf: undefined,
        rankingProfile: "historical_state",
        rankingPolicy: undefined,
      },
      unified: undefined,
      options: {
        includeDiagnostics: true,
        includeCandidates: undefined,
        includeTimings: true,
      },
    });
  });

  it("rejects requests that omit required top-level fields", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        description: "missing required fields",
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        description: "missing required fields",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "caseId",
          message: "Expected a non-empty string.",
        },
        {
          path: "memoryPool",
          message: "Expected an array of fixture entries.",
        },
        {
          path: "recallRequest",
          message: "Expected an object.",
        },
      ]);
    }
  });

  it("rejects malformed fixture entries", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-002",
        memoryPool: [
          {
            type: "invalid",
            subject: "subject",
            content: "",
            importance: 42,
          },
        ],
        recallRequest: {
          text: "question",
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-002",
        memoryPool: [
          {
            type: "invalid",
            subject: "subject",
            content: "",
            importance: 42,
          },
        ],
        recallRequest: {
          text: "question",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "memoryPool[0].type",
          message: "Expected one of: fact, decision, preference, lesson, relationship, milestone.",
        },
        {
          path: "memoryPool[0].content",
          message: "Expected a non-empty string.",
        },
      ]);
    }
  });

  it("accepts claim-key lineage fixture fields for deterministic eval cases", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "case-claim-lineage",
      memoryPool: [
        {
          id: "entry-old",
          type: "decision",
          subject: "deployment approach",
          content: "Webpack was the previous deployment approach.",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          claim_key_source: "manual",
          claim_support_source_kind: "tool_call",
          claim_support_locator: "fixture://case-claim-lineage",
          claim_support_observed_at: "2026-03-01T00:00:00.000Z",
          claim_support_mode: "explicit",
          valid_from: "2026-02-01T00:00:00.000Z",
          valid_to: "2026-03-20T00:00:00.000Z",
          superseded_by: "entry-new",
          supersession_kind: "update",
          supersession_reason: "Migration completed.",
        },
      ],
      recallRequest: {
        text: "what was the previous deployment approach",
      },
    });

    expect(result.memoryPool[0]).toMatchObject({
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_support_source_kind: "tool_call",
      claim_support_mode: "explicit",
      valid_from: "2026-02-01T00:00:00.000Z",
      valid_to: "2026-03-20T00:00:00.000Z",
      supersession_kind: "update",
      supersession_reason: "Migration completed.",
    });
  });

  it("accepts unified caller context with slot-policy overrides", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "case-unified-context",
      recallPath: "unified",
      memoryPool: [],
      recallRequest: {
        text: "what was the previous repository owner",
        limit: 3,
        asOf: "2026-03-01T00:00:00.000Z",
      },
      unified: {
        mode: "entries",
        sessionKey: "agent:test:tui",
        memoryPolicy: {
          slotPolicies: {
            attributeHeads: {
              owner: "multivalued",
            },
          },
        },
      },
    });

    expect(result).toEqual({
      caseId: "case-unified-context",
      description: undefined,
      recallPath: "unified",
      sandbox: undefined,
      memoryPool: [],
      recallRequest: {
        text: "what was the previous repository owner",
        limit: 3,
        threshold: undefined,
        budget: undefined,
        types: undefined,
        tags: undefined,
        since: undefined,
        until: undefined,
        around: undefined,
        aroundRadius: undefined,
        asOf: "2026-03-01T00:00:00.000Z",
        rankingProfile: undefined,
        rankingPolicy: undefined,
      },
      unified: {
        mode: "entries",
        sessionKey: "agent:test:tui",
        memoryPolicy: {
          slotPolicies: {
            attributeHeads: {
              owner: "multivalued",
            },
          },
        },
      },
      options: undefined,
    });
  });

  it("accepts internal fault-injection controls for deterministic degraded evals", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "case-fault-injection",
      memoryPool: [],
      recallRequest: {
        text: "who is on call",
      },
      options: {
        includeDiagnostics: true,
        faultInjection: {
          queryEmbeddingFailure: true,
          vectorSearchFailure: false,
        },
      },
    });

    expect(result.options).toEqual({
      includeDiagnostics: true,
      includeCandidates: undefined,
      includeTimings: undefined,
      faultInjection: {
        queryEmbeddingFailure: true,
        vectorSearchFailure: false,
      },
    });
  });

  it("rejects malformed recall request fields", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-003",
        recallPath: "sideways",
        memoryPool: [],
        recallRequest: {
          text: "what changed?",
          limit: -1,
          threshold: 2,
          types: ["fact", "bogus"],
          rankingProfile: "invalid",
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-003",
        recallPath: "sideways",
        memoryPool: [],
        recallRequest: {
          text: "what changed?",
          limit: -1,
          threshold: 2,
          types: ["fact", "bogus"],
          rankingProfile: "invalid",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "recallPath",
          message: "Expected one of: core, unified.",
        },
        {
          path: "recallRequest.limit",
          message: "Expected a non-negative integer.",
        },
        {
          path: "recallRequest.threshold",
          message: "Expected a number from 0 to 1.",
        },
        {
          path: "recallRequest.types[1]",
          message: "Expected one of: fact, decision, preference, lesson, relationship, milestone.",
        },
        {
          path: "recallRequest.rankingProfile",
          message: "Expected one of: historical_state.",
        },
      ]);
    }
  });

  it("rejects unified-only caller context on the core path", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-core-with-unified",
        recallPath: "core",
        memoryPool: [],
        recallRequest: {
          text: "who owns the repository",
        },
        unified: {
          mode: "entries",
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-core-with-unified",
        recallPath: "core",
        memoryPool: [],
        recallRequest: {
          text: "who owns the repository",
        },
        unified: {
          mode: "entries",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "unified",
          message: 'The "unified" block is only allowed when recallPath is "unified".',
        },
      ]);
    }
  });

  it("rejects core-only recall controls on the unified path", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-unified-core-controls",
        recallPath: "unified",
        memoryPool: [],
        recallRequest: {
          text: "what was the previous repository owner",
          budget: 50,
          since: "2026-01-01T00:00:00.000Z",
          until: "2026-04-01T00:00:00.000Z",
          around: "2026-03-01T00:00:00.000Z",
          aroundRadius: 14,
          rankingProfile: "historical_state",
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-unified-core-controls",
        recallPath: "unified",
        memoryPool: [],
        recallRequest: {
          text: "what was the previous repository owner",
          budget: 50,
          since: "2026-01-01T00:00:00.000Z",
          until: "2026-04-01T00:00:00.000Z",
          around: "2026-03-01T00:00:00.000Z",
          aroundRadius: 14,
          rankingProfile: "historical_state",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "recallRequest.budget",
          message: 'This field is only supported when recallPath is "core".',
        },
        {
          path: "recallRequest.since",
          message: 'This field is only supported when recallPath is "core".',
        },
        {
          path: "recallRequest.until",
          message: 'This field is only supported when recallPath is "core".',
        },
        {
          path: "recallRequest.around",
          message: 'This field is only supported when recallPath is "core".',
        },
        {
          path: "recallRequest.aroundRadius",
          message: 'This field is only supported when recallPath is "core".',
        },
        {
          path: "recallRequest.rankingProfile",
          message: 'This field is derived by unified recall and cannot be supplied when recallPath is "unified".',
        },
      ]);
    }
  });

  it("rejects unexpected fields so the HTTP seam stays narrow", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-004",
        extraTopLevel: true,
        sandbox: {
          root: "/tmp/evals/case-004",
          extraSandbox: true,
        },
        memoryPool: [
          {
            type: "fact",
            subject: "subject",
            content: "content",
            extraFixture: true,
          },
        ],
        recallRequest: {
          text: "question",
          extraRecall: true,
        },
        options: {
          includeDiagnostics: true,
          extraOption: true,
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-004",
        extraTopLevel: true,
        sandbox: {
          root: "/tmp/evals/case-004",
          extraSandbox: true,
        },
        memoryPool: [
          {
            type: "fact",
            subject: "subject",
            content: "content",
            extraFixture: true,
          },
        ],
        recallRequest: {
          text: "question",
          extraRecall: true,
        },
        options: {
          includeDiagnostics: true,
          extraOption: true,
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "extraTopLevel",
          message: "Unexpected field.",
        },
        {
          path: "sandbox.extraSandbox",
          message: "Unexpected field.",
        },
        {
          path: "memoryPool[0].extraFixture",
          message: "Unexpected field.",
        },
        {
          path: "recallRequest.extraRecall",
          message: "Unexpected field.",
        },
        {
          path: "options.extraOption",
          message: "Unexpected field.",
        },
      ]);
    }
  });

  it("accepts a full ranking-policy override with every stage toggle and tuning knob", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "case-ranking-policy-full",
      memoryPool: [],
      recallRequest: {
        text: "how do we handle timeouts",
        rankingPolicy: {
          rrf: "enabled",
          rrfRankConstant: 42,
          neighborhood: "disabled",
          mmr: "enabled",
          mmrLambda: 0.4,
          crossEncoder: "enabled",
          crossEncoderTopK: 12,
          crossEncoderAlpha: 0.7,
        },
      },
    });

    expect(result.recallRequest.rankingPolicy).toEqual({
      rrf: "enabled",
      rrfRankConstant: 42,
      neighborhood: "disabled",
      mmr: "enabled",
      mmrLambda: 0.4,
      crossEncoder: "enabled",
      crossEncoderTopK: 12,
      crossEncoderAlpha: 0.7,
    });
  });

  it("accepts a partial ranking-policy override so evals can A/B a single stage", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "case-ranking-policy-partial",
      memoryPool: [],
      recallRequest: {
        text: "who is on call",
        rankingPolicy: {
          mmr: "disabled",
        },
      },
    });

    expect(result.recallRequest.rankingPolicy).toEqual({
      mmr: "disabled",
    });
  });

  it("normalizes an empty ranking-policy block to undefined", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "case-ranking-policy-empty",
      memoryPool: [],
      recallRequest: {
        text: "who is on call",
        rankingPolicy: {},
      },
    });

    expect(result.recallRequest.rankingPolicy).toBeUndefined();
  });

  it("surfaces ranking-policy fields through the unified path so evals can tune either surface", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "case-ranking-policy-unified",
      recallPath: "unified",
      memoryPool: [],
      recallRequest: {
        text: "how do we handle timeouts",
        rankingPolicy: {
          crossEncoder: "disabled",
        },
      },
      unified: {
        mode: "auto",
      },
    });

    expect(result.recallRequest.rankingPolicy).toEqual({
      crossEncoder: "disabled",
    });
  });

  it("rejects malformed ranking-policy fields with stable paths", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-ranking-policy-invalid",
        memoryPool: [],
        recallRequest: {
          text: "question",
          rankingPolicy: {
            rrf: "sometimes",
            rrfRankConstant: 0,
            neighborhood: true,
            mmr: "bogus",
            mmrLambda: 1.5,
            crossEncoder: "yes",
            crossEncoderTopK: -1,
            crossEncoderAlpha: 2,
            extra: true,
          },
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-ranking-policy-invalid",
        memoryPool: [],
        recallRequest: {
          text: "question",
          rankingPolicy: {
            rrf: "sometimes",
            rrfRankConstant: 0,
            neighborhood: true,
            mmr: "bogus",
            mmrLambda: 1.5,
            crossEncoder: "yes",
            crossEncoderTopK: -1,
            crossEncoderAlpha: 2,
            extra: true,
          },
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "recallRequest.rankingPolicy.extra",
          message: "Unexpected field.",
        },
        {
          path: "recallRequest.rankingPolicy.rrf",
          message: "Expected one of: enabled, disabled.",
        },
        {
          path: "recallRequest.rankingPolicy.rrfRankConstant",
          message: "Expected a positive integer.",
        },
        {
          path: "recallRequest.rankingPolicy.neighborhood",
          message: "Expected one of: enabled, disabled.",
        },
        {
          path: "recallRequest.rankingPolicy.mmr",
          message: "Expected one of: enabled, disabled.",
        },
        {
          path: "recallRequest.rankingPolicy.mmrLambda",
          message: "Expected a number from 0 to 1.",
        },
        {
          path: "recallRequest.rankingPolicy.crossEncoder",
          message: "Expected one of: enabled, disabled.",
        },
        {
          path: "recallRequest.rankingPolicy.crossEncoderTopK",
          message: "Expected a positive integer.",
        },
        {
          path: "recallRequest.rankingPolicy.crossEncoderAlpha",
          message: "Expected a number from 0 to 1.",
        },
      ]);
    }
  });

  it("rejects malformed fault-injection options", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-fault-injection-invalid",
        memoryPool: [],
        recallRequest: {
          text: "who is on call",
        },
        options: {
          faultInjection: {
            queryEmbeddingFailure: "yes",
            extraFault: true,
          },
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-fault-injection-invalid",
        memoryPool: [],
        recallRequest: {
          text: "who is on call",
        },
        options: {
          faultInjection: {
            queryEmbeddingFailure: "yes",
            extraFault: true,
          },
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
        {
          path: "options.faultInjection.extraFault",
          message: "Unexpected field.",
        },
        {
          path: "options.faultInjection.queryEmbeddingFailure",
          message: "Expected a boolean.",
        },
      ]);
    }
  });
});
