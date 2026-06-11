import { describe, expect, it } from "vitest";

import { createHostWorkingSetPolicy } from "../../../src/app/working-memory/host-working-set-policy.js";
import { resolveListScopes } from "../../../src/app/working-memory/selection.js";

describe("resolveListScopes", () => {
  it("resolves explicit session and auto list scopes", () => {
    const scope = {
      conversationKey: "list-scope",
      sessionId: "list-scope",
      cwd: "/tmp/project",
    };

    expect(resolveListScopes(scope, "session", createHostWorkingSetPolicy(true))).toMatchObject({
      ok: true,
      scopes: [
        {
          scopeKind: "session",
          scopeKey: "session:list-scope:cwd:/tmp/project",
        },
      ],
    });

    expect(resolveListScopes(scope, undefined, createHostWorkingSetPolicy(true))).toMatchObject({
      ok: true,
      scopes: [
        {
          scopeKind: "session",
          scopeKey: "session:list-scope:cwd:/tmp/project",
        },
        {
          scopeKind: "conversation",
          scopeKey: "conversation:list-scope",
        },
      ],
    });
  });

  it("fails when no listable scope can be resolved", () => {
    expect(resolveListScopes({}, undefined, createHostWorkingSetPolicy(true))).toMatchObject({
      ok: false,
      code: "missing_scope",
    });
  });
});
