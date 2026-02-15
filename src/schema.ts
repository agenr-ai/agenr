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
  content: Type.String({ minLength: 1 }),
  confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  expiry: Type.Union([
    Type.Literal("permanent"),
    Type.Literal("temporary"),
    Type.Literal("session-only"),
  ]),
  tags: Type.Array(Type.String()),
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
