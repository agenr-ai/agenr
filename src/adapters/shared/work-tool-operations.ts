import type { AgenrWorkParams, AgenrWorkUpdateOperation } from "../../app/working-memory/mutations.js";
import type { WorkingScope } from "../../app/working-memory/scope.js";
import { isModelVisibleOperationType } from "../../app/working-memory/operations/manifest.js";
import { asRecord } from "./entry-tools.js";
import type { MemoryToolParamReader } from "./memory-tools.js";
import { isModelVisibleWorkAction, MODEL_VISIBLE_WORK_ACTIONS } from "./work-tool-policy.js";
import { MODEL_VISIBLE_OPERATIONS, MODEL_VISIBLE_OPERATION_SCHEMAS } from "./work-tool-operation-registry.js";
import { optionalBooleanParam, optionalNumberParam, optionalStringParam } from "./work-tool-operation-parsers.js";
import { createOperationSchema } from "./work-tool-operation-schemas.js";

/**
 * Shared model-facing agenr_work parameter schema for host adapters.
 */
const WORK_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [...MODEL_VISIBLE_WORK_ACTIONS],
      description: "Working-memory action to run. Close is reserved for /goal clear and host lifecycle paths.",
    },
    target: {
      type: "string",
      enum: ["auto", "session", "goal"],
      description:
        "Working-set target. Use auto by default for get, list, and update. Create requires session or goal. Use session for session scratchpad or ordinary WIP, and goal when working with an explicit active goal.",
    },
    workingSetId: {
      type: "string",
      description: "Explicit working-set id when known.",
    },
    scope: {
      type: "object",
      description:
        "Working-memory scope facts. Session-scoped goals require conversationKey (or taskId / gitRoot+gitBranch / gitRoot+cwd). sessionKey and scopeKey are not accepted.",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: "string",
          description: "Host session id stored as provenance; does not select scope by itself.",
        },
        conversationKey: {
          type: "string",
          description: "Primary session/thread identity for goal binding (preferred for Skeln sessions).",
        },
        gitRoot: { type: "string" },
        gitBranch: { type: "string" },
        cwd: { type: "string" },
        project: { type: "string" },
        taskId: { type: "string" },
      },
    },
    operation: createOperationSchema(MODEL_VISIBLE_OPERATION_SCHEMAS),
    expectedRevision: {
      type: "integer",
      minimum: 0,
      description: "Required for update. Revision observed before update.",
    },
    updateReason: {
      type: "string",
      description: "Human-readable audit reason for create or update.",
    },
    includeEvents: {
      type: "boolean",
      description: "Include recent events in get output.",
    },
    eventLimit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Maximum events for get output.",
    },
    listLimit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum working sets for list output.",
    },
  },
  required: ["action"],
} as const;

/**
 * Parses raw host tool params into the app working-memory contract.
 *
 * @param rawParams - Raw tool parameters from the host adapter.
 * @param defaultScope - Host-derived scope facts merged under model overrides.
 * @param reader - Host param reader preserving adapter boundary semantics.
 * @returns Parsed working-memory params.
 */
export function parseWorkToolParams(rawParams: unknown, defaultScope: Partial<WorkingScope>, reader: MemoryToolParamReader): AgenrWorkParams {
  const params = asRecord(rawParams);
  const action = parseAction(reader.readString(params, "action", { required: true }));
  const target = parseTarget(reader.readString(params, "target"));
  if (action === "create" && target.target !== "session" && target.target !== "goal") {
    throw new Error('agenr_work create requires target "session" or "goal".');
  }

  return {
    action,
    ...target,
    ...optionalStringParam(params, "workingSetId", reader),
    scope: mergeWorkingScope(defaultScope, parseScope(params.scope, reader)),
    ...(params.operation !== undefined ? { operation: parseOperation(params.operation, reader) } : {}),
    ...optionalNumberParam(params, "expectedRevision", reader),
    ...optionalStringParam(params, "updateReason", reader),
    ...optionalBooleanParam(params, "includeEvents"),
    ...optionalNumberParam(params, "eventLimit", reader),
    ...optionalNumberParam(params, "listLimit", reader),
    actor: "model",
    source: "tool",
  };
}

/** Parses the optional target enum. */
function parseTarget(value: string | undefined): Pick<AgenrWorkParams, "target"> {
  if (value === undefined) {
    return {};
  }

  if (value === "auto" || value === "session" || value === "goal") {
    return { target: value };
  }

  throw new Error(`Unsupported agenr_work target "${value}".`);
}

/** Merges model-supplied scope over host scope. */
export function mergeWorkingScope(defaults: Partial<WorkingScope>, overrides: Partial<WorkingScope>): Partial<WorkingScope> {
  return {
    ...defaults,
    ...overrides,
  };
}

/** Parses the action enum. */
function parseAction(value: string | undefined): AgenrWorkParams["action"] {
  if (isModelVisibleWorkAction(value)) {
    return value;
  }

  throw new Error(`Unsupported agenr_work action "${value ?? ""}".`);
}

/**
 * Parses an optional nested scope object.
 *
 * Accepted keys match {@link WorkingScope}: taskId, conversationKey, gitRoot, gitBranch, cwd, and project.
 * Legacy keys such as sessionKey and scopeKey are rejected by additionalProperties: false.
 */
function parseScope(value: unknown, reader: MemoryToolParamReader): Partial<WorkingScope> {
  if (value === undefined || value === null) {
    return {};
  }

  const record = asRecord(value);
  return {
    ...optionalStringParam(record, "sessionId", reader),
    ...optionalStringParam(record, "gitRoot", reader),
    ...optionalStringParam(record, "gitBranch", reader),
    ...optionalStringParam(record, "cwd", reader),
    ...optionalStringParam(record, "project", reader),
    ...optionalStringParam(record, "taskId", reader),
    ...optionalStringParam(record, "conversationKey", reader),
  };
}

/** Parses one typed update operation. */
function parseOperation(value: unknown, reader: MemoryToolParamReader): AgenrWorkUpdateOperation {
  const record = asRecord(value);
  const type = reader.readString(record, "type", { required: true });
  if (type && isModelVisibleOperationType(type)) {
    return MODEL_VISIBLE_OPERATIONS[type].parse(record, reader);
  }

  throw new Error(`Unsupported agenr_work operation "${type ?? ""}".`);
}

export { WORK_TOOL_PARAMETERS };
