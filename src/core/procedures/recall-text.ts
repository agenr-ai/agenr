import type { ProcedureCondition, ProcedureDefinition, ProcedureSource, ProcedureStep } from "../types.js";

/**
 * Builds the deterministic flattened recall text for a normalized procedure.
 *
 * @param procedure - Canonical normalized procedure definition.
 * @returns Stable plain-text representation used for recall and embeddings.
 */
export function composeProcedureRecallText(procedure: ProcedureDefinition): string {
  const lines = [
    `procedure_key: ${procedure.procedure_key}`,
    `title: ${procedure.title}`,
    `goal: ${procedure.goal}`,
    ...formatSection("when_to_use", procedure.when_to_use),
    ...formatSection("when_not_to_use", procedure.when_not_to_use),
    ...formatSection("prerequisites", procedure.prerequisites),
    "steps:",
    ...procedure.steps.flatMap((step, index) => formatStep(step, index)),
    ...formatSection("verification", procedure.verification),
    ...formatSection("failure_modes", procedure.failure_modes),
    "sources:",
    ...procedure.sources.map((source, index) => `  ${index + 1}. ${formatSource(source)}`),
  ];

  return lines.join("\n");
}

/**
 * Formats one string-list section with deterministic numbering.
 *
 * @param label - Section label.
 * @param values - Ordered section values.
 * @returns Rendered section lines.
 */
function formatSection(label: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`${label}: none`];
  }

  return [`${label}:`, ...values.map((value, index) => `  ${index + 1}. ${value}`)];
}

/**
 * Formats one procedure step and its structured metadata.
 *
 * @param step - Procedure step to render.
 * @param index - One-based display order offset.
 * @returns Rendered step lines.
 */
function formatStep(step: ProcedureStep, index: number): string[] {
  const lines = [`  ${index + 1}. [${step.kind}] ${step.id} - ${step.instruction}`];

  switch (step.kind) {
    case "run_command":
      lines.push(`     command: ${step.command}`);
      break;
    case "read_reference":
      lines.push(`     ref: ${formatSource(step.ref)}`);
      break;
    case "inspect_state":
      if (step.target) {
        lines.push(`     target: ${step.target}`);
      }
      if (step.query) {
        lines.push(`     query: ${step.query}`);
      }
      break;
    case "edit_file":
      lines.push(`     path: ${step.path}`);
      lines.push(`     edit: ${step.edit}`);
      break;
    case "ask_user":
      lines.push(`     prompt: ${step.prompt}`);
      break;
    case "invoke_tool":
      lines.push(`     tool: ${step.tool}`);
      if (step.arguments) {
        lines.push(`     arguments: ${JSON.stringify(step.arguments)}`);
      }
      break;
    case "verify":
      lines.push(...step.checks.map((check, checkIndex) => `     check ${checkIndex + 1}: ${check}`));
      break;
  }

  if (step.conditions?.length) {
    lines.push(`     conditions: ${step.conditions.map((condition) => formatCondition(condition)).join("; ")}`);
  }
  if (step.stop_if?.length) {
    lines.push(`     stop_if: ${step.stop_if.map((condition) => formatCondition(condition)).join("; ")}`);
  }

  return lines;
}

/**
 * Formats one bounded declarative condition into a compact string.
 *
 * @param condition - Condition to render.
 * @returns Compact condition text.
 */
function formatCondition(condition: ProcedureCondition): string {
  switch (condition.kind) {
    case "file_exists":
    case "path_exists":
      return `${condition.kind}=${condition.path}`;
    case "env_flag":
      return condition.value ? `${condition.kind}=${condition.name}:${condition.value}` : `${condition.kind}=${condition.name}`;
    default:
      return `${condition.kind}=${condition.value}`;
  }
}

/**
 * Formats one provenance source into a compact stable label.
 *
 * @param source - Source to render.
 * @returns Compact source text.
 */
function formatSource(source: ProcedureSource): string {
  const parts: string[] = [source.kind];
  if (source.path) {
    parts.push(`path=${source.path}`);
  }
  if (source.locator) {
    parts.push(`locator=${source.locator}`);
  }
  if (source.label) {
    parts.push(`label=${source.label}`);
  }

  return parts.join(" ");
}
