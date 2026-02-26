import type { Context, Tool } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { resolveModelForTask } from "../config.js";
import { resolveModel } from "../llm/models.js";
import { runSimpleStream } from "../llm/stream.js";
import type { AgenrConfig, LlmClient } from "../types.js";

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

export interface ExtractedClaim {
  subjectEntity: string;
  subjectAttribute: string;
  subjectKey: string;
  predicate: string;
  object: string;
  confidence: number;
}

function normalizeEntity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function buildClaimExtractionContext(content: string, type: string, subject: string): Context {
  const userPrompt = [
    `Entry type: ${type}`,
    `Entry subject: ${subject}`,
    `Entry content: ${content}`,
  ].join("\n");

  return {
    systemPrompt: CLAIM_EXTRACTION_SYSTEM_PROMPT,
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

function extractToolArgs(
  message: { content: Array<{ type: string; name?: string; arguments?: unknown }> },
): ClaimExtractionToolArgs | null {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== CLAIM_EXTRACTION_TOOL.name) {
      continue;
    }

    const args = block.arguments as Partial<ClaimExtractionToolArgs> | undefined;
    if (!args || typeof args.no_claim !== "boolean") {
      return null;
    }

    return {
      no_claim: args.no_claim,
      ...(typeof args.subject_entity === "string" ? { subject_entity: args.subject_entity } : {}),
      ...(typeof args.subject_attribute === "string" ? { subject_attribute: args.subject_attribute } : {}),
      ...(typeof args.predicate === "string" ? { predicate: args.predicate } : {}),
      ...(typeof args.object === "string" ? { object: args.object } : {}),
      ...(typeof args.confidence === "number" ? { confidence: args.confidence } : {}),
    };
  }

  return null;
}

function resolveClaimModel(
  client: LlmClient,
  model?: string,
  config?: AgenrConfig,
): ReturnType<typeof resolveModel>["model"] {
  const modelId = model?.trim() || resolveModelForTask(config ?? {}, "claimExtraction");
  return resolveModel(client.resolvedModel.provider, modelId).model;
}

export async function extractClaim(
  content: string,
  type: string,
  subject: string,
  llmClient: LlmClient,
  model?: string,
  config?: AgenrConfig,
): Promise<ExtractedClaim | null> {
  if (!content.trim()) {
    return null;
  }

  try {
    const response = await runSimpleStream({
      model: resolveClaimModel(llmClient, model, config),
      context: buildClaimExtractionContext(content, type, subject),
      options: {
        apiKey: llmClient.credentials.apiKey,
      },
      verbose: false,
    });

    if (response.stopReason === "error" || response.errorMessage) {
      return null;
    }

    const parsed = extractToolArgs(response);
    if (!parsed || parsed.no_claim) {
      console.log(
        `[claim] no claim extracted (${parsed?.no_claim ? "no_claim=true" : "parse failed"})`,
      );
      return null;
    }

    const subjectEntity = normalizeEntity(parsed.subject_entity ?? "");
    const subjectAttribute = normalizeAttribute(parsed.subject_attribute ?? "");
    const predicate = normalizePredicate(parsed.predicate ?? "");
    const object = normalizeObject(parsed.object ?? "");

    if (!subjectEntity || !subjectAttribute || !predicate || !object) {
      return null;
    }

    const confidence = clampConfidence(parsed.confidence ?? 0.5);
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
