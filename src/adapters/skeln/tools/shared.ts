import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import type { MemoryToolOutcome, MemoryToolParamReader } from "../../shared/memory-tools.js";
import { formatErrorMessage } from "../../shared/entry-tools.js";

/** Text-only Skeln tool result details shape. */
export type SkelnToolDetails = Record<string, unknown>;

/** Shared Skeln param reader wired into host-neutral memory tool parsers. */
export const SKELN_PARAM_READER: MemoryToolParamReader = {
  readString: readStringParam,
  readNumber: readNumberParam,
  readStringArray: readStringArrayParam,
};

/** Casts host-neutral JSON schema literals into Skeln's TypeBox schema contract. */
export function toolSchema(value: object): TSchema {
  return value as TSchema;
}

/** Builds a text result for Skeln extension tools. */
export function textToolResult(text: string, details: SkelnToolDetails): AgentToolResult<SkelnToolDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/** Maps a host-neutral memory tool outcome into a Skeln tool result. */
export function toSkelnToolResult(outcome: MemoryToolOutcome): AgentToolResult<SkelnToolDetails> {
  return textToolResult(outcome.text, outcome.details);
}

/** Wraps unexpected tool failures in the standard Skeln failed-result payload. */
export function toolFailureResult(error: unknown): AgentToolResult<SkelnToolDetails> {
  return textToolResult(formatErrorMessage(error), {
    status: "failed",
  });
}

/** Parses a required or optional string parameter from model-supplied args. */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string; trim?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`${options.label ?? key} is required.`);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${options.label ?? key} must be a string.`);
  }

  const normalized = options.trim === false ? value : value.trim();
  if (options.required && normalized.length === 0) {
    throw new Error(`${options.label ?? key} is required.`);
  }

  return normalized.length > 0 || options.trim === false ? normalized : undefined;
}

/** Parses an optional number parameter from model-supplied args. */
export function readNumberParam(params: Record<string, unknown>, key: string, options: { integer?: boolean; strict?: boolean } = {}): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number.`);
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }

  if (options.strict && value < 0) {
    throw new Error(`${key} must be non-negative.`);
  }

  return value;
}

/** Parses an optional string-array parameter from model-supplied args. */
export function readStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }

  return value;
}
