import type { Context, Tool } from "@mariozechner/pi-ai";
import type { Client } from "@libsql/client";
import { Type, type Static } from "@sinclair/typebox";
import { resolveModelForTask } from "../config.js";
import { resolveModel } from "../llm/models.js";
import { runSimpleStream } from "../llm/stream.js";
import type { AgenrConfig, LlmClient } from "../types.js";
import { toNumber, toStringValue } from "../utils/entry-utils.js";
import { logConflict } from "./conflict-log.js";
import type { SubjectIndex } from "./subject-index.js";
import { findSimilar } from "./store.js";

const CONTRADICTION_JUDGE_SYSTEM_PROMPT = [
  "You compare two knowledge entries to determine their relationship.",
  "",
  "Classify as one of:",
  '- "supersedes": New entry replaces a single-valued attribute.',
  "  Examples: weight 200->180, preferred editor vim->neovim, diet keto->paleo,",
  "  storage backend postgres->libsql.",
  '- "contradicts": Entries cannot both be true AND no clear temporal winner.',
  "  Example: two sources disagree on a headquarters location at the same time.",
  '- "coexists": Both entries can be true at the same time.',
  '  Examples: "knows Rust" + "knows Go" (person can know both),',
  '  "likes Python for scripts" + "prefers TypeScript for backends",',
  '  "morning gym" + "evening walks" (person can do both).',
  '- "unrelated": Different topics despite surface similarity.',
  "",
  'Key rule - ask: "Can BOTH be true at the same time?"',
  '- Yes -> "coexists" (skills, languages, hobbies, tools, activities are additive)',
  '- No, and newer wins -> "supersedes" (weight, location, single preferences)',
  '- No, and unclear winner -> "contradicts"',
  '- Different topics -> "unrelated"',
  "",
  "Call classify_conflict with your assessment.",
].join("\n");

const CONFLICT_RELATIONS = new Set(["contradicts", "supersedes", "coexists", "unrelated"]);

const CONTRADICTION_JUDGE_TOOL_SCHEMA = Type.Object({
  relation: Type.Union(
    [
      Type.Literal("contradicts"),
      Type.Literal("supersedes"),
      Type.Literal("coexists"),
      Type.Literal("unrelated"),
    ],
    {
      description: "How the new entry relates to the existing entry",
    },
  ),
  confidence: Type.Number({
    description: "Confidence 0-1 in this classification",
  }),
  explanation: Type.String({
    description: "Brief explanation of why this classification was chosen",
  }),
});

type ContradictionJudgeToolArgs = Static<typeof CONTRADICTION_JUDGE_TOOL_SCHEMA>;

const CONTRADICTION_JUDGE_TOOL: Tool<typeof CONTRADICTION_JUDGE_TOOL_SCHEMA> = {
  name: "classify_conflict",
  description: "Classify the relationship between two knowledge entries.",
  parameters: CONTRADICTION_JUDGE_TOOL_SCHEMA,
};

interface ExistingCandidate {
  id: string;
  content: string;
  type: string;
  subject: string;
  importance: number;
  createdAt: string;
}

export interface ConflictResult {
  relation: "contradicts" | "supersedes" | "coexists" | "unrelated";
  confidence: number;
  explanation: string;
}

export interface DetectedConflict {
  existingEntryId: string;
  existingContent: string;
  existingType: string;
  existingSubject: string;
  existingImportance: number;
  result: ConflictResult;
}

export interface ConflictResolution {
  action: "auto-superseded" | "flagged" | "coexist";
  reason: string;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function llmErrorResult(): ConflictResult {
  return {
    relation: "unrelated",
    confidence: 0,
    explanation: "LLM error",
  };
}

function buildJudgeContext(
  newEntry: { content: string; type: string; subject: string },
  existing: { content: string; type: string; subject: string; createdAt: string },
): Context {
  const userPrompt = [
    `EXISTING entry (stored ${existing.createdAt}):`,
    `Type: ${existing.type}`,
    `Subject: ${existing.subject}`,
    `Content: ${existing.content}`,
    "",
    "NEW entry:",
    `Type: ${newEntry.type}`,
    `Subject: ${newEntry.subject}`,
    `Content: ${newEntry.content}`,
  ].join("\n");

  return {
    systemPrompt: CONTRADICTION_JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userPrompt,
        timestamp: Date.now(),
      },
    ],
    tools: [CONTRADICTION_JUDGE_TOOL],
  };
}

function extractJudgeArgs(
  message: {
    content: Array<{ type: string; name?: string; arguments?: unknown }>;
  },
): ContradictionJudgeToolArgs | null {
  for (const block of message.content) {
    if (block.type !== "toolCall" || block.name !== CONTRADICTION_JUDGE_TOOL.name) {
      continue;
    }

    const args = block.arguments as Partial<ContradictionJudgeToolArgs> | undefined;
    if (!args) {
      return null;
    }

    if (
      typeof args.relation !== "string" ||
      !CONFLICT_RELATIONS.has(args.relation) ||
      typeof args.confidence !== "number" ||
      typeof args.explanation !== "string"
    ) {
      return null;
    }

    return {
      relation: args.relation as ConflictResult["relation"],
      confidence: clampConfidence(args.confidence),
      explanation: args.explanation.trim(),
    };
  }

  return null;
}

function resolveContradictionModel(
  llmClient: LlmClient,
  model?: string,
  config?: AgenrConfig,
): ReturnType<typeof resolveModel>["model"] {
  const modelId = model?.trim() || resolveModelForTask(config ?? {}, "contradictionJudge");
  return resolveModel(llmClient.resolvedModel.provider, modelId).model;
}

async function getEntriesByIds(
  db: Client,
  ids: string[],
): Promise<Array<{
  id: string;
  content: string;
  type: string;
  subject: string;
  importance: number;
  createdAt: string;
}>> {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `
      SELECT id, content, type, subject, importance, created_at
      FROM entries
      WHERE id IN (${placeholders})
        AND retired = 0
        AND superseded_by IS NULL
    `,
    args: ids,
  });

  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    const importance = toNumber(record.importance);
    return {
      id: toStringValue(record.id),
      content: toStringValue(record.content),
      type: toStringValue(record.type),
      subject: toStringValue(record.subject),
      importance: Number.isFinite(importance) ? importance : 5,
      createdAt: toStringValue(record.created_at),
    };
  });
}

async function getSubjectKeyForEntry(db: Client, entryId: string): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT subject_key FROM entries WHERE id = ? LIMIT 1",
    args: [entryId],
  });
  const subjectKey = toStringValue((result.rows[0] as Record<string, unknown> | undefined)?.subject_key);
  return subjectKey || null;
}

export async function classifyConflict(
  llmClient: LlmClient,
  newEntry: { content: string; type: string; subject: string },
  existing: { content: string; type: string; subject: string; createdAt: string },
  model?: string,
  config?: AgenrConfig,
): Promise<ConflictResult> {
  try {
    const response = await runSimpleStream({
      model: resolveContradictionModel(llmClient, model, config),
      context: buildJudgeContext(newEntry, existing),
      options: {
        apiKey: llmClient.credentials.apiKey,
        temperature: 0,
      },
      verbose: false,
    });

    if (response.stopReason === "error" || response.errorMessage) {
      return llmErrorResult();
    }

    const parsed = extractJudgeArgs(response);
    if (!parsed) {
      return llmErrorResult();
    }

    return {
      relation: parsed.relation as ConflictResult["relation"],
      confidence: clampConfidence(parsed.confidence),
      explanation: parsed.explanation,
    };
  } catch {
    return llmErrorResult();
  }
}

export async function detectContradictions(
  db: Client,
  newEntry: {
    content: string;
    type: string;
    subject: string;
    subjectKey?: string;
    importance: number;
  },
  embedding: Float32Array,
  subjectIndex: SubjectIndex,
  llmClient: LlmClient,
  options?: {
    model?: string;
    similarityThreshold?: number;
    maxCandidates?: number;
    config?: AgenrConfig;
  },
): Promise<DetectedConflict[]> {
  const similarityThreshold = options?.similarityThreshold ?? 0.72;
  const maxCandidates = Math.max(1, options?.maxCandidates ?? 5);
  const seenIds = new Set<string>();
  const candidates: ExistingCandidate[] = [];

  if (newEntry.subjectKey?.trim()) {
    const subjectIds = subjectIndex.lookup(newEntry.subjectKey.trim());
    const subjectCandidates = await getEntriesByIds(db, subjectIds);
    for (const candidate of subjectCandidates) {
      if (seenIds.has(candidate.id)) {
        continue;
      }
      seenIds.add(candidate.id);
      candidates.push(candidate);
    }
  }

  if (candidates.length < 3) {
    const similar = await findSimilar(db, Array.from(embedding), maxCandidates);
    for (const match of similar) {
      if (match.similarity < similarityThreshold) {
        continue;
      }
      if (seenIds.has(match.entry.id)) {
        continue;
      }

      seenIds.add(match.entry.id);
      candidates.push({
        id: match.entry.id,
        content: match.entry.content,
        type: match.entry.type,
        subject: match.entry.subject,
        importance: match.entry.importance,
        createdAt: match.entry.created_at,
      });
    }
  }

  if (candidates.length === 0) {
    return [];
  }

  const detected: DetectedConflict[] = [];
  for (const candidate of candidates) {
    const result = await classifyConflict(
      llmClient,
      {
        content: newEntry.content,
        type: newEntry.type,
        subject: newEntry.subject,
      },
      {
        content: candidate.content,
        type: candidate.type,
        subject: candidate.subject,
        createdAt: candidate.createdAt,
      },
      options?.model,
      options?.config,
    );

    if (result.relation === "unrelated") {
      continue;
    }

    detected.push({
      existingEntryId: candidate.id,
      existingContent: candidate.content,
      existingType: candidate.type,
      existingSubject: candidate.subject,
      existingImportance: candidate.importance,
      result,
    });
  }

  return detected;
}

export async function resolveConflict(
  db: Client,
  newEntryId: string,
  newEntry: { type: string; importance: number },
  conflict: DetectedConflict,
  subjectIndex: SubjectIndex,
): Promise<ConflictResolution> {
  if (conflict.existingType === "event") {
    await logConflict(
      db,
      newEntryId,
      conflict.existingEntryId,
      conflict.result.relation,
      conflict.result.confidence,
      "coexist",
    );
    return { action: "coexist", reason: "events are immutable" };
  }

  const isTemporalType = conflict.existingType === "fact" || conflict.existingType === "preference";
  const shouldAutoSupersede =
    conflict.result.relation === "supersedes" &&
    conflict.result.confidence > 0.85 &&
    isTemporalType &&
    newEntry.importance >= conflict.existingImportance;

  if (shouldAutoSupersede) {
    await db.execute({
      sql: `
        UPDATE entries
        SET superseded_by = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [newEntryId, new Date().toISOString(), conflict.existingEntryId],
    });

    const subjectKey = await getSubjectKeyForEntry(db, conflict.existingEntryId);
    if (subjectKey) {
      subjectIndex.remove(subjectKey, conflict.existingEntryId);
    }

    await logConflict(
      db,
      newEntryId,
      conflict.existingEntryId,
      conflict.result.relation,
      conflict.result.confidence,
      "auto-superseded",
    );

    return {
      action: "auto-superseded",
      reason: "temporal type with high confidence supersession",
    };
  }

  if (
    conflict.result.relation === "contradicts" ||
    conflict.result.confidence < 0.75 ||
    conflict.existingType === "decision" ||
    conflict.existingType === "lesson"
  ) {
    await logConflict(
      db,
      newEntryId,
      conflict.existingEntryId,
      conflict.result.relation,
      conflict.result.confidence,
      "pending",
    );
    return { action: "flagged", reason: "needs human review" };
  }

  await logConflict(
    db,
    newEntryId,
    conflict.existingEntryId,
    conflict.result.relation,
    conflict.result.confidence,
    "coexist",
  );

  return { action: "coexist", reason: "entries can coexist" };
}
