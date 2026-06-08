import { describe, expect, it } from "vitest";

import { WebApiError } from "../../../../src/adapters/web/api-error.js";
import type { ValidationIssue } from "../../../../src/adapters/shared/validation.js";
import {
  parseDreamStartBody,
  parseDurableListQuery,
  parseProcedureSaveBody,
  parseProcedureValidateBody,
  parseRegisterInstanceBody,
  parseReviewBody,
  parseStoreDurableBody,
  parseUpdateEpisodeMetadataBody,
  parseUpdateMetadataBody,
} from "../../../../src/adapters/web/validation/requests.js";

/** Runs a parser expected to throw and returns its collected issues. */
function captureIssues(fn: () => unknown): ValidationIssue[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WebApiError);
    expect((error as WebApiError).statusCode).toBe(400);
    return (error as WebApiError).issues ?? [];
  }
  throw new Error("Expected the parser to throw a WebApiError.");
}

/** Returns the set of issue paths for terse membership assertions. */
function paths(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

describe("parseStoreDurableBody", () => {
  it("normalizes a valid store body", () => {
    const result = parseStoreDurableBody({
      type: "decision",
      subject: "  Deploy approach  ",
      content: "  Use blue-green deploys.  ",
      importance: 8,
      expiry: "permanent",
      tags: [" ops ", "deploy"],
      project: " infra ",
      claimKey: " deploy/approach ",
    });

    expect(result.durable).toEqual({
      type: "decision",
      subject: "Deploy approach",
      content: "Use blue-green deploys.",
      importance: 8,
      expiry: "permanent",
      tags: ["ops", "deploy"],
      project: "infra",
      claim_key: "deploy/approach",
    });
  });

  it("rejects unexpected fields so the boundary stays narrow", () => {
    const issues = captureIssues(() =>
      parseStoreDurableBody({ type: "fact", subject: "s", content: "c", surprise: true }),
    );
    expect(issues).toContainEqual({ path: "surprise", message: "Unexpected field." });
  });

  it("rejects a missing subject and content", () => {
    const issues = captureIssues(() => parseStoreDurableBody({ type: "fact" }));
    expect(paths(issues)).toEqual(expect.arrayContaining(["subject", "content"]));
  });

  it("rejects an unsupported durable type", () => {
    const issues = captureIssues(() => parseStoreDurableBody({ type: "rumor", subject: "s", content: "c" }));
    expect(paths(issues)).toContain("type");
  });

  it("rejects a non-object body", () => {
    const issues = captureIssues(() => parseStoreDurableBody("not an object"));
    expect(paths(issues)).toContain("$");
  });
});

describe("parseUpdateMetadataBody", () => {
  it("accepts a single metadata field", () => {
    expect(parseUpdateMetadataBody({ importance: 5 })).toEqual({ importance: 5 });
  });

  it("preserves empty clearable durable metadata fields", () => {
    expect(parseUpdateMetadataBody({ project: "", validTo: "" })).toEqual({ project: "", validTo: "" });
  });

  it("requires at least one field", () => {
    const issues = captureIssues(() => parseUpdateMetadataBody({}));
    expect(paths(issues)).toContain("$");
  });

  it("rejects an unsupported expiry tier", () => {
    const issues = captureIssues(() => parseUpdateMetadataBody({ expiry: "forever" }));
    expect(paths(issues)).toContain("expiry");
  });

  it("rejects unexpected metadata fields", () => {
    const issues = captureIssues(() => parseUpdateMetadataBody({ content: "no in-place edits" }));
    expect(issues).toContainEqual({ path: "content", message: "Unexpected field." });
  });
});

describe("parseUpdateEpisodeMetadataBody", () => {
  it("accepts editable episode metadata fields", () => {
    expect(
      parseUpdateEpisodeMetadataBody({
        project: " agenr ",
        activityLevel: "substantial",
        tags: [" web ", " console "],
        sourceRef: " transcript.jsonl ",
        validTo: "",
      }),
    ).toEqual({
      project: "agenr",
      activityLevel: "substantial",
      tags: ["web", "console"],
      sourceRef: "transcript.jsonl",
      validTo: "",
    });
  });

  it("accepts empty activity and tags as clear operations", () => {
    expect(parseUpdateEpisodeMetadataBody({ activityLevel: "", tags: [] })).toEqual({ activityLevel: "", tags: [] });
  });

  it("rejects unsupported activity levels", () => {
    const issues = captureIssues(() => parseUpdateEpisodeMetadataBody({ activityLevel: "busy" }));
    expect(paths(issues)).toContain("activityLevel");
  });

  it("rejects unexpected episode metadata fields", () => {
    const issues = captureIssues(() => parseUpdateEpisodeMetadataBody({ summary: "no in-place edits" }));
    expect(issues).toContainEqual({ path: "summary", message: "Unexpected field." });
  });
});

describe("parseReviewBody", () => {
  it("accepts a valid apply decision with a reason", () => {
    expect(parseReviewBody({ decision: "apply", reason: "Lineage is correct." })).toEqual({
      decision: "apply",
      reason: "Lineage is correct.",
    });
  });

  it("requires a non-empty reason", () => {
    const issues = captureIssues(() => parseReviewBody({ decision: "reject", reason: "   " }));
    expect(paths(issues)).toContain("reason");
  });

  it("rejects an unknown decision", () => {
    const issues = captureIssues(() => parseReviewBody({ decision: "maybe", reason: "later" }));
    expect(paths(issues)).toContain("decision");
  });
});

describe("parseDreamStartBody", () => {
  it("accepts a tier and apply flag", () => {
    expect(parseDreamStartBody({ tier: "standard", apply: true })).toEqual({ tier: "standard", apply: true });
  });

  it("defaults apply to false when omitted", () => {
    expect(parseDreamStartBody({ tier: "light" })).toEqual({ tier: "light", apply: false });
  });

  it("rejects an unknown tier", () => {
    const issues = captureIssues(() => parseDreamStartBody({ tier: "ultra" }));
    expect(paths(issues)).toContain("tier");
  });

  it("rejects a non-boolean apply flag", () => {
    const issues = captureIssues(() => parseDreamStartBody({ tier: "light", apply: "yes" }));
    expect(paths(issues)).toContain("apply");
  });
});

describe("parseProcedureValidateBody", () => {
  it("accepts YAML content with an optional relative path", () => {
    expect(parseProcedureValidateBody({ content: "key: value", relativePath: "team/deploy.yaml" })).toEqual({
      content: "key: value",
      relativePath: "team/deploy.yaml",
    });
  });

  it("defaults the relative path label when omitted", () => {
    expect(parseProcedureValidateBody({ content: "key: value" })).toEqual({
      content: "key: value",
      relativePath: "procedure.yaml",
    });
  });

  it("rejects unexpected fields", () => {
    const issues = captureIssues(() => parseProcedureValidateBody({ content: "x", surprise: true }));
    expect(issues).toContainEqual({ path: "surprise", message: "Unexpected field." });
  });
});

describe("parseProcedureSaveBody", () => {
  it("accepts a relative path and content", () => {
    expect(parseProcedureSaveBody({ relativePath: "team/deploy.yaml", content: "key: value" })).toEqual({
      relativePath: "team/deploy.yaml",
      content: "key: value",
    });
  });

  it("rejects a non-string content body", () => {
    const issues = captureIssues(() => parseProcedureSaveBody({ relativePath: "a.yaml", content: 42 }));
    expect(paths(issues)).toContain("content");
  });
});

describe("parseRegisterInstanceBody", () => {
  it("normalizes a name with optional paths", () => {
    expect(parseRegisterInstanceBody({ name: "  Prod  ", proceduresDir: " /repo/.agenr/procedures " })).toEqual({
      name: "Prod",
      proceduresDir: "/repo/.agenr/procedures",
    });
  });

  it("requires a name", () => {
    const issues = captureIssues(() => parseRegisterInstanceBody({ dbPath: "/tmp/x.db" }));
    expect(paths(issues)).toContain("name");
  });

  it("rejects unexpected fields", () => {
    const issues = captureIssues(() => parseRegisterInstanceBody({ name: "Prod", token: "secret" }));
    expect(issues).toContainEqual({ path: "token", message: "Unexpected field." });
  });
});

describe("parseDurableListQuery", () => {
  it("parses a fully specified query", () => {
    const params = new URLSearchParams();
    params.set("text", "timeout");
    params.set("state", "active");
    params.set("types", "fact,decision");
    params.set("limit", "25");
    params.set("offset", "50");

    expect(parseDurableListQuery(params)).toEqual({
      text: "timeout",
      types: ["fact", "decision"],
      state: "active",
      limit: 25,
      offset: 50,
    });
  });

  it("rejects an unsupported state filter", () => {
    const params = new URLSearchParams();
    params.set("state", "archived");
    const issues = captureIssues(() => parseDurableListQuery(params));
    expect(paths(issues)).toContain("state");
  });

  it("rejects a non-integer limit", () => {
    const params = new URLSearchParams();
    params.set("limit", "lots");
    const issues = captureIssues(() => parseDurableListQuery(params));
    expect(paths(issues)).toContain("limit");
  });

  it("rejects an unsupported durable kind in types", () => {
    const params = new URLSearchParams();
    params.set("types", "fact,rumor");
    const issues = captureIssues(() => parseDurableListQuery(params));
    expect(paths(issues)).toContain("types");
  });
});
