import { describe, expect, test } from "bun:test";

import { matchesDomain } from "../../../src/adapters/domain-allowlist";

describe("matchesDomain", () => {
  test("exact domain match passes", () => {
    expect(matchesDomain("api.stripe.com", ["api.stripe.com"])).toBe(true);
  });

  test("wildcard subdomain match passes", () => {
    expect(matchesDomain("connect.stripe.com", ["*.stripe.com"])).toBe(true);
  });

  test("wildcard does not match bare domain", () => {
    expect(matchesDomain("stripe.com", ["*.stripe.com"])).toBe(false);
  });

  test("non-matching domain rejected", () => {
    expect(matchesDomain("api.paypal.com", ["api.stripe.com", "*.squareup.com"])).toBe(false);
  });

  test("case-insensitive matching", () => {
    expect(matchesDomain("API.STRIPE.COM", ["api.stripe.com"])).toBe(true);
    expect(matchesDomain("Connect.Stripe.Com", ["*.STRIPE.COM"])).toBe(true);
  });

  test("empty allowlist rejects everything", () => {
    expect(matchesDomain("api.stripe.com", [])).toBe(false);
  });

  test("multiple domains in allowlist match when any match passes", () => {
    expect(matchesDomain("api.squareup.com", ["api.stripe.com", "*.squareup.com"])).toBe(true);
  });
});
