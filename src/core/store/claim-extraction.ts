import type { DatabasePort, LlmPort } from "../ports.js";
import type { EntryType } from "../types.js";

const SELF_REFERENTIAL_ENTITIES = new Set(["i", "me", "the_user", "myself", "user", "we", "our_team", "the_project", "this_project"]);

/** Raw JSON payload expected back from the claim-extraction classifier. */
interface ClaimExtractionResponse {
  entity?: unknown;
  attribute?: unknown;
  confidence?: unknown;
  no_claim?: unknown;
}

/**
 * Runtime configuration for optional claim-key extraction.
 */
export interface ClaimExtractionConfig {
  enabled: boolean;
  confidenceThreshold: number;
  eligibleTypes: EntryType[];
}

/**
 * Best-effort claim-key extraction outcome.
 */
export interface ClaimExtractionResult {
  claimKey: string | null;
  confidence: number;
  rawEntity: string;
  rawAttribute: string;
}

/**
 * Extracts one normalized claim key for a durable entry when the slot is clear.
 *
 * @param entry - Candidate entry content to classify.
 * @param entityHints - Existing entity prefixes used to keep the namespace stable.
 * @param llm - LLM port used for JSON classification.
 * @param config - Runtime extraction controls.
 * @returns Extracted claim metadata, or `null` when no safe claim key was found.
 */
export async function extractClaimKey(
  entry: { type: EntryType; subject: string; content: string },
  entityHints: string[],
  llm: LlmPort,
  config: ClaimExtractionConfig,
): Promise<ClaimExtractionResult | null> {
  if (!config.enabled || !config.eligibleTypes.includes(entry.type)) {
    return null;
  }

  const response = await llm.completeJson<ClaimExtractionResponse>(buildClaimExtractionSystemPrompt(entityHints), buildClaimExtractionUserPrompt(entry));

  if (response.no_claim === true) {
    return null;
  }

  const confidence = normalizeConfidence(response.confidence);
  if (confidence < config.confidenceThreshold) {
    return null;
  }

  const rawEntity = typeof response.entity === "string" ? response.entity.trim() : "";
  const rawAttribute = typeof response.attribute === "string" ? response.attribute.trim() : "";
  const entity = normalizeEntity(rawEntity, entityHints);
  const attribute = normalizeClaimKeyPart(rawAttribute);
  if (!entity || !attribute) {
    return null;
  }

  return {
    claimKey: `${entity}/${attribute}`,
    confidence,
    rawEntity,
    rawAttribute,
  };
}

/**
 * Loads existing entity prefixes for claim-key extraction hinting.
 *
 * @param db - Database port used to read existing claim-key prefixes.
 * @returns Distinct active entity prefixes.
 */
export async function getEntityHints(db: DatabasePort): Promise<string[]> {
  return db.getDistinctClaimKeyPrefixes();
}

/**
 * Builds the classifier system prompt for claim-key extraction.
 *
 * @param entityHints - Existing entity prefixes used to ground the namespace.
 * @returns Stable extraction instructions.
 */
function buildClaimExtractionSystemPrompt(entityHints: string[]): string {
  const normalizedHints = Array.from(new Set(entityHints.map((entityHint) => normalizeClaimKeyPart(entityHint)).filter((entityHint) => entityHint.length > 0)));

  return [
    "You are a knowledge entry classifier. Extract the claim key for a knowledge entry.",
    "A claim key identifies the specific slot this fact occupies: entity/attribute in lowercase snake_case.",
    "",
    "Rules:",
    "- entity: the primary noun this fact is about - the thing being described. Could be a person, project, system, tool, service, concept, dataset, organization, or any other identifiable noun.",
    "- attribute: the specific property or aspect of that entity being stated. Should be narrow enough that two entries with the same entity/attribute are likely describing the same slot of knowledge.",
    "- Format: entity/attribute (both lowercase snake_case)",
    "- If the entry describes multiple unrelated facts, narrative content, or a vague opinion with no single dominant slot, set no_claim to true.",
    "- Confidence: 0.0 to 1.0, how precisely this claim key captures the entry's single dominant slot. Use 0.9+ only when the slot is unambiguous.",
    "",
    `Known entities already in the knowledge base: ${normalizedHints.length > 0 ? normalizedHints.join(", ") : "(none)"}`,
    `If the entry is clearly about one of these existing entities, use that name. Do not invent a new entity name when an existing one matches (e.g., don't create "react_router_v7" if "react_router" already exists and the entry is about React Router).`,
    "",
    'Respond with JSON: { "entity": string, "attribute": string, "confidence": number, "no_claim"?: boolean }',
  ].join("\n");
}

/**
 * Builds the user prompt for one extraction request.
 *
 * @param entry - Candidate entry content to classify.
 * @returns User-visible extraction payload.
 */
function buildClaimExtractionUserPrompt(entry: { type: EntryType; subject: string; content: string }): string {
  return [`Entry type: ${entry.type}`, `Subject: ${entry.subject}`, `Content: ${entry.content}`].join("\n");
}

/**
 * Normalizes a model-provided confidence into the closed [0, 1] range.
 *
 * @param value - Raw confidence value from the model response.
 * @returns Confidence in the supported range.
 */
function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * Resolves common self-referential entity names to a concrete entity from the
 * hint set when there is exactly one unambiguous choice.
 *
 * @param value - Raw entity string returned by the model.
 * @param entityHints - Existing entity prefixes used for alias resolution.
 * @returns Safe claim-key entity segment.
 */
function normalizeEntity(value: string, entityHints: string[]): string {
  const normalizedValue = normalizeClaimKeyPart(value);
  if (normalizedValue.length === 0) {
    return "";
  }

  const normalizedHints = Array.from(new Set(entityHints.map((entityHint) => normalizeClaimKeyPart(entityHint)).filter((entityHint) => entityHint.length > 0)));
  if (SELF_REFERENTIAL_ENTITIES.has(normalizedValue)) {
    if (normalizedHints.length === 1) {
      return normalizedHints[0] ?? normalizedValue;
    }

    return normalizedValue;
  }

  return normalizedValue;
}

/**
 * Normalizes one claim-key segment into lowercase snake_case.
 *
 * @param value - Raw claim-key segment.
 * @returns Stable normalized segment.
 */
function normalizeClaimKeyPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
