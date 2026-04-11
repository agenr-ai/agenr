import { describe, expect, it } from "vitest";

import { parseRecallEvalCaseRequest, RecallEvalRequestValidationError } from "../../../../src/adapters/api/validation/recall-eval-request.js";

describe("parseRecallEvalCaseRequest", () => {
  it("accepts and normalizes a valid recall eval case request", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "  case-001  ",
      description: "  simple recall case  ",
      recallPath: "unified",
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
      recallPath: "unified",
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
        rankingProfile: "historical_state",
      },
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
});
