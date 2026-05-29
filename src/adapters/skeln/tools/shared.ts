import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import { readNumberParam, readStringArrayParam, readStringParam } from "../../shared/param-readers.js";
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
