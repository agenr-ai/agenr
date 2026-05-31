import { describe, expect, it } from "vitest";

import { MODEL_VISIBLE_OPERATIONS } from "../../../src/adapters/shared/work-tool-operation-registry.js";
import type { AgenrWorkUpdateOperation } from "../../../src/app/working-memory/mutations.js";
import {
  HOST_ONLY_OPERATION_TYPES,
  MODEL_VISIBLE_OPERATION_TYPES,
  WORKING_UPDATE_OPERATION_TYPES,
} from "../../../src/app/working-memory/operations/manifest.js";

describe("working-memory operation manifest", () => {
  it("keeps model-visible registry keys aligned with the canonical manifest", () => {
    expect(Object.keys(MODEL_VISIBLE_OPERATIONS).sort()).toEqual([...MODEL_VISIBLE_OPERATION_TYPES].sort());
  });

  it("lists every update operation exactly once across visibility tiers", () => {
    const manifestTypes = [...MODEL_VISIBLE_OPERATION_TYPES, ...HOST_ONLY_OPERATION_TYPES];
    expect(manifestTypes.sort()).toEqual([...WORKING_UPDATE_OPERATION_TYPES].sort());
    expect(new Set(manifestTypes).size).toBe(manifestTypes.length);
  });

  it("covers every mutation union member in the working update manifest", () => {
    const manifestCoverage = new Set<string>(WORKING_UPDATE_OPERATION_TYPES);
    const unionProbe = (type: AgenrWorkUpdateOperation["type"]) => type;

    for (const type of WORKING_UPDATE_OPERATION_TYPES) {
      expect(manifestCoverage.has(unionProbe(type))).toBe(true);
    }

    const unionTypes: AgenrWorkUpdateOperation["type"][] = [
      "set_objective",
      "replace_plan",
      "merge_checkpoint",
      "add_file_note",
      "add_command_note",
      "record_decision",
      "record_assumption",
      "set_next_actions",
      "set_status",
      "add_candidate",
      "configure_budget",
      "account_usage",
      "set_continuation_policy",
    ];

    expect(unionTypes.sort()).toEqual([...WORKING_UPDATE_OPERATION_TYPES].sort());
  });
});
