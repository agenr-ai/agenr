import type { Context, Tool } from "@mariozechner/pi-ai";
import type { Client } from "@libsql/client";
import { Type, type Static } from "@sinclair/typebox";
import { runSimpleStream } from "../llm/stream.js";
import type { AgenrConfig, LlmClient } from "../types.js";
import { toNumber, toStringValue } from "../utils/entry-utils.js";
import { logConflict } from "./conflict-log.js";
import { clampConfidence, extractToolCallArgs, resolveModelForLlmClient } from "./llm-helpers.js";
import type { SubjectIndex } from "./subject-index.js";
import { findSimilar } from "./store.js";

const CONTRADICTION_JUDGE_SYSTEM_PROMPT = [
  "You compare two knowledge entries to determine their relationship.",
  "",
  "Classify as one of:",
  '- "supersedes": New entry updates or replaces the existing entry.',
  "  Same topic, newer or more accurate information.",
  "  Example: weight changed from 200 to 180, preferred editor vim to neovim,",
  "  diet changed from keto to paleo.",
  '- "contradicts": Entries make conflicting claims that cannot both be true',
  "  AND it is unclear which is correct.",
  "  Example: two sources disagree on a headquarters location.",
  '- "coexists": Entries are about related topics but both can be true.',
  "  A person can know multiple languages, have multiple skills, enjoy",
  "  multiple activities, and use multiple tools.",
  '  Examples: "knows Rust" + "knows Go", "likes Python for scripts" +',
  '  "prefers TypeScript for backends", "morning gym" + "evening walks",',
  '  "values alone time" + "values teamwork".',
  '- "unrelated": Entries are about different topics despite surface similarity.',
  "",
  "Rules:",
  "- If the entries are about the same specific attribute of the same entity",
  '  and the values differ, that is usually "supersedes" (newer wins).',
  "- Skills, languages, tools, hobbies, activities, and values are ADDITIVE.",
  '  A person can have many of these at once. Use "coexists" for these.',
  "- Single-valued attributes like weight, location, preferred editor, diet,",
  '  or storage backend can only have one value. Use "supersedes" for these.',
  '- Only use "contradicts" when entries genuinely cannot both be true',
  "  AND there is no clear temporal ordering to determine which is newer.",
  '- Prefer "supersedes" over "contradicts" when one entry is clearly newer.',
  '- Prefer "coexists" over "contradicts" when entries could both be valid.',
  '- "unrelated" is for entries about fundamentally different things.',
  "",
  "Call classify_conflict with your assessment.",
].join("\n");

const CONFLICT_RELATIONS = new Set(["contradicts", "supersedes", "coexists", "unrelated"]);
const DEFAULT_CONTRADICTION_THRESHOLD = 0.55;

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

function llmErrorResult(): ConflictResult {
  return {
    relation: "unrelated",
    confidence: 0,
    explanation: "LLM error",
  };
}

function toEpoch(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const args = extractToolCallArgs<Partial<ContradictionJudgeToolArgs>>(
    message,
    CONTRADICTION_JUDGE_TOOL.name,
    ["relation", "confidence", "explanation"],
  );
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
    confidence: clampConfidence(args.confidence, 0),
    explanation: args.explanation.trim(),
  };
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
      model: resolveModelForLlmClient(llmClient, "contradictionJudge", model, config),
      context: buildJudgeContext(newEntry, existing),
      options: {
        apiKey: llmClient.credentials.apiKey,
      },
      verbose: false,
    });

    if (response.stopReason === "error" || response.errorMessage) {
      console.error(
        `[contradiction] LLM judge error: ${response.errorMessage ?? "unknown stop reason"}`,
      );
      return llmErrorResult();
    }

    const parsed = extractJudgeArgs(response);
    if (!parsed) {
      console.error("[contradiction] LLM judge returned unparseable response");
      return llmErrorResult();
    }

    return {
      relation: parsed.relation as ConflictResult["relation"],
      confidence: clampConfidence(parsed.confidence, 0),
      explanation: parsed.explanation,
    };
  } catch (err) {
    console.error(
      `[contradiction] LLM judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  embedding: number[],
  subjectIndex: SubjectIndex,
  llmClient: LlmClient,
  options?: {
    model?: string;
    similarityThreshold?: number;
    maxCandidates?: number;
    config?: AgenrConfig;
  },
): Promise<DetectedConflict[]> {
  // This runs before inserting new entries. Concurrent storeEntries calls can miss
  // each other for the same subject key, which is acceptable for current single-user scale.
  // Lower than dedup threshold (0.72) because contradiction detection needs to catch
  // entries about the same topic that say different things, not just near-duplicates.
  // Real contradictions (e.g., "weighs 185" vs "weighs 175") score 0.63-0.69.
  const similarityThreshold = options?.similarityThreshold ?? DEFAULT_CONTRADICTION_THRESHOLD;
  const maxCandidates = Math.max(1, options?.maxCandidates ?? 5);
  const seenIds = new Set<string>();
  const candidates: ExistingCandidate[] = [];

  if (newEntry.subjectKey?.trim()) {
    const subjectKey = newEntry.subjectKey.trim();
    let subjectIds = subjectIndex.lookup(subjectKey);
    if (subjectIds.length === 0) {
      subjectIds = subjectIndex.fuzzyLookup(subjectKey);
    }

    const subjectCandidates = (await getEntriesByIds(db, subjectIds))
      .sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt))
      .slice(0, maxCandidates);
    for (const candidate of subjectCandidates) {
      if (seenIds.has(candidate.id)) {
        continue;
      }
      seenIds.add(candidate.id);
      candidates.push(candidate);
    }

    if (candidates.length < maxCandidates) {
      const crossIds = subjectIndex.crossEntityLookup(subjectKey);
      const crossCandidates = (await getEntriesByIds(db, crossIds))
        .sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt))
        .slice(0, maxCandidates - candidates.length);
      for (const candidate of crossCandidates) {
        if (seenIds.has(candidate.id)) {
          continue;
        }
        seenIds.add(candidate.id);
        candidates.push(candidate);
      }
    }
  }

  // Candidate strategy: always merge subject-key lookup and embedding lookup,
  // dedupe by id, then cap total candidates to maxCandidates.
  const similar = await findSimilar(db, embedding, maxCandidates);
  for (const match of similar) {
    if (match.similarity < similarityThreshold) {
      continue;
    }
    if (seenIds.has(match.entry.id)) {
      continue;
    }
    if (candidates.length >= maxCandidates) {
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
  if (candidates.length === 0) {
    return [];
  }

  const detected = await Promise.all(
    candidates.map(async (candidate) => {
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
        return null;
      }

      return {
        existingEntryId: candidate.id,
        existingContent: candidate.content,
        existingType: candidate.type,
        existingSubject: candidate.subject,
        existingImportance: candidate.importance,
        result,
      } satisfies DetectedConflict;
    }),
  );

  return detected.filter((entry): entry is DetectedConflict => entry !== null);
}

export async function resolveConflict(
  db: Client,
  newEntryId: string,
  newEntry: { type: string; importance: number },
  conflict: DetectedConflict,
  subjectIndex: SubjectIndex,
  autoSupersedeThreshold?: number,
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
    console.error(
      `[contradiction] resolution: coexist (events are immutable) entry=${conflict.existingEntryId.slice(0, 8)}`,
    );
    return { action: "coexist", reason: "events are immutable" };
  }

  const isTemporalType = conflict.existingType === "fact" || conflict.existingType === "preference";
  const effectiveAutoSupersedeThreshold = autoSupersedeThreshold ?? 0.85;
  const shouldAutoSupersede =
    conflict.result.relation === "supersedes" &&
    conflict.result.confidence > effectiveAutoSupersedeThreshold &&
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

    console.error(
      `[contradiction] resolution: auto-superseded entry=${conflict.existingEntryId.slice(0, 8)} (${conflict.existingType} confidence=${conflict.result.confidence.toFixed(2)})`,
    );
    return {
      action: "auto-superseded",
      reason: "temporal type with high confidence supersession",
    };
  }

  if (
    conflict.result.relation === "contradicts" ||
    conflict.result.confidence <= 0.75 ||
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
    console.error(
      `[contradiction] resolution: flagged for review entry=${conflict.existingEntryId.slice(0, 8)} (${conflict.result.relation} confidence=${conflict.result.confidence.toFixed(2)})`,
    );
    return { action: "flagged", reason: "needs human review" };
  }

  if (
    conflict.result.relation === "supersedes" &&
    conflict.result.confidence > effectiveAutoSupersedeThreshold &&
    isTemporalType &&
    newEntry.importance < conflict.existingImportance
  ) {
    await logConflict(
      db,
      newEntryId,
      conflict.existingEntryId,
      conflict.result.relation,
      conflict.result.confidence,
      "pending",
    );
    console.error(
      `[contradiction] resolution: flagged for review entry=${conflict.existingEntryId.slice(0, 8)} (high-confidence supersedes blocked by importance)`,
    );
    return { action: "flagged", reason: "high-confidence supersession blocked by importance" };
  }

  await logConflict(
    db,
    newEntryId,
    conflict.existingEntryId,
    conflict.result.relation,
    conflict.result.confidence,
    "coexist",
  );

  console.error(
    `[contradiction] resolution: coexist entry=${conflict.existingEntryId.slice(0, 8)}`,
  );
  return { action: "coexist", reason: "entries can coexist" };
}
