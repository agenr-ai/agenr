import { describe, expect, it } from "vitest";

import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../src/core/procedures/hashing.js";
import { parseAndNormalizeProcedureYaml } from "../../../src/core/procedures/normalization.js";
import { composeProcedureRecallText } from "../../../src/core/procedures/recall-text.js";

const BASE_PROCEDURE_YAML = `
procedure_key: " Agenr/Release "
title: " Release agenr and publish packages "
goal: " Cut a release and publish packages safely. "
when_to_use:
  - " Ship a new agenr release. "
steps:
  - id: read-release-skill
    kind: read_reference
    instruction: "Read the local release workflow."
    ref:
      kind: skill
      path: /Users/jmartin/.codex/skills/agenr-release/SKILL.md
  - id: run-checks
    kind: run_command
    instruction: "Run the required repo validation command."
    command: "pnpm check"
    conditions:
      - kind: harness_is
        value: codex
  - id: publish
    kind: invoke_tool
    instruction: "Publish packages."
    tool: publish.packages
    arguments:
      registry: npm
      access: public
verification:
  - "Published package versions match the intended release."
failure_modes:
  - "Validation fails before publish."
sources:
  - kind: skill
    path: /Users/jmartin/.codex/skills/agenr-release/SKILL.md
`;

describe("parseAndNormalizeProcedureYaml", () => {
  it("normalizes a valid authored procedure into the canonical runtime shape", () => {
    const procedure = parseAndNormalizeProcedureYaml(BASE_PROCEDURE_YAML, "procedures/agenr-release.yaml");

    expect(procedure).toEqual({
      procedure_key: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Cut a release and publish packages safely.",
      when_to_use: ["Ship a new agenr release."],
      when_not_to_use: [],
      prerequisites: [],
      steps: [
        {
          id: "read-release-skill",
          kind: "read_reference",
          instruction: "Read the local release workflow.",
          ref: {
            kind: "skill",
            path: "/Users/jmartin/.codex/skills/agenr-release/SKILL.md",
          },
        },
        {
          id: "run-checks",
          kind: "run_command",
          instruction: "Run the required repo validation command.",
          command: "pnpm check",
          conditions: [
            {
              kind: "harness_is",
              value: "codex",
            },
          ],
        },
        {
          id: "publish",
          kind: "invoke_tool",
          instruction: "Publish packages.",
          tool: "publish.packages",
          arguments: {
            access: "public",
            registry: "npm",
          },
        },
      ],
      verification: ["Published package versions match the intended release."],
      failure_modes: ["Validation fails before publish."],
      sources: [
        {
          kind: "skill",
          path: "/Users/jmartin/.codex/skills/agenr-release/SKILL.md",
        },
      ],
    });
  });

  it("rejects unknown authoring fields", () => {
    const yaml = `${BASE_PROCEDURE_YAML}\nnotes: unsupported\n`;

    expect(() => parseAndNormalizeProcedureYaml(yaml, "procedures/agenr-release.yaml")).toThrow(/unsupported field "notes"/i);
  });

  it("rejects duplicate yaml keys", () => {
    const yaml = `
procedure_key: agenr/release
title: Release agenr
goal: first goal
goal: second goal
steps:
  - id: run-checks
    kind: run_command
    instruction: Run checks.
    command: pnpm check
verification:
  - Checks pass.
failure_modes:
  - Checks fail.
sources:
  - kind: manual
    label: release note
`;

    expect(() => parseAndNormalizeProcedureYaml(yaml, "procedures/agenr-release.yaml")).toThrow(/map keys must be unique|duplicated mapping key/i);
  });

  it("rejects unsupported step kinds and duplicate step ids", () => {
    const unsupportedKindYaml = `
procedure_key: agenr/release
title: Release agenr
goal: Cut a release.
steps:
  - id: run-checks
    kind: use_procedure
    instruction: Reuse another procedure.
verification:
  - Checks pass.
failure_modes:
  - Checks fail.
sources:
  - kind: manual
    label: release note
`;

    const duplicateStepIdYaml = `
procedure_key: agenr/release
title: Release agenr
goal: Cut a release.
steps:
  - id: run-checks
    kind: run_command
    instruction: Run checks.
    command: pnpm check
  - id: run-checks
    kind: verify
    instruction: Verify the release.
    checks:
      - Published version matches.
verification:
  - Checks pass.
failure_modes:
  - Checks fail.
sources:
  - kind: manual
    label: release note
`;

    expect(() => parseAndNormalizeProcedureYaml(unsupportedKindYaml, "procedures/agenr-release.yaml")).toThrow(/unsupported step kind/i);
    expect(() => parseAndNormalizeProcedureYaml(duplicateStepIdYaml, "procedures/agenr-release.yaml")).toThrow(/duplicate id/i);
  });
});

describe("procedure hashing and recall text", () => {
  it("keeps revision hashes stable across formatting-only yaml changes while source hashes differ", () => {
    const reformattedYaml = `
procedure_key: agenr/release
title: Release agenr and publish packages
goal: Cut a release and publish packages safely.
when_to_use:
  - Ship a new agenr release.
steps:
  - id: read-release-skill
    kind: read_reference
    instruction: Read the local release workflow.
    ref: { kind: skill, path: /Users/jmartin/.codex/skills/agenr-release/SKILL.md }
  - id: run-checks
    kind: run_command
    instruction: Run the required repo validation command.
    command: pnpm check
    conditions:
      - { kind: harness_is, value: codex }
  - id: publish
    kind: invoke_tool
    instruction: Publish packages.
    tool: publish.packages
    arguments:
      access: public
      registry: npm
verification: [Published package versions match the intended release.]
failure_modes: [Validation fails before publish.]
sources:
  - { kind: skill, path: /Users/jmartin/.codex/skills/agenr-release/SKILL.md }
`;

    const first = parseAndNormalizeProcedureYaml(BASE_PROCEDURE_YAML, "procedures/agenr-release.yaml");
    const second = parseAndNormalizeProcedureYaml(reformattedYaml, "procedures/agenr-release.yaml");

    expect(computeProcedureRevisionHash(first)).toBe(computeProcedureRevisionHash(second));
    expect(computeProcedureSourceHash(BASE_PROCEDURE_YAML)).not.toBe(computeProcedureSourceHash(reformattedYaml));
  });

  it("builds deterministic recall text from the normalized procedure", () => {
    const procedure = parseAndNormalizeProcedureYaml(BASE_PROCEDURE_YAML, "procedures/agenr-release.yaml");

    expect(composeProcedureRecallText(procedure)).toBe(
      [
        "procedure_key: agenr/release",
        "title: Release agenr and publish packages",
        "goal: Cut a release and publish packages safely.",
        "when_to_use:",
        "  1. Ship a new agenr release.",
        "when_not_to_use: none",
        "prerequisites: none",
        "steps:",
        "  1. [read_reference] read-release-skill - Read the local release workflow.",
        "     ref: skill path=/Users/jmartin/.codex/skills/agenr-release/SKILL.md",
        "  2. [run_command] run-checks - Run the required repo validation command.",
        "     command: pnpm check",
        "     conditions: harness_is=codex",
        "  3. [invoke_tool] publish - Publish packages.",
        "     tool: publish.packages",
        '     arguments: {"access":"public","registry":"npm"}',
        "verification:",
        "  1. Published package versions match the intended release.",
        "failure_modes:",
        "  1. Validation fails before publish.",
        "sources:",
        "  1. skill path=/Users/jmartin/.codex/skills/agenr-release/SKILL.md",
      ].join("\n"),
    );
  });
});
