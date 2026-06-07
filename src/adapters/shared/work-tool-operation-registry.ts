import type { AgenrWorkUpdateOperation } from "../../app/working-memory/mutations.js";
import type { ModelVisibleOperationType } from "../../app/working-memory/operations/manifest.js";
import type { MemoryToolParamReader } from "./memory-tools.js";
import {
  optionalStringParam,
  parseArray,
  parseAssumptionNote,
  parseCandidate,
  parseCheckpoint,
  parseCommandNote,
  parseDecisionNote,
  parseFileNote,
  parseNextAction,
  requiredString,
  requiredStringArray,
} from "./work-tool-operation-parsers.js";
import {
  assumptionNoteSchema,
  candidateSchema,
  checkpointSchema,
  commandNoteSchema,
  constString,
  decisionNoteSchema,
  fileNoteSchema,
  nextActionsSchema,
  operationVariant,
  stringArray,
  type ModelVisibleOperationSchema,
} from "./work-tool-operation-schemas.js";

/** Shared schema and parser for one model-visible operation type. */
interface ModelVisibleOperationDefinition {
  /** Builds the JSON schema variant for this operation. */
  buildSchema: () => ModelVisibleOperationSchema;
  /** Parses one raw operation record into the app contract. */
  parse: (record: Record<string, unknown>, reader: MemoryToolParamReader) => Extract<AgenrWorkUpdateOperation, { type: ModelVisibleOperationType }>;
}

/** Canonical registry for model-visible operation schema and parsing. */
const MODEL_VISIBLE_OPERATIONS: Record<ModelVisibleOperationType, ModelVisibleOperationDefinition> = {
  set_objective: {
    buildSchema: () =>
      operationVariant(["type", "objective"], {
        type: constString("set_objective"),
        objective: { type: "string", description: "Current concrete objective." },
        title: { type: "string", description: "Optional display title." },
      }),
    parse: (record, reader) => ({
      type: "set_objective",
      objective: requiredString(record, "objective", reader),
      ...optionalStringParam(record, "title", reader),
    }),
  },
  replace_plan: {
    buildSchema: () =>
      operationVariant(["type", "currentPlan"], {
        type: constString("replace_plan"),
        currentPlan: stringArray("Ordered current plan steps."),
        nextActions: nextActionsSchema(),
      }),
    parse: (record, reader) => ({
      type: "replace_plan",
      currentPlan: requiredStringArray(record, "currentPlan", reader),
      ...(record.nextActions !== undefined ? { nextActions: parseArray(record.nextActions, parseNextAction, "nextActions", reader) } : {}),
    }),
  },
  merge_checkpoint: {
    buildSchema: () =>
      operationVariant(["type", "checkpoint"], {
        type: constString("merge_checkpoint"),
        checkpoint: checkpointSchema(),
      }),
    parse: (record, reader) => ({
      type: "merge_checkpoint",
      checkpoint: parseCheckpoint(record.checkpoint, reader),
    }),
  },
  set_scratchpad: {
    buildSchema: () =>
      operationVariant(["type", "scratchpad"], {
        type: constString("set_scratchpad"),
        scratchpad: { type: "string", description: "Freeform transient notes for the selected working set." },
      }),
    parse: (record, reader) => ({
      type: "set_scratchpad",
      scratchpad: requiredString(record, "scratchpad", reader),
    }),
  },
  add_file_note: {
    buildSchema: () =>
      operationVariant(["type", "file"], {
        type: constString("add_file_note"),
        file: fileNoteSchema(),
      }),
    parse: (record, reader) => ({
      type: "add_file_note",
      file: parseFileNote(record.file, reader),
    }),
  },
  add_command_note: {
    buildSchema: () =>
      operationVariant(["type", "command"], {
        type: constString("add_command_note"),
        command: commandNoteSchema(),
      }),
    parse: (record, reader) => ({
      type: "add_command_note",
      command: parseCommandNote(record.command, reader),
    }),
  },
  record_decision: {
    buildSchema: () =>
      operationVariant(["type", "decision"], {
        type: constString("record_decision"),
        decision: decisionNoteSchema(),
      }),
    parse: (record, reader) => ({
      type: "record_decision",
      decision: parseDecisionNote(record.decision, reader),
    }),
  },
  record_assumption: {
    buildSchema: () =>
      operationVariant(["type", "assumption"], {
        type: constString("record_assumption"),
        assumption: assumptionNoteSchema(),
      }),
    parse: (record, reader) => ({
      type: "record_assumption",
      assumption: parseAssumptionNote(record.assumption, reader),
    }),
  },
  set_next_actions: {
    buildSchema: () =>
      operationVariant(["type", "nextActions"], {
        type: constString("set_next_actions"),
        nextActions: nextActionsSchema(),
      }),
    parse: (record, reader) => ({
      type: "set_next_actions",
      nextActions: parseArray(record.nextActions, parseNextAction, "nextActions", reader),
    }),
  },
  add_candidate: {
    buildSchema: () =>
      operationVariant(["type", "candidate"], {
        type: constString("add_candidate"),
        candidate: candidateSchema(),
      }),
    parse: (record, reader) => ({
      type: "add_candidate",
      candidate: parseCandidate(record.candidate, reader),
    }),
  },
};

/**
 * JSON schema variants for all model-visible operations.
 */
const MODEL_VISIBLE_OPERATION_SCHEMAS = (Object.keys(MODEL_VISIBLE_OPERATIONS) as ModelVisibleOperationType[]).map((operationType) =>
  MODEL_VISIBLE_OPERATIONS[operationType].buildSchema(),
);

export { MODEL_VISIBLE_OPERATIONS, MODEL_VISIBLE_OPERATION_SCHEMAS };
