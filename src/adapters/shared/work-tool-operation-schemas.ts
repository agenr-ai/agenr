import { WORKING_CANDIDATE_PROMOTION_STATUSES } from "../../app/working-memory/constants.js";

const NEXT_ACTION_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;
const ASSUMPTION_CONFIDENCE_VALUES = ["low", "medium", "high"] as const;

/** Builds one strict operation variant object. */
export function operationVariant(required: string[], properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  } as const;
}

/** Builds a const string schema. */
export function constString(value: string) {
  return { type: "string", const: value } as const;
}

/** Builds a string array schema. */
export function stringArray(description: string) {
  return {
    type: "array",
    description,
    items: { type: "string" },
  } as const;
}

/** Builds a next-action array schema. */
export function nextActionsSchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        status: { type: "string", enum: [...NEXT_ACTION_STATUSES] },
        ref: { type: "string" },
      },
      required: ["text"],
    },
  } as const;
}

/** Builds a checkpoint schema. */
export function checkpointSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string", description: "Compact summary of current progress." },
      recordedAt: { type: "string", description: "ISO timestamp when the checkpoint was recorded." },
      nextActions: stringArray("Expected next actions after the checkpoint."),
      blockers: stringArray("Known blockers at checkpoint time."),
    },
    required: ["summary", "recordedAt"],
  } as const;
}

/** Builds a file-note schema. */
export function fileNoteSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      note: { type: "string" },
      observedAt: { type: "string" },
    },
    required: ["path"],
  } as const;
}

/** Builds a command-note schema. */
export function commandNoteSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      outcome: { type: "string" },
      observedAt: { type: "string" },
    },
    required: ["command"],
  } as const;
}

/** Builds a decision-note schema. */
export function decisionNoteSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      decision: { type: "string" },
      rationale: { type: "string" },
      decidedAt: { type: "string" },
    },
    required: ["decision"],
  } as const;
}

/** Builds an assumption-note schema. */
export function assumptionNoteSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      assumption: { type: "string" },
      confidence: { type: "string", enum: [...ASSUMPTION_CONFIDENCE_VALUES] },
      validated: { type: "boolean" },
    },
    required: ["assumption"],
  } as const;
}

/** Builds candidate provenance schema. */
export function candidateProvenanceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      evidenceEventSequences: {
        type: "array",
        items: { type: "integer" },
      },
      sourceRef: { type: "string" },
      note: { type: "string" },
    },
    required: ["evidenceEventSequences"],
  } as const;
}

/** Builds candidate promotion-status schema. */
export function candidatePromotionSchema() {
  return { type: "string", enum: [...WORKING_CANDIDATE_PROMOTION_STATUSES] } as const;
}

/** Builds a candidate-memory schema. */
export function candidateSchema() {
  return {
    oneOf: [
      operationVariant(["kind", "summary", "provenance", "promotionStatus"], {
        kind: constString("episodic"),
        summary: { type: "string" },
        provenance: candidateProvenanceSchema(),
        promotionStatus: candidatePromotionSchema(),
      }),
      operationVariant(["kind", "subject", "content", "provenance", "promotionStatus"], {
        kind: constString("semantic"),
        subject: { type: "string" },
        content: { type: "string" },
        suggestedClaimKey: { type: "string" },
        provenance: candidateProvenanceSchema(),
        promotionStatus: candidatePromotionSchema(),
      }),
      operationVariant(["kind", "subject", "content", "provenance", "promotionStatus"], {
        kind: constString("procedural"),
        subject: { type: "string" },
        content: { type: "string" },
        suggestedClaimKey: { type: "string" },
        provenance: candidateProvenanceSchema(),
        promotionStatus: candidatePromotionSchema(),
      }),
    ],
  } as const;
}

/** One model-visible operation schema variant. */
export type ModelVisibleOperationSchema = ReturnType<typeof operationVariant>;

/** Builds the discriminated update-operation schema exposed to models. */
export function createOperationSchema(schemas: readonly ModelVisibleOperationSchema[]) {
  return {
    description: "Typed working-memory operation for create and update. Always include operation.type and the required payload field for that variant.",
    oneOf: schemas,
  } as const;
}
