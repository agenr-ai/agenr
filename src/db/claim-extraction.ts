import type { Context, Tool } from "@mariozechner/pi-ai";
import type { Client } from "@libsql/client";
import { Type, type Static } from "@sinclair/typebox";
import { runSimpleStream } from "../llm/stream.js";
import type { AgenrConfig, LlmClient } from "../types.js";
import { clampConfidence, extractToolCallArgs, resolveModelForLlmClient } from "./llm-helpers.js";

const CLAIM_EXTRACTION_TOOL_SCHEMA = Type.Object({
  no_claim: Type.Boolean({
    description: "True if entry is too complex for a single claim",
  }),
  subject_entity: Type.Optional(
    Type.String({
      description: "Normalized entity, lowercase: alex, agenr, acme, paleo",
    }),
  ),
  subject_attribute: Type.Optional(
    Type.String({
      description:
        "Normalized attribute, snake_case: weight, package_manager, diet, storage_backend",
    }),
  ),
  predicate: Type.Optional(
    Type.String({
      description: "Relationship verb: is, prefers, uses, works_at, has, weighs",
    }),
  ),
  object: Type.Optional(
    Type.String({
      description: "The value or fact: 180 lbs, pnpm, paleo, libsql",
    }),
  ),
  confidence: Type.Optional(
    Type.Number({
      description: "0-1 confidence that this claim accurately captures the entry",
    }),
  ),
});

type ClaimExtractionToolArgs = Static<typeof CLAIM_EXTRACTION_TOOL_SCHEMA>;

const CLAIM_EXTRACTION_TOOL: Tool<typeof CLAIM_EXTRACTION_TOOL_SCHEMA> = {
  name: "extract_claim",
  description: "Extract one structured claim from a knowledge entry when possible.",
  parameters: CLAIM_EXTRACTION_TOOL_SCHEMA,
};

const CLAIM_EXTRACTION_SYSTEM_PROMPT = [
  "You extract structured claims from knowledge entries.",
  "A claim captures the core assertion as: entity + attribute + predicate + object.",
  "",
  "Rules:",
  "- subject_entity: lowercase, the primary noun (alex, agenr, acme, paleo)",
  "- subject_entity MUST be a single root noun, never a phrase.",
  "  Pick the primary entity the fact is about.",
  "  WRONG: \"alex pet\" -> RIGHT: \"alex\"",
  "  WRONG: \"agenr extraction model\" -> RIGHT: \"agenr\"",
  "  WRONG: \"system architecture\" -> RIGHT: \"system\"",
  "  If the entry is about Alex's pet, entity is \"alex\", attribute is \"pet\".",
  "  If the entry is about agenr's model, entity is \"agenr\", attribute is \"extraction_model\".",
  "- Use the \"Entry subject\" field as a hint for entity resolution.",
  "  If subject says \"Buddy breed\", the entity is likely \"buddy\".",
  "  The subject field tells you what the entry is ABOUT.",
  "- subject_attribute: snake_case, the specific aspect (weight, package_manager, preferred_language)",
  "- predicate: simple verb (is, prefers, uses, has, works_at, weighs, lives_in)",
  "- object: the value (180 lbs, pnpm, paleo, libsql)",
  "- confidence: 0-1, how well this single claim captures the entry",
  "",
  "Only set no_claim to true if the entry genuinely contains multiple",
  "UNRELATED facts or is a long narrative with no single dominant assertion.",
  "If the entry has a primary fact with some extra context, extract the",
  "primary fact. Prefer extracting a claim over returning no_claim.",
  "A short, clear factual statement is ALWAYS a claim, even if it looks",
  "trivial. If the content states a specific fact, value, or setting,",
  "extract it.",
  "  \"agenr default dedup threshold is 0.72\" -> extract (clear fact)",
  "  \"Alex works at Acme Corp\" -> extract (clear fact)",
  "",
  "WRONG to return no_claim:",
  "  \"Alex works at Acme Corp as lead engineer\"",
  "  (clear primary claim: alex works_at acme corp)",
  "",
  "RIGHT to return no_claim:",
  "  \"Discussed team hiring, budget allocation, and migration timeline\"",
  "  (multiple unrelated topics, no single dominant fact)",
  "Also return no_claim if:",
  "- The entry is a vague opinion with no specific entity, attribute,",
  "  or value: \"It might be better to use a different approach here\"",
  "  -> no_claim: true",
  "- The entry is a single word or fragment with no assertion:",
  "  \"paleo\" -> no_claim: true",
  "",
  "Examples:",
  "  Entry: \"Alex prefers pnpm over npm for package management\"",
  "  -> subject_entity: alex, subject_attribute: package_manager, predicate: prefers, object: pnpm, confidence: 0.95",
  "",
  "  Entry: \"agenr uses libsql for its storage backend\"",
  "  -> subject_entity: agenr, subject_attribute: storage_backend, predicate: uses, object: libsql, confidence: 0.9",
  "",
  "  Entry: \"Alex weighs 180 lbs after losing 50 lbs on paleo\"",
  "  -> subject_entity: alex, subject_attribute: weight, predicate: weighs, object: 180 lbs, confidence: 0.9",
  "",
  "  Entry: \"Alex works at Acme Corp as lead engineer\"",
  "  -> subject_entity: alex, subject_attribute: employer, predicate: works_at, object: acme corp, confidence: 0.9",
  "",
  "  Entry: \"Alex values alone time and continuous improvement\"",
  "  -> subject_entity: alex, subject_attribute: values, predicate: values, object: alone time and continuous improvement, confidence: 0.8",
  "",
  "  Entry: \"Alex dislikes semicolons and prefers hyphens\"",
  "  -> subject_entity: alex, subject_attribute: formatting, predicate: dislikes, object: semicolons, confidence: 0.85",
  "",
  "  Entry: \"Web UI moved from v0.9 to v1.0 milestone\"",
  "  -> subject_entity: agenr, subject_attribute: web_ui_milestone, predicate: moved_to, object: v1.0, confidence: 0.8",
  "",
  "  Entry: \"Alex has a dog named Buddy\"",
  "  -> subject_entity: alex, subject_attribute: pet, predicate: has, object: buddy, confidence: 0.9",
  "",
  "  Entry: \"Long meeting summary discussing Q3 roadmap priorities and team structure...\"",
  "  -> no_claim: true",
  "",
  "Call extract_claim with your final answer.",
].join("\n");

const ENTITY_ALIASES: Record<string, string> = {
  "the user": "user",
  "current user": "user",
  the_user: "user",
  current_user: "user",
  i: "user",
  me: "user",
  myself: "user",
};

export interface ExtractedClaim {
  subjectEntity: string;
  subjectAttribute: string;
  subjectKey: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface ExtractClaimOptions {
  model?: string;
  config?: AgenrConfig;
  entityHints?: string[];
}

function normalizeEntity(value: string): string {
  return value.trim().toLowerCase().replace(/\//g, "-").replace(/\s+/g, " ");
}

function resolveEntityAlias(entity: string, existingEntities?: Set<string>): string {
  const aliased = ENTITY_ALIASES[entity];
  if (aliased) {
    return aliased;
  }

  if (existingEntities && existingEntities.size > 0 && entity === "user") {
    const nonUserEntities = [...existingEntities]
      .filter((existingEntity) => existingEntity !== "user")
      .sort((a, b) => a.localeCompare(b));
    if (nonUserEntities.length > 0) {
      return nonUserEntities[0];
    }
  }

  return entity;
}

function normalizeAttribute(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizePredicate(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeObject(value: string): string {
  return value.trim();
}

function buildClaimExtractionSystemPrompt(entityHints?: string[]): string {
  if (!entityHints || entityHints.length === 0) {
    return CLAIM_EXTRACTION_SYSTEM_PROMPT;
  }

  const normalizedHints = [...new Set(entityHints.map((entity) => normalizeEntity(entity)).filter((entity) => entity))];
  if (normalizedHints.length === 0) {
    return CLAIM_EXTRACTION_SYSTEM_PROMPT;
  }

  return [
    CLAIM_EXTRACTION_SYSTEM_PROMPT,
    "",
    `Known entities in the knowledge base: ${normalizedHints.join(", ")}`,
    "Use one of these entities if the entry is about any of them.",
    "If the subject is the user/owner of the knowledge base, use their actual name from the entity hints rather than generic terms like \"user\", \"me\", or \"I\".",
    "Only create a new entity name if none of the known entities apply.",
  ].join("\n");
}

function buildClaimExtractionContext(content: string, type: string, subject: string, entityHints?: string[]): Context {
  const userPrompt = [
    `Entry type: ${type}`,
    `Entry subject: ${subject}`,
    `Entry content: ${content}`,
  ].join("\n");

  return {
    systemPrompt: buildClaimExtractionSystemPrompt(entityHints),
    messages: [
      {
        role: "user",
        content: userPrompt,
        timestamp: Date.now(),
      },
    ],
    tools: [CLAIM_EXTRACTION_TOOL],
  };
}

function resolveExtractClaimOptions(
  modelOrOptions?: string | ExtractClaimOptions,
  config?: AgenrConfig,
): ExtractClaimOptions {
  if (typeof modelOrOptions === "string") {
    return {
      model: modelOrOptions,
      config,
    };
  }

  if (modelOrOptions) {
    return modelOrOptions;
  }

  return config ? { config } : {};
}

export async function getDistinctEntities(db: Client): Promise<string[]> {
  const result = await db.execute(
    "SELECT DISTINCT subject_entity FROM entries WHERE subject_entity IS NOT NULL AND retired = 0 AND superseded_by IS NULL LIMIT 50",
  );

  const entities = new Set<string>();
  for (const row of result.rows) {
    const value = (row as Record<string, unknown>).subject_entity;
    const normalized = normalizeEntity(typeof value === "string" ? value : "");
    if (normalized) {
      entities.add(normalized);
    }
  }

  return [...entities];
}

export async function extractClaim(
  content: string,
  type: string,
  subject: string,
  llmClient: LlmClient,
  modelOrOptions?: string | ExtractClaimOptions,
  config?: AgenrConfig,
): Promise<ExtractedClaim | null> {
  if (!content.trim()) {
    return null;
  }

  const resolvedOptions = resolveExtractClaimOptions(modelOrOptions, config);
  const existingEntities = resolvedOptions.entityHints
    ? new Set(resolvedOptions.entityHints.map((entity) => normalizeEntity(entity)).filter((entity) => entity))
    : undefined;

  try {
    const response = await runSimpleStream({
      model: resolveModelForLlmClient(
        llmClient,
        "claimExtraction",
        resolvedOptions.model,
        resolvedOptions.config,
      ),
      context: buildClaimExtractionContext(content, type, subject, resolvedOptions.entityHints),
      options: {
        apiKey: llmClient.credentials.apiKey,
      },
      verbose: false,
    });

    if (response.stopReason === "error" || response.errorMessage) {
      return null;
    }

    const parsed = extractToolCallArgs<ClaimExtractionToolArgs>(
      response,
      CLAIM_EXTRACTION_TOOL.name,
      ["no_claim"],
    );
    if (!parsed || typeof parsed.no_claim !== "boolean" || parsed.no_claim) {
      console.log(
        `[claim] no claim extracted (${parsed?.no_claim ? "no_claim=true" : "parse failed"})`,
      );
      return null;
    }

    const subjectEntity = resolveEntityAlias(
      normalizeEntity(typeof parsed.subject_entity === "string" ? parsed.subject_entity : ""),
      existingEntities,
    );
    const subjectAttribute = normalizeAttribute(
      typeof parsed.subject_attribute === "string" ? parsed.subject_attribute : "",
    );
    const predicate = normalizePredicate(typeof parsed.predicate === "string" ? parsed.predicate : "");
    const object = normalizeObject(typeof parsed.object === "string" ? parsed.object : "");

    if (!subjectEntity || !subjectAttribute || !predicate || !object) {
      return null;
    }

    const confidence = clampConfidence(typeof parsed.confidence === "number" ? parsed.confidence : 0.5);
    console.log(
      `[claim] extracted: key=${subjectEntity}/${subjectAttribute} pred=${predicate} obj="${object.slice(0, 40)}" conf=${confidence.toFixed(2)}`,
    );
    return {
      subjectEntity,
      subjectAttribute,
      subjectKey: `${subjectEntity}/${subjectAttribute}`,
      predicate,
      object,
      confidence,
    };
  } catch {
    return null;
  }
}

export async function extractClaimsBatch(
  entries: Array<{ content: string; type: string; subject: string }>,
  llmClient: LlmClient,
  model?: string,
  config?: AgenrConfig,
): Promise<Array<ExtractedClaim | null>> {
  const claims: Array<ExtractedClaim | null> = [];

  for (const entry of entries) {
    claims.push(await extractClaim(entry.content, entry.type, entry.subject, llmClient, model, config));
  }

  return claims;
}
