import { DREAM_TIERS, type DreamTier } from "../../../core/dreaming/types.js";
import { parseOptionalTrimmedString, readBoolean, readEnumValue, requireObject, throwIfIssues } from "./field-parsers.js";

/** Allowed body keys for a dreaming-start request. */
const DREAM_START_KEYS = new Set<string>(["tier", "apply", "project"]);

/**
 * Validated dreaming-run start request.
 */
export interface ParsedDreamStartBody {
  tier: DreamTier;
  apply: boolean;
  project?: string;
}

/**
 * Parses and validates a dreaming-run start request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated start parameters.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseDreamStartBody(input: unknown): ParsedDreamStartBody {
  const { record, issues } = requireObject(input, DREAM_START_KEYS);
  const tier = readEnumValue<DreamTier>(record.tier, "tier", DREAM_TIERS, issues) ?? "light";
  const apply = record.apply === undefined ? false : readBoolean(record.apply, "apply", issues);
  const project = parseOptionalTrimmedString(record.project, "project", issues);
  throwIfIssues(issues);
  return { tier, apply, ...(project ? { project } : {}) };
}
