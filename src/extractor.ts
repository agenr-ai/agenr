import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import type { Client } from "@libsql/client";
import type { KnowledgeEntry, LlmClient, StoredEntry, TranscriptChunk } from "./types.js";
import { fetchRelatedEntries } from "./db/recall.js";
import { embed } from "./embeddings/client.js";
import { runSimpleStream, type StreamSimpleFn } from "./llm/stream.js";
import { SUBMIT_DEDUPED_KNOWLEDGE_TOOL, SUBMIT_KNOWLEDGE_TOOL } from "./schema.js";
import { isShutdownRequested } from "./shutdown.js";

export const SYSTEM_PROMPT = `You are a selective memory extraction engine. Extract only knowledge worth remembering beyond the immediate step.

Default action: SKIP. Most chunks should produce zero entries.

## Types

FACT — Verifiable information about a system, project, person, or concept.
DECISION — A choice that constrains future options. Requires BOTH the choice AND the rationale. If rationale is missing, use fact or event instead.
PREFERENCE — A stated or demonstrated preference that should influence future behavior.
LESSON — An insight from experience that should change future behavior.
EVENT — A significant milestone, launch, or completion. NOT "the assistant ran git status."
RELATIONSHIP — A connection between named entities. Content must include both entities and the relation.
TODO — A persistent future action not completed in this chunk and not a one-step session instruction.

## Todo Completion Detection

When a todo, task, or action item is explicitly completed in the transcript:
- Emit an "event" entry describing the completion
- Use the same subject as the original todo (for example, if the todo was "fix client test", use subject "fix client test")
- Set the same canonical_key as the original todo if you can infer it
- Include in content: what was done and that it is now resolved
- Do NOT re-emit the original todo as a new todo entry

Examples of completion signals: "that's done", "it's fixed", "completed", "we shipped it", "all tests passing", "merged", "resolved", "closed", "out of the oven", "deployed", "published".

Do NOT emit a completion event for:
- Tasks that are started but not finished ("working on it", "in progress", "in the oven")
- Ambiguous past tense ("we did some work on X")
- Partial completions ("partially fixed")

## Durability Gate

Only extract if useful in future conversations/tasks after the current immediate execution.
If uncertain whether durable, skip.

## Importance (1-10)

Emit only importance >= 5. Start every candidate at 7; lower or raise only with clear justification.

Importance scores map to real behavior in the memory system:
- 8 or higher fires a real-time cross-session signal (an alert to other active AI sessions)
- 7 is stored silently; no alert fires
- Below 7 is stored but deprioritized in recall

Use that signal cost as your conservative filter. Ask: "Does someone in another session need to know this RIGHT NOW?" If no, stay at 7 or below.

Score anchors:

10: Once-per-project facts. Core identity, permanent constraints, "never forget this."
    Example: "This project must never use GPL-licensed dependencies."
    Example: "The production database password rotation requires manual approval."

9: Critical breaking changes or decisions with immediate cross-session impact.
    Use for: major architecture reversals, breaking API changes, critical blockers discovered.
    Example: "agenr embed API changed: model param is now required; all callers must update."
    Example: "Decided to abandon SQLite-vec in favor of Postgres pgvector - all storage code changes."
    NOT 9: "we verified signals work" (that is a 6)
    NOT 9: "tests are passing" (that is a 5-6)
    NOT 9: "deployed feature X" (that is a 7 event at most)

8: Things an active parallel session would act on if notified right now.
    Use for: new user preferences discovered, important architectural facts just learned,
    active blocking issues, key decisions made today that others need to know.
    Example: "User prefers pnpm over npm - verified again today."
    Example: "The chunker silently drops chunks over 8k tokens - callers must split first."
    If in doubt between 7 and 8, use 7.

7: Default for solid durable facts. Stored, retrievable, no alert.
    Use for: project facts, preferences (non-critical), completed milestones, stable architecture notes.
    Example: "agenr stores entries in SQLite with sqlite-vec for vector search."
    Example: "Completed brain audit. Found 73% noise rate in knowledge base."
    This is the right score for most extracted entries.

6: Routine durable observations. Worth storing but minor.
    Use for: dev session observations, test results, routine verifications, minor notes.
    Example: "Verified that signal emission works end to end in local testing."
    Example: "Confirmed the import path change did not break CLI startup."
    Example: "agenr extraction runs in about 2s per chunk on the test dataset."

5: Borderline. Only emit if clearly durable beyond today and actionable in a future session.
    Example: "Port 4242 is the default for the local test server."

Calibration:
- Typical chunk: 0-3 entries. Most chunks: 0.
- Score 9 or 10: very rare, at most 1 per significant session, often 0
- Score 8: at most 1-2 per session; ask the cross-session-alert question before assigning
- Score 7: this is your workhorse; most emitted entries should be 7
- Score 6: routine dev observations that are still worth storing
- If more than 20% of your emitted entries are 8 or higher, you are inflating

Dev session observations rule: Anything in the form "we tested X and it worked", "verified X",
"confirmed X runs", "X is passing" belongs at 6 unless the result was surprising or breaks
something. Test passes and routine verifications are not cross-session alerts.

## Subject (critical)

Subject is the TOPIC, never the speaker, role, or conversation container.

NEVER use as subject: user, assistant, human, ai, bot, developer, engineer, maintainer, team, we, the conversation, this session, the transcript, or any participant's name/handle unless the entry is a biographical fact ABOUT that person.

Subject must be a domain/topic entity, not a role/person — unless the fact is biographical about that specific person.
Good pattern: noun phrase, 2-6 words. Examples: "agenr extraction pipeline", "Tailscale SSH setup", "a person's full name" (only for biographical facts about that person).
If you cannot name a concrete topic, skip the entry.

## Anti-Patterns (do NOT extract)

1. Assistant/user narration or process description
2. Summaries about the conversation itself ("this session focused on…")
3. Session-ephemeral instructions (read file, run command, check logs)
4. Incremental debugging journey — extract only the final lesson/solution if durable
5. Code-level implementation details likely to churn (unless architecture-level decision)
6. One workflow split into multiple near-duplicate entries — merge into one
7. Minor rephrases/duplicates of another extracted entry
8. Greetings, acknowledgments, small talk
9. Transient implementation status unless it represents a milestone, decision, or lesson

## Explicit Memory Requests

When the USER (not the assistant) explicitly says "remember this" or "remember that"
about a non-ephemeral piece of information, always extract it and set importance >= 7.

Triggers (user message only):
- "remember this"
- "remember that"
- Close variants: "make sure to remember this", "don't forget this"

NOT triggers:
- "remember to do X" → extract as todo at normal importance, not boosted
- Any of the above in an ASSISTANT message → not a memory request, ignore
- Vague emphasis words: "important:", "note that", "keep in mind" → NOT triggers;
  these appear in normal conversation and do not justify importance boosting

When triggered:
- Extract the fact/preference/decision at importance >= 7
- If the entry would naturally be importance >= 7 anyway, do not double-boost
- In the content field, describe the knowledge itself (same as any other entry)
- Do NOT write "User explicitly requested..." in the content field - this pollutes
  vector search. The source_context or tags can note the explicit request if needed.

Few-shot examples:
  User: "remember this - we always use pnpm not npm in this project"
  → Extract: preference, "package manager preference: pnpm", importance=7

  User: "remember to run pnpm test before committing"
  → Extract: todo, "run pnpm test before committing", importance=5 (normal todo)

  Assistant: "remember this pattern for future reference"
  → Do NOT boost. Assistant messages don't constitute memory requests.

## Pre-Emit Checklist

Before emitting EACH entry, all five must be true:
1. Subject is a topic (not actor/role/meta)
2. Durable beyond the immediate step
3. Non-duplicate of another entry in this batch
4. Importance >= 5 with a concrete reason
5. Explicit user "remember this/that" requests justify importance >= 7 regardless of content type
If any check fails, do not emit.

## Few-Shot Examples

### GOOD extractions

FACT:
{
  "type": "fact",
  "subject": "agenr knowledge database",
  "content": "agenr stores knowledge in SQLite with sqlite-vec for vector search. Embeddings use OpenAI text-embedding-3-small at 1024 dimensions.",
  "importance": 8,
  "expiry": "permanent",
  "tags": ["agenr", "database", "embeddings"],
  "source_context": "User described agenr database architecture"
}

PREFERENCE:
{
  "type": "preference",
  "subject": "coding workflow preferences",
  "content": "Prefers writing detailed specs before any coding begins. Wants to understand the full design before implementation.",
  "importance": 8,
  "expiry": "permanent",
  "tags": ["workflow", "coding"],
  "source_context": "User explained preferred development process"
}

DECISION:
{
  "type": "decision",
  "subject": "agenr extraction prompt",
  "content": "Decided to rewrite the extraction prompt after audit showed 73% noise. Rationale: bad subjects, meta-narration, and no importance scoring made recall useless.",
  "importance": 8,
  "expiry": "temporary",
  "tags": ["agenr", "extraction", "quality"],
  "source_context": "Discussion of brain audit findings"
}

LESSON:
{
  "type": "lesson",
  "subject": "LLM extraction calibration",
  "content": "Extraction prompts must include numeric importance scales with concrete anchors; without them LLMs default to extracting everything at high importance.",
  "importance": 7,
  "expiry": "permanent",
  "tags": ["llm", "extraction", "prompting"],
  "source_context": "Learned during brain audit of agenr knowledge base"
}

RELATIONSHIP:
{
  "type": "relationship",
  "subject": "OpenClaw architecture",
  "content": "OpenClaw gateway connects to agenr for long-term memory storage and recall during agent sessions.",
  "importance": 7,
  "expiry": "temporary",
  "tags": ["openclaw", "agenr", "architecture"],
  "source_context": "Architecture discussion about memory integration"
}

TODO:
{
  "type": "todo",
  "subject": "agenr deduplication",
  "content": "Implement semantic deduplication in agenr store pipeline to prevent near-duplicate entries from accumulating.",
  "importance": 6,
  "expiry": "temporary",
  "tags": ["agenr", "dedup", "quality"],
  "source_context": "Identified during knowledge base audit"
}

EVENT:
{
  "type": "event",
  "subject": "agenr brain audit",
  "content": "Completed full audit of agenr knowledge base. Found 73% noise, 550 bad subjects, 2500 meta-narration entries out of ~10k total.",
  "importance": 7,
  "expiry": "temporary",
  "tags": ["agenr", "audit", "quality"],
  "source_context": "Brain audit completed and findings documented"
}

EVENT:
{
  "type": "event",
  "subject": "agenr signal emission",
  "content": "Verified end-to-end signal emission works in local testing. Entry stored, signal fired, received in OpenClaw session.",
  "importance": 6,
  "expiry": "temporary",
  "tags": ["agenr", "signals", "testing"],
  "source_context": "Dev session verification of signal feature"
}

FACT:
{
  "type": "fact",
  "subject": "user penicillin allergy",
  "content": "User is allergic to penicillin. Must never suggest it or related antibiotics.",
  "importance": 8,
  "expiry": "permanent",
  "tags": ["health", "allergy", "critical"],
  "source_context": "User mentioned allergy when discussing a doctor visit"
}

FACT:
{
  "type": "fact",
  "subject": "user daughter name",
  "content": "User's daughter is named Emma. She is 8 years old.",
  "importance": 7,
  "expiry": "permanent",
  "tags": ["family", "personal"],
  "source_context": "User mentioned daughter while discussing weekend plans"
}

PREFERENCE:
{
  "type": "preference",
  "subject": "meeting time preference",
  "content": "User prefers morning meetings before noon and avoids late afternoon calls.",
  "importance": 6,
  "expiry": "long-term",
  "tags": ["schedule", "preference"],
  "source_context": "User mentioned scheduling preference during calendar discussion"
}

### BORDERLINE — skip these

SKIP: "The assistant read the config file and found the port was 3000."
WHY: Assistant narration about process, not durable knowledge.

SKIP: "User asked to check if the deployment succeeded."
WHY: Session-ephemeral instruction. Subject would be actor.

SKIP: "The team discussed several approaches to caching."
WHY: Conversation summary. No concrete decision or fact emerged.

### BAD extractions (never produce these)

BAD: { "subject": "User", "content": "The user asked the assistant to check the logs" }
WHY: Subject is actor, content is meta-narration, importance ~2.

BAD: { "type": "todo", "subject": "user", "content": "Run codex from ~/Code/agenr" }
WHY: Session instruction, not persistent task. Subject is actor.

BAD: Five separate entries for steps 1-5 of one workflow.
WHY: Merge into one entry describing the full workflow.

### EMPTY output (expected and correct)

Chunk: "Assistant: I'll read that file now. [reads file] Here's what I found — the function takes two args. User: OK, now run the tests. Assistant: Running tests... all 47 passed."
Output: { "entries": [] }
WHY: Routine execution. No durable knowledge, decisions, or lessons.

## Expiry

- **permanent:** Biographical facts, preferences, lessons, architecture decisions
- **temporary:** Current project state, active work, recent events
- If it only matters right now, don't extract it at all.

## Output Rules

- Call submit_knowledge with extracted entries.
- Empty array is expected and correct for most chunks.
- Max 8 entries; prefer 0-3.
- Each entry: self-contained, declarative, understandable without the transcript.
- canonical_key: optional lowercase hyphenated 3-5 word identifier when clear (example: "preferred-package-manager")
- content: clear declarative statement, not a quote. Min 20 chars.
- source_context: one sentence, max 20 words.
- tags: 1-4 lowercase descriptive tags.
When related memories are injected before a chunk, they are reference material only. They do not lower the emission threshold.`;

const MAX_ATTEMPTS = 5;
const DEFAULT_INTER_CHUNK_DELAY_MS = 150;
const DEDUP_BATCH_SIZE = 50;
const DEDUP_BATCH_TRIGGER = 100;
export const PREFETCH_SIMILARITY_THRESHOLD = 0.72;
const PREFETCH_SIMILARITY_EPSILON = 1e-6;
export const PREFETCH_CANDIDATE_LIMIT = 15;
export const MAX_PREFETCH_RESULTS = 5;
export const PREFETCH_MIN_DB_ENTRIES = 20;
export const PREFETCH_TIMEOUT_MS = 5000;

const DEDUP_SYSTEM_PROMPT = `You are deduplicating a list of extracted knowledge entries.

Rules:
- Merge entries that describe the same knowledge into exactly one entry
- Keep the most complete and accurate version when merging
- Preserve the highest importance score from merged entries
- Combine tags from merged entries, deduplicated, max 4 tags
- Keep genuinely different knowledge as separate entries
- Return the final deduplicated list by calling submit_deduped_knowledge`;

const TYPE_ALIASES: Record<string, KnowledgeEntry["type"]> = {
  facts: "fact",
  decisions: "decision",
  preferences: "preference",
  todos: "todo",
  relationships: "relationship",
  events: "event",
  lessons: "lesson",
  fact: "fact",
  decision: "decision",
  preference: "preference",
  todo: "todo",
  relationship: "relationship",
  event: "event",
  lesson: "lesson",
};

const EXPIRY_ALIASES: Record<string, KnowledgeEntry["expiry"]> = {
  permanent: "permanent",
  temporary: "temporary",
};

export const BASE_BLOCKED_SUBJECTS = [
  "user", "assistant", "the user", "the assistant",
  "human", "ai", "bot", "system",
  "developer", "engineer", "maintainer", "team", "we",
  "the conversation", "this session", "the transcript",
];

export function buildBlockedSubjects(extraNames: string[] = []): Set<string> {
  return new Set([...BASE_BLOCKED_SUBJECTS, ...extraNames.map((name) => name.toLowerCase())]);
}

export const BLOCKED_SUBJECTS = buildBlockedSubjects();

export const META_PATTERNS = [
  /^the (assistant|user|ai|bot|developer|engineer|team) (was |is |has been |should |decided to |suggested )/i,
  /^(assistant|user|developer|engineer) (mentioned|stated|said|discussed|asked|instructed)/i,
  /^in (the |this )?(conversation|session|transcript|discussion)/i,
  /^the assistant (ran|executed|checked|looked at|opened)/i,
  /^(the )?(conversation|session|discussion) (focused on|covered|was about|involved)/i,
] as const;

class ParseResponseError extends Error {}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function preFetchRelated(
  chunkText: string,
  db: Client,
  embeddingApiKey: string,
  embedFn: (texts: string[], apiKey: string) => Promise<number[][]> = embed,
  onVerbose?: (line: string) => void,
): Promise<StoredEntry[]> {
  const run = async (): Promise<StoredEntry[]> => {
    try {
      if (!chunkText.trim()) {
        onVerbose?.("[pre-fetch] skipped (empty chunk text)");
        return [];
      }

      const countResult = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM entries WHERE superseded_by IS NULL",
        args: [],
      });
      const count = Number(countResult.rows[0]?.count ?? 0);
      if (count < PREFETCH_MIN_DB_ENTRIES) {
        onVerbose?.(`[pre-fetch] skipped (db count ${count} < ${PREFETCH_MIN_DB_ENTRIES})`);
        return [];
      }

      const vectors = await embedFn([chunkText], embeddingApiKey);
      const queryVec = vectors[0];
      if (!queryVec || !Array.isArray(queryVec)) {
        onVerbose?.("[pre-fetch] skipped: embedding provider returned no query vector");
        return [];
      }

      onVerbose?.(`[pre-fetch] embedded chunk (${queryVec.length} dims)`);
      const candidates = await fetchRelatedEntries(db, queryVec, PREFETCH_CANDIDATE_LIMIT);
      onVerbose?.(`[pre-fetch] ${candidates.length} candidates returned`);
      const above = candidates.filter(
        (candidate) => candidate.vectorSim + PREFETCH_SIMILARITY_EPSILON >= PREFETCH_SIMILARITY_THRESHOLD,
      );
      onVerbose?.(`[pre-fetch] ${above.length} above threshold ${PREFETCH_SIMILARITY_THRESHOLD}`);
      return above.slice(0, MAX_PREFETCH_RESULTS).map((candidate) => candidate.entry);
    } catch (error) {
      onVerbose?.(`[pre-fetch] skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StoredEntry[]>((resolve) => {
    timeoutId = setTimeout(() => {
      onVerbose?.(`[pre-fetch] skipped: timeout after ${PREFETCH_TIMEOUT_MS}ms`);
      resolve([]);
    }, PREFETCH_TIMEOUT_MS);
  });

  const result = await Promise.race([run(), timeout]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
}

export function buildUserPrompt(chunk: TranscriptChunk, related?: StoredEntry[]): string {
  if (related === undefined) {
    return [
      "Selectively extract durable knowledge from this conversation transcript.",
      "",
      "Transcript:",
      "---",
      chunk.text,
      "---",
      "",
      "Call submit_knowledge once with {\"entries\": [...]} and use an empty array if nothing qualifies.",
    ].join("\n");
  }

  const memoryBlock =
    related.length === 0
      ? "[none found]"
      : related.map((entry) => `- [${entry.type}] ${entry.subject}: ${entry.content}`).join("\n");

  return [
    "Existing related memories (reference only -- your SKIP/emit threshold is unchanged):",
    memoryBlock,
    "",
    "Do not emit entries that express the same fact, topic, or concept as any memory listed above, even if worded differently or from a different angle. If an existing memory already captures the core idea, do not emit a near-variant as a separate entry. When uncertain, omit rather than emit.",
    "If this chunk clearly contradicts a memory listed above, emit a fact entry stating the contradiction directly in the content field. Do not use inline citation markers like [1] or [2] in any field -- these become dead references.",
    "Only emit a cross-reference entry when this chunk extends, contradicts, or updates a specific fact. Do not cross-reference just because entries share the same project or general domain.",
    "Your SKIP/emit threshold is unchanged. The memories above are reference only.",
    "",
    "Selectively extract durable knowledge from this conversation transcript.",
    "",
    "Transcript:",
    "---",
    chunk.text,
    "---",
    "",
    "Call submit_knowledge once with {\"entries\": [...]} and use an empty array if nothing qualifies.",
  ].join("\n");
}

function toSchemaEntries(entries: KnowledgeEntry[]): Array<{
  type: KnowledgeEntry["type"];
  subject: string;
  canonical_key?: string;
  content: string;
  importance: number;
  expiry: Exclude<KnowledgeEntry["expiry"], "core">;
  tags: string[];
  created_at?: string;
  source_context: string;
}> {
  return entries.map((entry) => ({
    type: entry.type,
    subject: entry.subject,
    canonical_key: entry.canonical_key,
    content: entry.content,
    importance: entry.importance,
    expiry: entry.expiry === "permanent" ? "permanent" : "temporary",
    tags: entry.tags.slice(0, 4),
    created_at: entry.created_at,
    source_context: entry.source.context,
  }));
}

function buildDedupPrompt(entries: KnowledgeEntry[], batchIndex: number, totalBatches: number): string {
  const batchLabel =
    totalBatches > 1
      ? `Batch ${batchIndex + 1}/${totalBatches} dedup input (${entries.length} entries):`
      : `Input entries (${entries.length}):`;

  return [
    "Deduplicate these extracted knowledge entries.",
    "Return the deduplicated list via submit_deduped_knowledge.",
    "",
    batchLabel,
    JSON.stringify(toSchemaEntries(entries)),
  ].join("\n");
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]+?)\s*```$/i.exec(trimmed);
  if (match?.[1]) {
    return match[1].trim();
  }
  return trimmed;
}

function coerceType(value: unknown): KnowledgeEntry["type"] | null {
  if (typeof value !== "string") {
    return null;
  }
  return TYPE_ALIASES[normalize(value)] ?? null;
}

function coerceImportance(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  if (parsed < 1 || parsed > 10) {
    return null;
  }
  return parsed;
}

function coerceExpiry(value: unknown): KnowledgeEntry["expiry"] | null {
  if (typeof value !== "string") {
    return null;
  }
  return EXPIRY_ALIASES[normalize(value).replace(/\s+/g, "-")] ?? null;
}

function coerceTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.toLowerCase());

  return Array.from(new Set(tags));
}

function coerceCreatedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString();
}

function coerceCanonicalKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (!/^[a-z0-9]+(?:-[a-z0-9]+){2,4}$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function chunkCreatedAt(chunk: TranscriptChunk): string | undefined {
  return coerceCreatedAt(chunk.timestamp_end) ?? coerceCreatedAt(chunk.timestamp_start);
}

export function validateEntry(entry: KnowledgeEntry): string | null {
  const subjectLower = entry.subject.toLowerCase().trim();
  if (BLOCKED_SUBJECTS.has(subjectLower)) {
    return `blocked subject: "${entry.subject}"`;
  }
  for (const pattern of META_PATTERNS) {
    if (pattern.test(entry.content)) {
      return `meta-pattern: ${pattern}`;
    }
  }
  if (entry.content.length < 20) {
    return "content too short";
  }
  if (entry.importance < 5) {
    return `importance ${entry.importance} < 5`;
  }
  if (!entry.tags || entry.tags.length < 1 || entry.tags.length > 4) {
    return "tags must be 1-4";
  }
  if (entry.source.context && entry.source.context.split(/\s+/).length > 20) {
    return "source_context > 20 words";
  }
  return null;
}

function selectStringField(
  record: Record<string, unknown>,
  ...keys: string[]
): { value: string; key: string | null } {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { value: value.trim(), key };
    }
  }
  return { value: "", key: null };
}

function validateKnowledgeEntry(
  value: unknown,
  file: string,
  chunk: TranscriptChunk,
  warnings: string[],
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry | null {
  if (!value || typeof value !== "object") {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped non-object entry.`);
    return null;
  }

  const record = value as Record<string, unknown>;

  const type = coerceType(record.type);
  if (!type) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with invalid type: "${String(record.type ?? "undefined")}"`);
    return null;
  }

  const contentResult = selectStringField(
    record,
    "content",
    "description",
    "detail",
    "text",
    "summary",
    "value", "statement", "knowledge",
  );
  const content = contentResult.value;
  if (verbose && contentResult.key && contentResult.key !== "content") {
    onVerbose?.(`[field-fallback] used "${contentResult.key}" for content`);
  }
  if (!content) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with empty content.`);
    return null;
  }

  const subjectResult = selectStringField(record, "subject", "name", "topic", "title", "entity");
  const subject = subjectResult.value;
  if (verbose && subjectResult.key && subjectResult.key !== "subject") {
    onVerbose?.(`[field-fallback] used "${subjectResult.key}" for subject`);
  }
  if (!subject) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with empty subject.`);
    return null;
  }

  const importance = coerceImportance(record.importance);
  if (!importance) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with invalid importance.`);
    return null;
  }

  const expiry = coerceExpiry(record.expiry);
  if (!expiry) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: dropped entry with invalid expiry.`);
    return null;
  }

  const sourceRecord =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;

  const contextResult = selectStringField(record, "source_context", "context");
  const nestedContext =
    sourceRecord && typeof sourceRecord.context === "string" ? sourceRecord.context.trim() : "";
  const contextFromModel = nestedContext || contextResult.value;
  if (verbose && !nestedContext && contextResult.key) {
    onVerbose?.(`[field-fallback] used "${contextResult.key}" for source.context`);
  }

  const sourceString = typeof record.source === "string" ? record.source.trim() : "";
  if (verbose && !contextFromModel && sourceString) {
    onVerbose?.('[field-fallback] used "source" string for source.context');
  }
  const createdAt = coerceCreatedAt(record.created_at) ?? chunkCreatedAt(chunk);

  const entry: KnowledgeEntry = {
    type,
    content,
    subject,
    canonical_key: coerceCanonicalKey(record.canonical_key),
    importance,
    expiry,
    tags: coerceTags(record.tags),
    created_at: createdAt,
    source: {
      file,
      context: contextFromModel || sourceString || chunk.context_hint || `chunk ${chunk.chunk_index + 1}`,
    },
  };

  const validationIssue = validateEntry(entry);
  if (validationIssue) {
    if (verbose) {
      onVerbose?.(`[entry-drop] ${validationIssue}`);
    }
    return null;
  }

  return entry;
}

function mapSchemaEntry(
  raw: unknown,
  file: string,
  chunk: TranscriptChunk,
  warnings: string[],
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;

  const type = typeof record.type === "string" ? TYPE_ALIASES[record.type.toLowerCase()] ?? null : null;
  if (!type) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: invalid type "${String(record.type)}".`);
    return null;
  }

  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: empty content.`);
    return null;
  }

  const subject = typeof record.subject === "string" ? record.subject.trim() : "";
  if (!subject) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: empty subject.`);
    return null;
  }

  const importance = coerceImportance(record.importance);
  if (!importance) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: invalid importance.`);
    return null;
  }

  const expiry = coerceExpiry(record.expiry);
  if (!expiry) {
    warnings.push(`Chunk ${chunk.chunk_index + 1}: invalid expiry.`);
    return null;
  }
  const createdAt = coerceCreatedAt(record.created_at) ?? chunkCreatedAt(chunk);

  const entry: KnowledgeEntry = {
    type,
    content,
    subject,
    canonical_key: coerceCanonicalKey(record.canonical_key),
    importance,
    expiry,
    tags: coerceTags(record.tags),
    created_at: createdAt,
    source: {
      file,
      context:
        typeof record.source_context === "string" && record.source_context.trim().length > 0
          ? record.source_context.trim()
          : chunk.context_hint || `chunk ${chunk.chunk_index + 1}`,
    },
  };

  const validationIssue = validateEntry(entry);
  if (validationIssue) {
    if (verbose) {
      onVerbose?.(`[entry-drop] ${validationIssue}`);
    }
    return null;
  }

  return entry;
}

function parseKnowledgeEntries(
  rawText: string,
  file: string,
  chunk: TranscriptChunk,
  warnings: string[],
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry[] {
  const stripped = stripCodeFence(rawText);
  let parsed: unknown;

  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new ParseResponseError(
      `Chunk ${chunk.chunk_index + 1}: model response was not valid JSON (${error instanceof Error ? error.message : "parse failure"}).`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ParseResponseError(`Chunk ${chunk.chunk_index + 1}: model response was not a JSON array.`);
  }

  if (verbose && parsed.length > 0) {
    onVerbose?.(`[raw-sample] ${JSON.stringify(parsed[0])}`);
  }

  const entries: KnowledgeEntry[] = [];
  for (const item of parsed) {
    const validated = validateKnowledgeEntry(item, file, chunk, warnings, verbose, onVerbose);
    if (validated) {
      entries.push(validated);
    }
  }

  return entries;
}

function extractToolCallEntries(
  message: AssistantMessage,
  file: string,
  chunk: TranscriptChunk,
  warnings: string[],
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];

  for (const block of message.content) {
    if (block.type !== "toolCall") {
      continue;
    }

    if (block.name !== "submit_knowledge") {
      warnings.push(`Chunk ${chunk.chunk_index + 1}: unexpected tool call "${block.name}".`);
      continue;
    }

    const args = block.arguments as { entries?: unknown[] };
    if (!Array.isArray(args.entries)) {
      warnings.push(`Chunk ${chunk.chunk_index + 1}: tool call had no entries array.`);
      continue;
    }

    for (const raw of args.entries) {
      const entry = mapSchemaEntry(raw, file, chunk, warnings, verbose, onVerbose);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  if (verbose && entries.length > 0) {
    onVerbose?.(`[raw-sample] ${JSON.stringify(entries[0])}`);
  }

  if (entries.length === 0) {
    const textBlocks = message.content.filter((block): block is { type: "text"; text: string } => block.type === "text");
    if (textBlocks.length > 0) {
      const text = textBlocks.map((block) => block.text).join("\n").trim();
      if (text.length > 0) {
        return parseKnowledgeEntries(text, file, chunk, warnings, verbose, onVerbose);
      }
    }
  }

  return entries;
}

function mapDedupSchemaEntry(
  raw: unknown,
  file: string,
  warnings: string[],
  warningLabel: string,
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const type = coerceType(record.type);
  if (!type) {
    warnings.push(`${warningLabel}: dropped entry with invalid type.`);
    return null;
  }

  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) {
    warnings.push(`${warningLabel}: dropped entry with empty content.`);
    return null;
  }

  const subject = typeof record.subject === "string" ? record.subject.trim() : "";
  if (!subject) {
    warnings.push(`${warningLabel}: dropped entry with empty subject.`);
    return null;
  }

  const importance = coerceImportance(record.importance);
  if (!importance) {
    warnings.push(`${warningLabel}: dropped entry with invalid importance.`);
    return null;
  }

  const expiry = coerceExpiry(record.expiry);
  if (!expiry) {
    warnings.push(`${warningLabel}: dropped entry with invalid expiry.`);
    return null;
  }

  const sourceRecord =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;
  const sourceContext =
    (typeof record.source_context === "string" && record.source_context.trim().length > 0
      ? record.source_context.trim()
      : "") ||
    (sourceRecord && typeof sourceRecord.context === "string" && sourceRecord.context.trim().length > 0
      ? sourceRecord.context.trim()
      : "") ||
    (typeof record.source === "string" && record.source.trim().length > 0 ? record.source.trim() : "") ||
    "dedup pass";

  const entry: KnowledgeEntry = {
    type,
    content,
    subject,
    canonical_key: coerceCanonicalKey(record.canonical_key),
    importance,
    expiry,
    tags: coerceTags(record.tags),
    created_at: coerceCreatedAt(record.created_at),
    source: {
      file,
      context: sourceContext,
    },
  };

  const validationIssue = validateEntry(entry);
  if (validationIssue) {
    if (verbose) {
      onVerbose?.(`[entry-drop] ${validationIssue}`);
    }
    return null;
  }

  return entry;
}

function parseDedupTextEntries(
  rawText: string,
  file: string,
  warnings: string[],
  warningLabel: string,
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry[] | null {
  const stripped = stripCodeFence(rawText);
  let parsed: unknown;

  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  const rawEntries =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown[] }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : null;
  if (!rawEntries) {
    return null;
  }

  const entries: KnowledgeEntry[] = [];
  for (const raw of rawEntries) {
    const entry = mapDedupSchemaEntry(raw, file, warnings, warningLabel, verbose, onVerbose);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function extractDedupToolCallEntries(
  message: AssistantMessage,
  file: string,
  warnings: string[],
  warningLabel: string,
  verbose = false,
  onVerbose?: (line: string) => void,
): KnowledgeEntry[] | null {
  const entries: KnowledgeEntry[] = [];
  let sawToolCall = false;

  for (const block of message.content) {
    if (block.type !== "toolCall") {
      continue;
    }

    if (block.name !== "submit_deduped_knowledge" && block.name !== "submit_knowledge") {
      continue;
    }

    sawToolCall = true;
    const args = block.arguments as { entries?: unknown[] };
    if (!Array.isArray(args.entries)) {
      warnings.push(`${warningLabel}: dedup tool call had no entries array.`);
      continue;
    }

    for (const raw of args.entries) {
      const entry = mapDedupSchemaEntry(raw, file, warnings, warningLabel, verbose, onVerbose);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  if (sawToolCall) {
    return entries;
  }

  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    return null;
  }

  return parseDedupTextEntries(text, file, warnings, warningLabel, verbose, onVerbose);
}

function chunkEntries(entries: KnowledgeEntry[], size: number): KnowledgeEntry[][] {
  const chunks: KnowledgeEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

function pickNewestCreatedAt(entries: KnowledgeEntry[]): string | undefined {
  let newestMs = -1;
  let newestIso: string | undefined;

  for (const entry of entries) {
    const iso = coerceCreatedAt(entry.created_at);
    if (!iso) {
      continue;
    }

    const ms = new Date(iso).getTime();
    if (ms > newestMs) {
      newestMs = ms;
      newestIso = iso;
    }
  }

  return newestIso;
}

function inferCreatedAt(entry: KnowledgeEntry, sourceEntries: KnowledgeEntry[]): string | undefined {
  const exactMatches = sourceEntries.filter(
    (candidate) =>
      candidate.type === entry.type &&
      normalizeForMatch(candidate.subject) === normalizeForMatch(entry.subject) &&
      normalizeForMatch(candidate.content) === normalizeForMatch(entry.content),
  );
  const exactNewest = pickNewestCreatedAt(exactMatches);
  if (exactNewest) {
    return exactNewest;
  }

  const topicalMatches = sourceEntries.filter(
    (candidate) =>
      candidate.type === entry.type && normalizeForMatch(candidate.subject) === normalizeForMatch(entry.subject),
  );
  const topicalNewest = pickNewestCreatedAt(topicalMatches);
  if (topicalNewest) {
    return topicalNewest;
  }

  return pickNewestCreatedAt(sourceEntries);
}

function ensureCreatedAt(entries: KnowledgeEntry[], sourceEntries: KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.map((entry) => ({
    ...entry,
    created_at: coerceCreatedAt(entry.created_at) ?? inferCreatedAt(entry, sourceEntries),
  }));
}

async function deduplicateBatchWithLlm(params: {
  file: string;
  entries: KnowledgeEntry[];
  batchIndex: number;
  totalBatches: number;
  model: Model<Api>;
  apiKey: string;
  verbose: boolean;
  onVerbose?: (line: string) => void;
  onStreamDelta?: (delta: string, kind: "text" | "thinking") => void;
  streamSimpleImpl?: StreamSimpleFn;
}): Promise<{ entries: KnowledgeEntry[]; warnings: string[] }> {
  const warningLabel =
    params.totalBatches > 1
      ? `Dedup batch ${params.batchIndex + 1}/${params.totalBatches}`
      : "Dedup";
  const warnings: string[] = [];

  const context: Context = {
    systemPrompt: DEDUP_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildDedupPrompt(params.entries, params.batchIndex, params.totalBatches),
        timestamp: Date.now(),
      },
    ],
    tools: [SUBMIT_DEDUPED_KNOWLEDGE_TOOL],
  };

  const assistantMessage = await runSimpleStream({
    model: params.model,
    context,
    options: {
      apiKey: params.apiKey,
      reasoning: params.verbose ? "low" : undefined,
    },
    verbose: params.verbose,
    onVerbose: params.onVerbose,
    onStreamDelta: params.onStreamDelta,
    streamSimpleImpl: params.streamSimpleImpl,
  });

  if (assistantMessage.stopReason === "error" || assistantMessage.errorMessage) {
    throw new Error(assistantMessage.errorMessage ?? "unknown error");
  }

  const deduped = extractDedupToolCallEntries(
    assistantMessage,
    params.file,
    warnings,
    warningLabel,
    params.verbose,
    params.onVerbose,
  );

  if (!deduped || deduped.length === 0) {
    warnings.push(`${warningLabel}: model returned no valid deduplicated entries; keeping original entries.`);
    return { entries: params.entries, warnings };
  }

  return { entries: ensureCreatedAt(deduped, params.entries), warnings };
}

async function deduplicateEntriesWithLlm(params: {
  file: string;
  entries: KnowledgeEntry[];
  client: LlmClient;
  verbose: boolean;
  onVerbose?: (line: string) => void;
  onStreamDelta?: (delta: string, kind: "text" | "thinking") => void;
  streamSimpleImpl?: StreamSimpleFn;
}): Promise<{ entries: KnowledgeEntry[]; warnings: string[] }> {
  const batches =
    params.entries.length > DEDUP_BATCH_TRIGGER
      ? chunkEntries(params.entries, DEDUP_BATCH_SIZE)
      : [params.entries];

  const deduped: KnowledgeEntry[] = [];
  const warnings: string[] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    try {
      const batchResult = await deduplicateBatchWithLlm({
        file: params.file,
        entries: batch,
        batchIndex,
        totalBatches: batches.length,
        model: params.client.resolvedModel.model,
        apiKey: params.client.credentials.apiKey,
        verbose: params.verbose,
        onVerbose: params.onVerbose,
        onStreamDelta: params.onStreamDelta,
        streamSimpleImpl: params.streamSimpleImpl,
      });
      deduped.push(...batchResult.entries);
      warnings.push(...batchResult.warnings);
    } catch (error) {
      warnings.push(
        `Dedup batch ${batchIndex + 1}/${batches.length}: failed (${error instanceof Error ? error.message : String(error)}), keeping original entries.`,
      );
      deduped.push(...batch);
    }
  }

  if (params.verbose) {
    params.onVerbose?.(
      `Dedup: ${params.entries.length} entries -> ${deduped.length} entries (${Math.max(0, params.entries.length - deduped.length)} merged)`,
    );
  }

  return { entries: deduped, warnings };
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ParseResponseError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("rate")
  );
}

function isRateLimitedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("429") || message.includes("rate limit") || message.includes("rate limited");
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractChunkOnce(params: {
  file: string;
  chunk: TranscriptChunk;
  model: Model<Api>;
  apiKey: string;
  verbose: boolean;
  onVerbose?: (line: string) => void;
  onStreamDelta?: (delta: string, kind: "text" | "thinking") => void;
  streamSimpleImpl?: StreamSimpleFn;
  related?: StoredEntry[];
}): Promise<{ entries: KnowledgeEntry[]; warnings: string[] }> {
  const prompt = buildUserPrompt(params.chunk, params.related);

  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
    tools: [SUBMIT_KNOWLEDGE_TOOL],
  };

  const assistantMessage = await runSimpleStream({
    model: params.model,
    context,
    options: {
      apiKey: params.apiKey,
      reasoning: params.verbose ? "low" : undefined,
    },
    verbose: params.verbose,
    onVerbose: params.onVerbose,
    onStreamDelta: params.onStreamDelta,
    streamSimpleImpl: params.streamSimpleImpl,
  });

  if (assistantMessage.stopReason === "error" || assistantMessage.errorMessage) {
    throw new Error(
      `Chunk ${params.chunk.chunk_index + 1}: provider returned an error (${assistantMessage.errorMessage ?? "unknown error"}).`,
    );
  }

  const warnings: string[] = [];
  const entries = extractToolCallEntries(
    assistantMessage,
    params.file,
    params.chunk,
    warnings,
    params.verbose,
    params.onVerbose,
  );
  return { entries, warnings };
}

export interface ExtractChunksResult {
  entries: KnowledgeEntry[];
  successfulChunks: number;
  failedChunks: number;
  warnings: string[];
  aborted?: boolean;
  skippedChunks?: number;
}

export interface ExtractChunkCompleteResult {
  chunkIndex: number;
  totalChunks: number;
  entries: KnowledgeEntry[];
  warnings: string[];
}

export async function extractKnowledgeFromChunks(params: {
  file: string;
  chunks: TranscriptChunk[];
  client: LlmClient;
  verbose: boolean;
  noDedup?: boolean;
  interChunkDelayMs?: number;
  llmConcurrency?: number;
  onVerbose?: (line: string) => void;
  onStreamDelta?: (delta: string, kind: "text" | "thinking") => void;
  onChunkComplete?: (result: ExtractChunkCompleteResult) => Promise<void>;
  streamSimpleImpl?: StreamSimpleFn;
  sleepImpl?: (ms: number) => Promise<void>;
  retryDelayMs?: (attempt: number) => number;
  db?: Client;
  embeddingApiKey?: string;
  noPreFetch?: boolean;
  embedFn?: (texts: string[], apiKey: string) => Promise<number[][]>;
}): Promise<ExtractChunksResult> {
  const warnings: string[] = [];
  const entries: KnowledgeEntry[] = [];

  let successfulChunks = 0;
  let failedChunks = 0;
  let startedChunks = 0;

  const baseDelay = Math.max(
    0,
    Number.isFinite(params.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_DELAY_MS)
      ? Math.trunc(params.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_DELAY_MS)
      : DEFAULT_INTER_CHUNK_DELAY_MS,
  );
  let dynamicDelay = baseDelay;
  let lastThrottleNoticeDelayMs: number | null = null;
  const sleep = params.sleepImpl ?? sleepMs;

  const llmConcurrency = Math.max(1, Math.trunc(params.llmConcurrency ?? 1));
  const bufferStreamDeltas = llmConcurrency > 1 && Boolean(params.onStreamDelta);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(llmConcurrency, params.chunks.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (isShutdownRequested()) {
          return;
        }

        const currentIndex = cursor;
        cursor += 1;
        if (currentIndex >= params.chunks.length) {
          return;
        }

        startedChunks += 1;
        const chunk = params.chunks[currentIndex];
        if (!chunk) {
          return;
        }

        let chunkDone = false;
        let lastError: unknown = null;
        let chunkResult: { entries: KnowledgeEntry[]; warnings: string[] } | null = null;
        let streamBuffer: Array<{ delta: string; kind: "text" | "thinking" }> = [];
        const related =
          params.noPreFetch === true
            ? undefined
            : params.db && params.embeddingApiKey
              ? await preFetchRelated(
                  chunk.text,
                  params.db,
                  params.embeddingApiKey,
                  params.embedFn,
                  params.verbose ? params.onVerbose : undefined,
                )
              : undefined;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          if (params.verbose) {
            params.onVerbose?.(
              `[chunk ${chunk.chunk_index + 1}/${params.chunks.length}] attempt ${attempt}/${MAX_ATTEMPTS}`,
            );
          }

          if (bufferStreamDeltas) {
            streamBuffer = [];
          }

          try {
            chunkResult = await extractChunkOnce({
              file: params.file,
              chunk,
              model: params.client.resolvedModel.model,
              apiKey: params.client.credentials.apiKey,
              verbose: params.verbose,
              onVerbose: params.onVerbose,
              onStreamDelta: bufferStreamDeltas
                ? (delta, kind) => {
                    streamBuffer.push({ delta, kind });
                  }
                : params.onStreamDelta,
              streamSimpleImpl: params.streamSimpleImpl,
              related,
            });

            warnings.push(...chunkResult.warnings);
            successfulChunks += 1;
            chunkDone = true;
            break;
          } catch (error) {
            lastError = error;

            if (attempt < MAX_ATTEMPTS && isRetryableError(error)) {
              if (isRateLimitedError(error)) {
                dynamicDelay = Math.min(5000, Math.max(baseDelay, dynamicDelay * 2));
                if (
                  params.onVerbose &&
                  dynamicDelay >= baseDelay * 2 &&
                  lastThrottleNoticeDelayMs !== dynamicDelay
                ) {
                  params.onVerbose(`Rate limited, backing off to ${dynamicDelay}ms between chunks`);
                  lastThrottleNoticeDelayMs = dynamicDelay;
                }
              }

              const backoffMs =
                params.retryDelayMs?.(attempt) ?? Math.min(2000 * 2 ** (attempt - 1), 60_000);
              warnings.push(
                `Chunk ${chunk.chunk_index + 1}: attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}), retrying in ${backoffMs}ms.`,
              );
              await sleep(backoffMs);
              continue;
            }

            break;
          }
        }

        if (!chunkDone) {
          failedChunks += 1;
          warnings.push(
            `Chunk ${chunk.chunk_index + 1}: extraction failed (${lastError instanceof Error ? lastError.message : String(lastError)}).`,
          );
        } else if (chunkResult) {
          dynamicDelay = Math.max(baseDelay, Math.floor(dynamicDelay * 0.9));
          if (params.onChunkComplete) {
            await params.onChunkComplete({
              chunkIndex: chunk.chunk_index,
              totalChunks: params.chunks.length,
              entries: chunkResult.entries,
              warnings: chunkResult.warnings,
            });
          } else {
            entries.push(...chunkResult.entries);
          }
        }

        if (params.onStreamDelta) {
          if (bufferStreamDeltas) {
            for (const item of streamBuffer) {
              params.onStreamDelta(item.delta, item.kind);
            }
          }
          params.onStreamDelta("\n", "text");
        }

        if (dynamicDelay > 0 && cursor < params.chunks.length && !isShutdownRequested()) {
          if (llmConcurrency > 1) {
            const jitterMs = Math.max(0, Math.trunc(dynamicDelay * (0.5 + Math.random())));
            await sleep(jitterMs);
          } else if (currentIndex < params.chunks.length - 1) {
            // Preserve existing (serial) delay behavior.
            await sleep(dynamicDelay);
          }
        }
      }
    }),
  );

  const skippedChunks = Math.max(0, params.chunks.length - startedChunks);
  const aborted = skippedChunks > 0 && isShutdownRequested();
  if (aborted) {
    warnings.push(`Shutdown requested; skipped ${skippedChunks} chunk(s).`);
  }

  let finalEntries = entries;
  if (!aborted && !params.noDedup && finalEntries.length > 1) {
    const dedupResult = await deduplicateEntriesWithLlm({
      file: params.file,
      entries: finalEntries,
      client: params.client,
      verbose: params.verbose,
      onVerbose: params.onVerbose,
      onStreamDelta: params.onStreamDelta,
      streamSimpleImpl: params.streamSimpleImpl,
    });
    finalEntries = dedupResult.entries;
    warnings.push(...dedupResult.warnings);
  }

  return {
    entries: finalEntries,
    successfulChunks,
    failedChunks,
    warnings,
    aborted: aborted ? true : undefined,
    skippedChunks: aborted ? skippedChunks : undefined,
  };
}
