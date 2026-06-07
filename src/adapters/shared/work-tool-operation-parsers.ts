import { WORKING_CANDIDATE_PROMOTION_STATUSES } from "../../app/working-memory/constants.js";
import type {
  WorkingAssumptionNote,
  WorkingCandidate,
  WorkingCheckpoint,
  WorkingCommandNote,
  WorkingDecisionNote,
  WorkingFileNote,
  WorkingNextAction,
} from "../../app/working-memory/snapshot.js";
import { asRecord } from "./durable-tools.js";
import type { MemoryToolParamReader } from "./memory-tools.js";

/** Reads an optional string parameter. */
export function optionalStringParam<K extends string>(record: Record<string, unknown>, key: K, reader: MemoryToolParamReader): Partial<Record<K, string>> {
  const value = reader.readString(record, key);
  return value ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}

/** Reads a required string parameter. */
export function requiredString(record: Record<string, unknown>, key: string, reader: MemoryToolParamReader): string {
  return reader.readString(record, key, { required: true }) ?? "";
}

/** Reads a required string-array parameter. */
export function requiredStringArray(record: Record<string, unknown>, key: string, reader: MemoryToolParamReader): string[] {
  const value = reader.readStringArray(record, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

/** Reads a required number-array parameter. */
export function requiredNumberArray(record: Record<string, unknown>, key: string): number[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isInteger(item))) {
    throw new Error(`${key} must be an array of integers.`);
  }

  return value;
}

/** Reads a required boolean parameter. */
export function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }

  return value;
}

/** Parses an array with a per-item parser. */
export function parseArray<T>(value: unknown, parse: (item: unknown, reader: MemoryToolParamReader) => T, key: string, reader: MemoryToolParamReader): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }

  return value.map((item) => parse(item, reader));
}

/** Reads an optional number parameter. */
export function optionalNumberParam<K extends string>(record: Record<string, unknown>, key: K, reader: MemoryToolParamReader): Partial<Record<K, number>> {
  const value = reader.readNumber(record, key, { integer: true, strict: true });
  return value !== undefined ? ({ [key]: value } as Partial<Record<K, number>>) : {};
}

/** Reads an optional boolean parameter. */
export function optionalBooleanParam<K extends string>(record: Record<string, unknown>, key: K): Partial<Record<K, boolean>> {
  const value = record[key];
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }

  return { [key]: value } as Partial<Record<K, boolean>>;
}

/** Parses a next-action status enum. */
function parseNextActionStatus(value: string): WorkingNextAction["status"] {
  if (value === "pending" || value === "in_progress" || value === "blocked" || value === "done") {
    return value;
  }

  throw new Error(`Unsupported next-action status "${value}".`);
}

/** Parses an assumption confidence enum. */
function parseConfidence(value: string): WorkingAssumptionNote["confidence"] {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  throw new Error(`Unsupported assumption confidence "${value}".`);
}

/** Parses a candidate promotion status enum. */
function parsePromotionStatus(value: string): WorkingCandidate["promotionStatus"] {
  if (WORKING_CANDIDATE_PROMOTION_STATUSES.includes(value as WorkingCandidate["promotionStatus"])) {
    return value as WorkingCandidate["promotionStatus"];
  }

  throw new Error(`Unsupported candidate promotion status "${value}".`);
}

/** Parses a next-action record. */
export function parseNextAction(value: unknown, reader: MemoryToolParamReader): WorkingNextAction {
  const record = asRecord(value);
  const status = reader.readString(record, "status");
  return {
    text: requiredString(record, "text", reader),
    ...(status ? { status: parseNextActionStatus(status) } : {}),
    ...optionalStringParam(record, "ref", reader),
  };
}

/** Parses a checkpoint record. */
export function parseCheckpoint(value: unknown, reader: MemoryToolParamReader): WorkingCheckpoint {
  const record = asRecord(value);
  return {
    summary: requiredString(record, "summary", reader),
    recordedAt: requiredString(record, "recordedAt", reader),
    ...(record.nextActions !== undefined ? { nextActions: requiredStringArray(record, "nextActions", reader) } : {}),
    ...(record.blockers !== undefined ? { blockers: requiredStringArray(record, "blockers", reader) } : {}),
  };
}

/** Parses a file-note record. */
export function parseFileNote(value: unknown, reader: MemoryToolParamReader): WorkingFileNote {
  const record = asRecord(value);
  return {
    path: requiredString(record, "path", reader),
    ...optionalStringParam(record, "note", reader),
    ...optionalStringParam(record, "observedAt", reader),
  };
}

/** Parses a command-note record. */
export function parseCommandNote(value: unknown, reader: MemoryToolParamReader): WorkingCommandNote {
  const record = asRecord(value);
  return {
    command: requiredString(record, "command", reader),
    ...optionalStringParam(record, "outcome", reader),
    ...optionalStringParam(record, "observedAt", reader),
  };
}

/** Parses a decision-note record. */
export function parseDecisionNote(value: unknown, reader: MemoryToolParamReader): WorkingDecisionNote {
  const record = asRecord(value);
  return {
    decision: requiredString(record, "decision", reader),
    ...optionalStringParam(record, "rationale", reader),
    ...optionalStringParam(record, "decidedAt", reader),
  };
}

/** Parses an assumption-note record. */
export function parseAssumptionNote(value: unknown, reader: MemoryToolParamReader): WorkingAssumptionNote {
  const record = asRecord(value);
  const confidence = reader.readString(record, "confidence");
  return {
    assumption: requiredString(record, "assumption", reader),
    ...(confidence ? { confidence: parseConfidence(confidence) } : {}),
    ...(record.validated !== undefined ? { validated: requiredBoolean(record, "validated") } : {}),
  };
}

/** Parses candidate provenance. */
function parseCandidateProvenance(value: unknown, reader: MemoryToolParamReader): WorkingCandidate["provenance"] {
  const record = asRecord(value);
  return {
    evidenceEventSequences: requiredNumberArray(record, "evidenceEventSequences"),
    ...optionalStringParam(record, "sourceRef", reader),
    ...optionalStringParam(record, "note", reader),
  };
}

/** Parses a candidate record. */
export function parseCandidate(value: unknown, reader: MemoryToolParamReader): WorkingCandidate {
  const record = asRecord(value);
  const kind = requiredString(record, "kind", reader);
  const provenance = parseCandidateProvenance(record.provenance, reader);
  const promotionStatus = parsePromotionStatus(requiredString(record, "promotionStatus", reader));
  if (kind === "episodic") {
    return {
      kind,
      summary: requiredString(record, "summary", reader),
      provenance,
      promotionStatus,
    };
  }

  if (kind === "semantic" || kind === "procedural") {
    return {
      kind,
      subject: requiredString(record, "subject", reader),
      content: requiredString(record, "content", reader),
      ...optionalStringParam(record, "suggestedClaimKey", reader),
      provenance,
      promotionStatus,
    };
  }

  throw new Error(`Unsupported working candidate kind "${kind}".`);
}
