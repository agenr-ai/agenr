import type { Tool } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";

export const KnowledgeEntrySchema = Type.Object({
  type: Type.Union([
    Type.Literal("fact"),
    Type.Literal("decision"),
    Type.Literal("preference"),
    Type.Literal("todo"),
    Type.Literal("relationship"),
    Type.Literal("event"),
    Type.Literal("lesson"),
  ]),
  subject: Type.String({ minLength: 1 }),
  canonical_key: Type.Optional(Type.String()),
  content: Type.String({ minLength: 20 }),
  importance: Type.Integer({ minimum: 1, maximum: 10 }),
  expiry: Type.Union([
    Type.Literal("permanent"),
    Type.Literal("temporary"),
  ]),
  scope: Type.Optional(Type.Union([
    Type.Literal("private"),
    Type.Literal("personal"),
    Type.Literal("public"),
  ])),
  tags: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
  created_at: Type.Optional(Type.String()),
  source_context: Type.String(),
});

export const KnowledgeEntriesSchema = Type.Object({
  entries: Type.Array(KnowledgeEntrySchema),
});

export type KnowledgeEntryFromSchema = Static<typeof KnowledgeEntrySchema>;

export const SUBMIT_KNOWLEDGE_TOOL: Tool<typeof KnowledgeEntriesSchema> = {
  name: "submit_knowledge",
  description: "Submit extracted knowledge entries from the transcript. Call this once with all entries.",
  parameters: KnowledgeEntriesSchema,
};

export const SUBMIT_DEDUPED_KNOWLEDGE_TOOL: Tool<typeof KnowledgeEntriesSchema> = {
  name: "submit_deduped_knowledge",
  description: "Submit the deduplicated list of knowledge entries. Merge duplicates and keep unique entries.",
  parameters: KnowledgeEntriesSchema,
};
