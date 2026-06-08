import { describe, expect, it } from "vitest";

import { evaluateOriginGuard } from "../../../src/adapters/web/same-origin.js";

describe("evaluateOriginGuard", () => {
  it("allows requests with no Host and no Origin (non-browser callers)", () => {
    expect(evaluateOriginGuard({}, 4319)).toEqual({ allowed: true });
  });

  it("allows a loopback Host header with no Origin", () => {
    expect(evaluateOriginGuard({ host: "127.0.0.1:4319" }, 4319)).toEqual({ allowed: true });
    expect(evaluateOriginGuard({ host: "localhost:4319" }, 4319)).toEqual({ allowed: true });
  });

  it("allows a same-origin loopback request on the matching bound port", () => {
    expect(evaluateOriginGuard({ host: "127.0.0.1:4319", origin: "http://127.0.0.1:4319" }, 4319)).toEqual({ allowed: true });
    expect(evaluateOriginGuard({ host: "localhost:4319", origin: "http://localhost:4319" }, 4319)).toEqual({ allowed: true });
  });

  it("rejects a non-loopback Host header to block DNS rebinding", () => {
    const result = evaluateOriginGuard({ host: "evil.example.com", origin: "http://127.0.0.1:4319" }, 4319);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("non-loopback Host");
  });

  it("rejects a cross-origin browser request", () => {
    const result = evaluateOriginGuard({ host: "127.0.0.1:4319", origin: "http://evil.example.com" }, 4319);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("cross-origin");
  });

  it("rejects a loopback origin bound to a different port", () => {
    const result = evaluateOriginGuard({ host: "127.0.0.1:4319", origin: "http://127.0.0.1:9999" }, 4319);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("non-matching origin port");
  });

  it("rejects a malformed Origin header", () => {
    const result = evaluateOriginGuard({ host: "127.0.0.1:4319", origin: "not a url" }, 4319);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("malformed Origin");
  });

  it("treats a default http port origin as port 80", () => {
    expect(evaluateOriginGuard({ host: "localhost", origin: "http://localhost" }, 80)).toEqual({ allowed: true });
    expect(evaluateOriginGuard({ host: "localhost:4319", origin: "http://localhost" }, 4319).allowed).toBe(false);
  });
});
