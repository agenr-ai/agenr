import { describe, expect, test } from "bun:test";

import { sanitizeProviderResponse } from "../../src/utils/sanitize";

describe("sanitizeProviderResponse", () => {
  test("passes through empty string", () => {
    expect(sanitizeProviderResponse("")).toBe("");
  });

  test("passes through short non-sensitive string unchanged", () => {
    const body = "bad request: invalid code";
    expect(sanitizeProviderResponse(body)).toBe(body);
  });

  test("truncates long string with marker", () => {
    const longBody = "a".repeat(210);
    expect(sanitizeProviderResponse(longBody)).toBe(`${"a".repeat(200)}...[truncated]`);
  });

  test("redacts access_token value", () => {
    const body = '{"access_token":"abcd1234efgh"}';
    expect(sanitizeProviderResponse(body)).toContain('"access_token":"abcd***REDACTED***');
  });

  test("redacts refresh_token value", () => {
    const body = '{"refresh_token":"wxyz9876lmno"}';
    expect(sanitizeProviderResponse(body)).toContain('"refresh_token":"wxyz***REDACTED***');
  });

  test("redacts multiple sensitive fields", () => {
    const body =
      '{"access_token":"abcd1234efgh","refresh_token":"wxyz9876lmno","client_secret":"s3cr3tvalue"}';
    const sanitized = sanitizeProviderResponse(body);
    expect(sanitized).toContain('"access_token":"abcd***REDACTED***');
    expect(sanitized).toContain('"refresh_token":"wxyz***REDACTED***');
    expect(sanitized).toContain('"client_secret":"s3cr***REDACTED***');
  });

  test("handles JSON and form-encoded formats", () => {
    const json = '{"token":"tokn123456"}';
    const form = "access_token=abcd1234efgh&refresh_token=wxyz9876lmno";
    expect(sanitizeProviderResponse(json)).toContain('"token":"tokn***REDACTED***');
    expect(sanitizeProviderResponse(form)).toContain("access_token=abcd***REDACTED***");
    expect(sanitizeProviderResponse(form)).toContain("refresh_token=wxyz***REDACTED***");
  });
});
