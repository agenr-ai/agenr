import { describe, expect, it } from "vitest";

import { parseRecallEvalCaseRequest, RecallEvalRequestValidationError } from "../../../../src/adapters/api/validation/recall-eval-request.js";

describe("parseRecallEvalCaseRequest", () => {
  it("accepts and normalizes a valid recall eval case request", () => {
    const result = parseRecallEvalCaseRequest({
      caseId: "  case-001  ",
      description: "  simple recall case  ",
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
      },
      options: {
        includeDiagnostics: true,
        includeTimings: true,
      },
    });

    expect(result).toEqual({
      caseId: "case-001",
      description: "simple recall case",
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

  it("rejects malformed recall request fields", () => {
    expect(() =>
      parseRecallEvalCaseRequest({
        caseId: "case-003",
        memoryPool: [],
        recallRequest: {
          text: "what changed?",
          limit: -1,
          threshold: 2,
          types: ["fact", "bogus"],
        },
      }),
    ).toThrowError(RecallEvalRequestValidationError);

    try {
      parseRecallEvalCaseRequest({
        caseId: "case-003",
        memoryPool: [],
        recallRequest: {
          text: "what changed?",
          limit: -1,
          threshold: 2,
          types: ["fact", "bogus"],
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RecallEvalRequestValidationError);
      expect((error as RecallEvalRequestValidationError).issues).toEqual([
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
