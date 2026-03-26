import type { Entry, TranscriptChunk } from "../types.js";

type PreviouslyExtracted = {
  type: string;
  subject: string;
  summary: string;
};

const GOOD_EXAMPLE_FACT = `{
  "type": "fact",
  "subject": "jim martin penicillin allergy",
  "content": "Jim Martin is allergic to penicillin and related antibiotics, so medication suggestions must avoid them.",
  "importance": "high",
  "expiry": "permanent",
  "tags": ["health", "allergy", "personal"],
  "source_context": "User mentioned a medication constraint"
}`;

const GOOD_EXAMPLE_DECISION = `{
  "type": "decision",
  "subject": "agenr package manager",
  "content": "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
  "importance": "high",
  "expiry": "permanent",
  "tags": ["workflow", "tooling"],
  "source_context": "User stated a standing project convention"
}`;

const GOOD_EXAMPLE_LESSON = `{
  "type": "lesson",
  "subject": "cli flag handling",
  "content": "The CLI only honors --db on subcommands, so direct top-level invocation can silently ignore the database override.",
  "importance": "standard",
  "expiry": "temporary",
  "tags": ["cli", "debugging", "lesson"],
  "source_context": "Durable behavior discovered during troubleshooting"
}`;

const GOOD_EXAMPLE_TODO = `{
  "type": "todo",
  "subject": "agenr semantic deduplication",
  "content": "Implement semantic deduplication in the store pipeline so near-duplicate memories do not accumulate.",
  "importance": "standard",
  "expiry": "temporary",
  "tags": ["dedup", "pipeline"],
  "source_context": "Persistent follow-up identified during planning"
}`;

const BAD_EXAMPLE_META = `BAD:
{
  "type": "fact",
  "subject": "this session",
  "content": "This session focused on debugging the extraction pipeline.",
  "importance": "standard",
  "expiry": "temporary",
  "tags": ["session"]
}
WHY: Conversation summaries are meta and not durable knowledge.`;

const BAD_EXAMPLE_PATCH = `BAD:
{
  "type": "decision",
  "subject": "fetchSessionCandidates SELECT list",
  "content": "Add recall_intervals to the SELECT list in fetchSessionCandidates.",
  "importance": "standard",
  "expiry": "temporary",
  "tags": ["sql", "bugfix"]
}
WHY: This is a one-time implementation instruction, not a lasting rule.`;

const BAD_EXAMPLE_MEMORY = `BAD:
{
  "type": "preference",
  "subject": "mexican food preference",
  "content": "User likes Mexican food because the recalled memory block said so.",
  "importance": "standard",
  "expiry": "permanent",
  "tags": ["food"]
}
WHY: Replayed memory in an injected block is not fresh evidence unless the user confirms it live.`;

const EMPTY_EXAMPLE = `If nothing qualifies, return exactly:
{"entries":[]}`;

const CHUNK_CALIBRATION_BLOCK = [
  "## Chunk Calibration",
  "",
  "- Most chunks should emit 0 entries.",
  "- Typical good output is 0-3 entries.",
  "- Hard maximum is 8 entries, but hitting that cap should be rare.",
  "- Prefer one strong entry over several overlapping paraphrases.",
];

const WHOLE_FILE_CALIBRATION_BLOCK = [
  "## Whole-File Calibration",
  "",
  "When the full session fits in context, calibrate in three steps:",
  "1. Session triage: decide whether this is mostly durable signal or mostly implementation churn before extracting anything.",
  "2. Prioritize user messages: direct user facts, preferences, and committed constraints outrank assistant narration, tool chatter, and procedural steps.",
  "3. Extract with the same constraints: whole-file mode gives broader context, not permission to lower the skip threshold.",
];

/**
 * Builds the base system prompt for transcript extraction.
 *
 * @param options - Prompt mode switches such as whole-file calibration.
 * @returns System prompt text for the extraction LLM.
 */
export function buildExtractionSystemPrompt(options: { wholeFile?: boolean; extractionContext?: string; currentDate?: string } = {}): string {
  const calibrationBlock = options.wholeFile ? WHOLE_FILE_CALIBRATION_BLOCK : CHUNK_CALIBRATION_BLOCK;
  const dateString = options.currentDate ?? new Date().toISOString().slice(0, 10);

  const contextSection = options.extractionContext
    ? [
        "## User Context",
        "",
        options.extractionContext,
        "",
        "Use this to inform what is relevant, current, and worth extracting versus what is historical or stale.",
        "",
      ]
    : [];

  return [
    "You are a highly selective memory extraction engine.",
    "",
    `Current date: ${dateString}. Use transcript timestamps to judge recency and relevance.`,
    "",
    ...contextSection,
    "Default action: SKIP. Most transcript chunks should produce zero entries.",
    "Extract only durable knowledge that would still help months from now.",
    "Long-term memory is not a changelog, debug diary, release log, doc mirror, or conversation summary.",
    "",
    "## Types",
    "",
    "- fact: Verified descriptive information about a person, project, system, or concept.",
    "- decision: A lasting rule, requirement, convention, ownership assignment, or architecture choice that constrains future work.",
    "- preference: A stated preference that should influence future behavior.",
    "- lesson: A reusable insight learned from experience or debugging.",
    "- event: A significant one-time milestone or life/project moment worth remembering.",
    "- relationship: A connection between named entities or people.",
    "- todo: A persistent future action that remains open beyond the immediate step.",
    "",
    "## Commitment Posture",
    "",
    "- Preserve durable commitments as decisions. Do not neutralize lasting directives into bland facts.",
    "- A decision must still matter after the current task succeeds. If it only helps finish this step, skip it.",
    "- Skip one-time instructions such as rename X, add field Y, update test Z, write doc Q, or send link R.",
    "- Use fact instead of decision when the transcript describes current system behavior without adopting it as a standing rule.",
    "- Keep tightly attached rationale only when it materially explains the durable rule.",
    "",
    "## Durability Gate",
    "",
    "Classify every candidate as EPHEMERAL or DURABLE before extracting.",
    "",
    "- EPHEMERAL: routine bug fixes, temporary status, debug steps, issue choreography, branch chatter, tool narration, error output, current paths, and local sandbox state.",
    "- DURABLE: personal facts, strong preferences, recurring lessons, architecture boundaries, standing workflow rules, ownership rules, and committed constraints.",
    "- For coding sessions, default to skip. Extract only architecture boundaries, reusable lessons, stable system facts, or explicit standing rules.",
    "- The 6-month test: if knowing this six months from now would still help an agent assist the user, it may be durable.",
    "",
    "## State And Transition Distinctions",
    "",
    "- Keep prior state, current state, and explicit transitions distinct when the transcript makes that distinction durable.",
    "- Do not blend 'used to X, now Y' into a fuzzy summary.",
    "- If an early diagnosis is later corrected, keep only the corrected durable understanding unless the mistake itself teaches a reusable lesson.",
    "",
    "## Subject Rules",
    "",
    "- Subject is the topic, never the actor, role, or conversation container.",
    "- Never use subjects like user, assistant, human, ai, bot, developer, engineer, team, we, the conversation, this session, or the transcript.",
    "- Use a 2-6 word noun phrase that names the durable topic.",
    "- Personal facts should use the person's name when known, such as 'jim martin dietary preference' or 'sarah relationship'.",
    "- If the only available subject is a local helper, file path, SQL query, or patch site, that is a strong skip signal unless the transcript clearly establishes a broader rule.",
    "",
    "## Coding Session Rules",
    "",
    "- Implementation and debugging sessions usually yield 0-1 entries total.",
    "- Skip function-level semantics, handler internals, branch behavior, helper sequencing, and patch-site details unless they are promoted to a stable external contract or architecture boundary.",
    "- Local rebuild or restart advice, current DB paths, and sandbox troubleshooting are ephemeral unless adopted as standing operator policy.",
    "- Descriptive tool behavior discovered during debugging is fact or lesson at most; use decision only for explicit human commitments.",
    "",
    "## Doc-Shaped Sources",
    "",
    "- Do not paraphrase README, AGENTS, INSTALL, setup docs, or runbooks just because they contain must/should language.",
    "- Skip folder cartography, onboarding steps, prompt file locations, and generic contributor advice.",
    "- Extract from docs only when the transcript explicitly ratifies a durable architecture boundary, convention, exception, or lesson that should survive outside the document.",
    "",
    "## Injected Memory And Bootstrap Blocks",
    "",
    "- Replayed memory blocks are reference material, not fresh evidence.",
    "- Do not re-extract facts that appear only inside sections like 'Recent memory', 'Recalled context', 'Recent session', or similar startup wrappers.",
    "- Extract only when the user independently confirms, corrects, contradicts, or extends the information outside the injected block.",
    "",
    "## Self-Referential And Hypothetical Content",
    "",
    "- Skip assistant commentary about its own output, retrieved results, or current behavior unless the conversation establishes a durable design rule or lesson.",
    "- Skip made-up examples, fixture data, placeholder names, sample JSON values, and hypothetical people or companies.",
    "- If examples explain a durable design, extract the design rule, not the example data.",
    "",
    "## Anti-Patterns",
    "",
    "- Conversation summaries or meta narration.",
    "- Session-ephemeral instructions and command checklists.",
    "- Incremental debugging journey instead of the final durable lesson.",
    "- Duplicate or near-duplicate entries about the same idea.",
    "- Release noise, version bumps, publish confirmations, and routine deploy chatter.",
    "- One-off errors, stack traces, or transient failures with no lasting lesson.",
    "- Current issue framing and optimization goals that have not become durable policy.",
    "- Memory operation receipts such as 'stored 3 entries' or 'recalled 2 memories'.",
    "",
    "## Importance",
    "",
    'Rate each entry as one of three tiers: "high", "standard", or "low".',
    "",
    "- high: Architecture decisions with rationale, strong preferences, critical personal facts, recurring lessons, foundational constraints.",
    "- standard: Verified facts, routine decisions, basic preferences, and one-time context worth keeping.",
    "- low: Tentative observations, uncertain context, or weak signals worth storing but not prioritizing.",
    "- Most entries should be standard.",
    "",
    "## Expiry",
    "",
    "- permanent: Biographical facts, preferences, lessons, architecture decisions, and standing conventions.",
    "- temporary: Current project state, active work, recent events, and time-bounded context.",
    '- Extraction never assigns "core".',
    "",
    "## Previously Extracted Context",
    "",
    "If the user prompt lists previously extracted subjects from this file, treat them as already captured.",
    "Do not emit another entry unless the new chunk clearly adds, updates, or contradicts that knowledge.",
    "",
    "## Pre-Emit Checklist",
    "",
    "Before emitting each entry, all of these must be true:",
    "1. The subject names a topic, not a speaker or session container.",
    "2. The knowledge is durable beyond the immediate step.",
    "3. The entry is not a near-duplicate of another output entry or previously extracted subject.",
    "4. The content states the durable knowledge itself, not the extraction process.",
    "",
    "## Final Dedup Pass",
    "",
    "- Merge near-duplicates into one canonical entry.",
    "- Keep separate entries only when the durable state, durable value, relationship, or governing scope is genuinely different.",
    "- If the same personal fact appears once with a generic subject and once with the person's name, keep the named-person version only.",
    "",
    ...calibrationBlock,
    "",
    "## Output",
    "",
    'Return JSON only: {"entries":[...]}',
    'Use {"entries":[]} when nothing qualifies.',
    "",
    "Each entry must have:",
    '{ "type": "fact|decision|preference|lesson|event|relationship|todo", "subject": "2-6 word topic noun phrase", "content": "clear declarative statement, min 20 chars", "importance": "high|standard|low", "expiry": "permanent|temporary", "tags": ["1-4", "lowercase", "tags"], "source_context": "one sentence, max 20 words" }',
    "",
    "## Few-Shot Examples",
    "",
    "GOOD:",
    GOOD_EXAMPLE_FACT,
    "",
    "GOOD:",
    GOOD_EXAMPLE_DECISION,
    "",
    "GOOD:",
    GOOD_EXAMPLE_LESSON,
    "",
    "GOOD:",
    GOOD_EXAMPLE_TODO,
    "",
    BAD_EXAMPLE_META,
    "",
    BAD_EXAMPLE_PATCH,
    "",
    BAD_EXAMPLE_MEMORY,
    "",
    EMPTY_EXAMPLE,
  ].join("\n");
}

/**
 * Builds the user prompt for a transcript chunk extraction call.
 *
 * @param chunk - Transcript chunk to extract from.
 * @param options - Optional related-memory and prior-extraction context.
 * @returns User message content for the extraction LLM.
 */
export function buildChunkPrompt(
  chunk: TranscriptChunk,
  options: {
    relatedEntries?: Entry[];
    previouslyExtracted?: PreviouslyExtracted[];
  } = {},
): string {
  const sections: string[] = [];

  if (options.relatedEntries && options.relatedEntries.length > 0) {
    sections.push(
      "Related existing memories (reference only - do not lower the skip threshold):",
      ...options.relatedEntries.slice(0, 12).map((entry) => `- [${entry.type}] ${entry.subject}: ${entry.content}`),
      "",
      "Do not emit duplicates of those memories. Only emit if this chunk clearly adds new durable information or contradicts an existing memory.",
      "",
    );
  }

  sections.push(
    `Transcript chunk ${chunk.chunk_index + 1} covering messages ${chunk.message_range[0]}-${chunk.message_range[1]}:`,
    "---",
    chunk.text,
    "---",
    "",
  );

  if (options.previouslyExtracted && options.previouslyExtracted.length > 0) {
    sections.push(
      "Previously extracted from this file (do not repeat unless this chunk updates or contradicts them):",
      ...options.previouslyExtracted.map((entry) => `- [${entry.type}] "${entry.subject}" - ${entry.summary}`),
      "",
    );
  }

  sections.push("Return JSON only. No markdown fences, no commentary, and no extra keys.");

  return sections.join("\n");
}
