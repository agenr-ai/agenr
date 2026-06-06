import { describe, expect, it } from "vitest";

import { resolveDurableProjectScope } from "../../../src/core/store/project-scope.js";

describe("resolveDurableProjectScope", () => {
  it("uses explicit per-entry project values", () => {
    expect(
      resolveDurableProjectScope(
        {
          subject: "Jim birthday",
          content: "Jim Martin's birthday is March 15.",
          tags: [],
          project: "agenr",
        },
        { sessionWorkspace: "skeln" },
      ),
    ).toBe("agenr");
  });

  it("does not stamp session workspace onto personal facts", () => {
    expect(
      resolveDurableProjectScope(
        {
          subject: "Jim birthday",
          content: "Jim Martin is 49 years old and his birthday is March 15.",
          tags: ["family", "personal"],
          source_context: "User shared family details during casual conversation.",
          claim_key: "jim/birthday",
        },
        { sessionWorkspace: "skeln" },
      ),
    ).toBeUndefined();
  });

  it("tags workspace knowledge when claim-key entity matches the session workspace", () => {
    expect(
      resolveDurableProjectScope(
        {
          subject: "release policy",
          content: "Agenr releases require pnpm check before publishing packages.",
          tags: ["workflow"],
          claim_key: "agenr/release_policy",
        },
        { sessionWorkspace: "agenr" },
      ),
    ).toBe("agenr");
  });

  it("tags workspace knowledge when subject visibly references the session workspace", () => {
    expect(
      resolveDurableProjectScope(
        {
          subject: "skeln plugin boundaries",
          content: "Skeln keeps host wiring in adapters and shared logic in core.",
          tags: ["architecture"],
          source_context: "Reviewed skeln adapter boundaries during debugging.",
        },
        { sessionWorkspace: "skeln" },
      ),
    ).toBe("skeln");
  });

  it("uses working-directory basename only when the entry visibly references it", () => {
    expect(
      resolveDurableProjectScope(
        {
          subject: "agenr package manager",
          content: "Agenr uses pnpm for dependency management and workspace scripts.",
          tags: ["agenr", "workflow"],
        },
        { workingDirectory: "/Users/jmartin/Code/agenr" },
      ),
    ).toBe("agenr");

    expect(
      resolveDurableProjectScope(
        {
          subject: "Jim birthday",
          content: "Jim Martin's birthday is March 15.",
          tags: ["family"],
        },
        { workingDirectory: "/Users/jmartin/Code/agenr" },
      ),
    ).toBeUndefined();
  });
});
