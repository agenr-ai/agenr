import { describe, expect, it } from "vitest";

import { CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE, validateExplicitCreateTarget } from "../../../src/app/working-memory/validate-explicit-create-target.js";

describe("validateExplicitCreateTarget", () => {
  it("requires explicit session or goal targets for create", () => {
    expect(validateExplicitCreateTarget("goal")).toMatchObject({ ok: true, target: "goal" });
    expect(validateExplicitCreateTarget("session")).toMatchObject({ ok: true, target: "session" });
    expect(validateExplicitCreateTarget(undefined)).toMatchObject({
      ok: false,
      message: CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE,
    });
    expect(validateExplicitCreateTarget("auto")).toMatchObject({
      ok: false,
      message: CREATE_REQUIRES_EXPLICIT_TARGET_MESSAGE,
    });
  });
});
