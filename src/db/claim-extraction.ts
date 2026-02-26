import type { Context, Tool } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { resolveModel } from "../llm/models.js";
import { runSimpleStream } from "../llm/stream.js";
import type { LlmClient } from "../types.js";

const DEFAULT_CLAIM_EXTRACTION_MODEL = "gpt-4.1-nano";

const CLAIM_EXTRACTION_TOOL_SCHEMA = Type.Object({
  no_claim: Type.Boolean({
    description: "True if entry is too complex for a single claim",
  }),
  subject_entity: Type.Optional(
    Type.String({
      description: "Normalized entity, lowercase: jim, agenr, loopback, keto",
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
      description: "The value or fact: 185 lbs, pnpm, keto, libsql",
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
  "- subject_entity: lowercase, the primary noun (jim, agenr, loopback, keto)",
  "- subject_attribute: snake_case, the specific aspect (weight, package_manager, preferred_language)",
  "- predicate: simple verb (is, prefers, uses, has, works_at, weighs, lives_in)",
  "- object: the value (185 lbs, pnpm, typescript, dallas texas)",
  "- confidence: 0-1, how well this single claim captures the entry",
  "",
  "If the entry contains multiple distinct facts, is a narrative summary,",
  "meeting notes, or cannot be reduced to a single claim, set no_claim to true.",
  "",
  "Examples:",
  "  Entry: \"Jim prefers pnpm over npm for package management\"",
  "  -> subject_entity: jim, subject_attribute: package_manager, predicate: prefers, object: pnpm, confidence: 0.95",
  "",
  "  Entry: \"agenr uses libsql for its storage backend\"",
  "  -> subject_entity: agenr, subject_attribute: storage_backend, predicate: uses, object: libsql, confidence: 0.9",
  "",
  "  Entry: \"Jim weighs 185 lbs after losing 55 lbs on keto\"",
  "  -> subject_entity: jim, subject_attribute: weight, predicate: weighs, object: 185 lbs, confidence: 0.9",
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

function resolveClaimModel(client: LlmClient, model?: string): ReturnType<typeof resolveModel>["model"] {
  const modelId = model?.trim() || DEFAULT_CLAIM_EXTRACTION_MODEL;
  return resolveModel(client.resolvedModel.provider, modelId).model;
}

export async function extractClaim(
  content: string,
  type: string,
  subject: string,
  llmClient: LlmClient,
  model?: string,
): Promise<ExtractedClaim | null> {
  if (!content.trim()) {
    return null;
  }

  try {
    const response = await runSimpleStream({
      model: resolveClaimModel(llmClient, model),
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
      return null;
    }

    const subjectEntity = normalizeEntity(parsed.subject_entity ?? "");
    const subjectAttribute = normalizeAttribute(parsed.subject_attribute ?? "");
    const predicate = normalizePredicate(parsed.predicate ?? "");
    const object = normalizeObject(parsed.object ?? "");

    if (!subjectEntity || !subjectAttribute || !predicate || !object) {
      return null;
    }

    return {
      subjectEntity,
      subjectAttribute,
      subjectKey: `${subjectEntity}/${subjectAttribute}`,
      predicate,
      object,
      confidence: clampConfidence(parsed.confidence ?? 0.5),
    };
  } catch {
    return null;
  }
}

export async function extractClaimsBatch(
  entries: Array<{ content: string; type: string; subject: string }>,
  llmClient: LlmClient,
  model?: string,
): Promise<Array<ExtractedClaim | null>> {
  const claims: Array<ExtractedClaim | null> = [];

  for (const entry of entries) {
    claims.push(await extractClaim(entry.content, entry.type, entry.subject, llmClient, model));
  }

  return claims;
}
