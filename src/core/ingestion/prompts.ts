import type { Entry, TranscriptChunk } from "../types.js";

/** Previously extracted entry summary used to suppress chunk-local duplicates. */
type PreviouslyExtracted = {
  type: string;
  subject: string;
  summary: string;
};

const GOOD_EXAMPLE_FACT_HIGH = `{
  "type": "fact",
  "subject": "jim martin penicillin allergy",
  "content": "Jim Martin is allergic to penicillin and related antibiotics, so medication suggestions must avoid them.",
  "importance": "high",
  "expiry": "permanent",
  "tags": ["health", "allergy", "personal"],
  "source_context": "User mentioned a medication constraint"
}`;

const GOOD_EXAMPLE_FACT_STANDARD = `{
  "type": "fact",
  "subject": "production postgres port",
  "content": "The production Postgres instance runs on port 5433, not the default 5432. The staging instance uses the default port.",
  "importance": "standard",
  "expiry": "permanent",
  "tags": ["infrastructure", "database"],
  "source_context": "Connection details confirmed during deployment"
}`;

const GOOD_EXAMPLE_DECISION = `{
  "type": "decision",
  "subject": "project package manager",
  "content": "This project uses pnpm rather than npm for installs, scripts, and dependency changes.",
  "importance": "high",
  "expiry": "permanent",
  "tags": ["workflow", "tooling"],
  "source_context": "User stated a standing project convention"
}`;

const GOOD_EXAMPLE_PREFERENCE = `{
  "type": "preference",
  "subject": "communication style preference",
  "content": "Jim prefers short, direct answers over verbose explanations and will ask follow-ups if he wants more detail.",
  "importance": "standard",
  "expiry": "permanent",
  "tags": ["communication", "style"],
  "source_context": "User stated how they want responses formatted"
}`;

const GOOD_EXAMPLE_LESSON = `{
  "type": "lesson",
  "subject": "cli flag handling gotcha",
  "content": "The CLI only honors --db on subcommands that open a database connection. Passing --db to other subcommands silently ignores it, which caused a 30-minute debugging detour.",
  "importance": "standard",
  "expiry": "temporary",
  "tags": ["cli", "debugging"],
  "source_context": "Surprising behavior discovered during troubleshooting"
}`;

const GOOD_EXAMPLE_MILESTONE = `{
  "type": "milestone",
  "subject": "auth service token migration",
  "content": "The auth service migrated from JWT to session tokens on 2026-02-15, and the old JWT validation middleware was removed.",
  "importance": "low",
  "expiry": "temporary",
  "tags": ["migration", "auth"],
  "source_context": "Migration completed and deployed to production"
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
WHY: Conversation summaries are meta-narration, not durable knowledge.`;

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

const BAD_EXAMPLE_GENERIC = `BAD:
{
  "type": "lesson",
  "subject": "api error debugging",
  "content": "When debugging API errors, always check the response headers for rate limit information before retrying.",
  "importance": "standard",
  "expiry": "permanent",
  "tags": ["api", "debugging"]
}
WHY: Generic advice not grounded in a specific discovery. This reads like a textbook tip, not something learned from a concrete experience in this session.`;

const BAD_EXAMPLE_OBVIOUS = `BAD:
{
  "type": "lesson",
  "subject": "http content type",
  "content": "The fetch call needed a Content-Type header set to application/json for the POST request to work.",
  "importance": "standard",
  "expiry": "temporary",
  "tags": ["http", "api"]
}
WHY: Standard API behavior, not a non-obvious insight. Extract only when the behavior was surprising or project-specific.`;

const BAD_EXAMPLE_NEARDUPE = `BAD (near-duplicate pair - emit only one):
{
  "type": "preference",
  "subject": "architecture priority",
  "content": "Jim prefers getting the system design right before rushing implementation.",
  ...
}
{
  "type": "decision",
  "subject": "agenr architecture priority",
  "content": "Agenr planning should prioritize correct system boundaries over quick implementation churn.",
  ...
}
WHY: These express the same underlying policy from two angles. Emit one entry only. Use preference when the transcript is mainly about a named person's priority or value. Use decision only when the transcript shows the project adopted it as a standing rule.`;

const EMPTY_EXAMPLE = `If nothing qualifies, return exactly:
{"entries":[]}`;

const CHUNK_CALIBRATION_BLOCK = [
  "## Chunk Calibration",
  "",
  "- Most chunks yield 0 entries. That is correct - do not force extractions.",
  "- Typical good output per chunk: 0-2 entries.",
  "- Hard maximum: 5 entries per chunk. Reaching this cap means you are probably over-extracting.",
  "- One grounded, specific entry beats three paraphrases of the same insight. If two candidate entries would answer the same future recall query, keep only the stronger one.",
  "- Before emitting a lesson, ask: is this genuinely a non-obvious insight from a specific experience, or is it standard practice anyone would know? If a textbook or routine how-to guide would contain this advice, skip it.",
  "- Type balance: if your draft extractions are more than 50% any single type, re-examine. Are lessons actually preferences or decisions? Are decisions actually personal priorities or values?",
  "- Importance guide: standard is the default. Use high for entries where forgetting would cause wrong decisions or costly mistakes. Use low for narrow-scope or environment-specific knowledge, especially when code, docs, or config remain the source of truth. Target roughly 15-25% high, 55-65% standard, 15-25% low.",
];

const WHOLE_FILE_CALIBRATION_BLOCK = [
  "## Whole-File Calibration",
  "",
  "When the full session fits in context, calibrate in four steps:",
  "1. Session triage: decide whether this session contains durable signal or is mostly short-horizon activity before extracting anything. A pure troubleshooting or status-check session may yield zero entries.",
  "2. Prioritize user statements: direct user facts, preferences, stated decisions, and committed constraints outrank assistant narration, tool output, and procedural steps. The user saying 'I want X' is signal. The assistant executing X is not.",
  "3. Check type balance: if your draft extractions are more than 50% any single type, re-examine. Are lessons actually preferences or decisions in disguise? Are decisions actually personal priorities or values? Is a fact really a milestone?",
  "4. Check importance balance: standard is the default. High is for entries where forgetting causes wrong decisions or costly mistakes. Low is for narrow-scope context where code, docs, or config are the primary source of truth. Target roughly 15-25% high, 55-65% standard, 15-25% low.",
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
    "The transcript can be about work, home, relationships, health, travel, hobbies, or casual conversation. Do not assume a technical or professional domain.",
    "",
    ...contextSection,
    "Default action: SKIP. Most transcript chunks should produce zero entries.",
    "Extract only durable knowledge that would still help months from now.",
    "Long-term memory is not a changelog, running status diary, release log, doc mirror, checklist archive, or conversation summary.",
    "",
    "## Types",
    "",
    "- fact: Verified descriptive information about a person, project, system, or concept. What something IS.",
    "- decision: A lasting rule, requirement, convention, ownership assignment, or standing choice that constrains future behavior. What to DO going forward.",
    "- preference: A stated preference, opinion, or value that should influence future behavior. What someone WANTS.",
    "- lesson: A non-obvious insight learned from a specific experience that would prevent repeating a mistake or missing a shortcut. Must reference what went wrong or what was discovered - not general advice.",
    "- milestone: A significant one-time milestone, transition, launch, or life/project moment worth remembering. What HAPPENED.",
    "- relationship: A connection between named entities or people.",
    "",
    "## Type Selection",
    "",
    "Before the ordered type checks, apply this discriminator:",
    "- If the statement is mainly about a named person's desired style, values, priorities, or opinions, classify it as preference even if it implies future behavior.",
    "- Use decision only when the transcript shows a person, household, team, project, or system adopted the rule as a standing policy or durable constraint.",
    "- Never emit both a preference and a decision for the same underlying policy.",
    "",
    "When choosing a type, apply these tests in order:",
    "1. Does it describe what something IS (a property, behavior, or state)? → fact",
    "2. Does it state what someone WANTS or PREFERS? → preference",
    "3. Does it prescribe what to DO going forward because a person, household, team, project, or system has adopted it? → decision",
    "4. Does it record something that HAPPENED once (a migration, launch, or shift)? → milestone",
    "5. Does it connect two NAMED things? → relationship",
    "6. Only if none of the above: does it capture a non-obvious WHY learned from a specific failure or surprise? → lesson",
    "",
    "Lesson is the residual category, not the default. If an entry could be a fact or a lesson, it is a fact. If it could be a preference or a decision, prefer preference unless the transcript clearly establishes an adopted standing rule.",
    "",
    "## Commitment Posture",
    "",
    "- Preserve durable commitments as decisions. Do not neutralize lasting directives into bland facts or generic lessons.",
    "- A decision must still matter after the current task succeeds. If it only helps finish this step, skip it.",
    "- Skip one-time instructions such as rename X, add field Y, update test Z, write doc Q, or send link R.",
    "- Use fact instead of decision when the transcript describes current system behavior without adopting it as a standing rule.",
    "- Keep tightly attached rationale only when it materially explains the durable rule.",
    "",
    "## Durability Gate",
    "",
    "Classify every candidate as EPHEMERAL or DURABLE before extracting.",
    "",
    "- EPHEMERAL: routine fixes, temporary status, troubleshooting steps, issue choreography, tool narration, error output, current paths, and local sandbox state.",
    "- DURABLE: personal facts, system behavior facts, strong preferences, architecture decisions, standing workflow rules, ownership rules, committed constraints, and hard-won lessons from specific failures.",
    "- For coding sessions, default to skip. Extract only architecture decisions, stable system facts, stated preferences, reusable lessons from specific failures, or explicit standing rules.",
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
    "## Casual And Personal Sessions",
    "",
    "- Casual tone does not make the signal weak. Personal facts, preferences, relationship details, household routines, travel constraints, health details, and life decisions can be highly durable.",
    "- When someone casually confirms a standing preference, important life fact, or relationship detail, treat it as first-class memory signal.",
    "",
    "## Coding Session Rules",
    "",
    "- Implementation and debugging sessions usually yield 0-1 entries total.",
    "- Skip function-level semantics, handler internals, branch behavior, helper sequencing, and patch-site details unless they are promoted to a stable external contract or architecture boundary.",
    "- Local rebuild or restart advice, current DB paths, and sandbox troubleshooting are ephemeral unless adopted as standing operator policy.",
    "- Descriptive tool behavior discovered during debugging is a fact, not a lesson, unless the behavior was genuinely surprising. Use decision only for explicit human commitments.",
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
    "- If the transcript contains episode recall results, do not extract them as facts. They are derived narrative artifacts, not primary evidence.",
    "- If the transcript contains session handoff or continuity summary text, do not extract it unless the user independently confirms or extends it during the conversation.",
    "- Extract only when the user independently confirms, corrects, contradicts, or extends the information outside the injected block.",
    "",
    "## Claim-Key Preservation",
    "",
    "- If the transcript shows a raw `agenr_store` tool call with an explicit `claim_key` or `claimKey`, copy that value into an optional `claim_key` field on the extracted entry.",
    "- Treat explicit tool-call claim keys as authoritative for that entry. Preserve them instead of re-inferring a different slot from paraphrased content.",
    "- Only include `claim_key` when the transcript explicitly provides one. Do not invent new claim keys in this prompt.",
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
    "- Progress snapshots, to-do lists, and current-state descriptions about what is happening right now rather than durable facts about the world.",
    "- Plans, intentions, and speculative future state that have not been committed as a standing rule.",
    "- Incremental debugging journey instead of the final durable lesson.",
    "- Duplicate or near-duplicate entries about the same idea.",
    "- Release noise, version bumps, publish confirmations, and routine deploy chatter.",
    "- One-off errors, stack traces, or transient failures with no lasting lesson.",
    "- Current issue framing and optimization goals that have not become durable policy.",
    "- Memory operation receipts such as 'stored 3 entries' or 'recalled 2 memories'.",
    "- Generic best-practice advice that could appear in any tutorial or guide. If the content reads like a fortune cookie or routine domain advice, it is not specific enough to extract. If an entry wraps a specific story around a generic conclusion, the generic conclusion is not worth storing unless the entry also captures unique context that the generic advice alone would not convey.",
    "",
    "## Dedup Discipline",
    "",
    "Before adding each entry to your output, check: does this entry's core knowledge overlap with any entry you have already decided to emit?",
    "",
    "Two entries are near-duplicates when they would cause the same agent behavior when recalled, even if worded differently or assigned different types. Test: if you deleted one, would the other still cover the knowledge? If yes, keep only the more complete one.",
    "",
    "Facets of the same system or decision (for example, 'X uses approach A' and 'X avoids approach B because of A') are ONE entry, not two. Combine them.",
    "",
    "After generating all entries, do a final scan: if any pair shares the same subject noun or a closely related subject, justify keeping both or merge them.",
    "",
    "## Importance",
    "",
    'Rate each entry as one of three tiers: "high", "standard", or "low".',
    "",
    "- high: Entries where forgetting would cause the agent to make a wrong architectural decision, violate a foundational constraint, or repeat a costly mistake. Critical personal facts, strong preferences that affect most interactions, and architecture decisions with lasting rationale.",
    "- standard: The default tier. Verified facts, routine decisions, stated preferences, confirmed lessons, and solid durable context.",
    "- low: Narrow-scope knowledge that is real but limited in applicability. Single-project conventions, environment-specific behaviors, terminology clarifications, aspirational preferences without concrete constraints, or context where the primary source of truth is elsewhere (code, docs, config).",
    "- Target distribution: roughly 15-25% high, 55-65% standard, 15-25% low. Standard is the default. If more than 40% of entries are high, re-rate the weakest highs. If you have zero low entries, re-evaluate your weakest standard entries.",
    "",
    "## Expiry",
    "",
    "- permanent: Biographical facts, preferences, lessons, architecture decisions, and standing conventions.",
    "- temporary: Current project state, active work, recent milestones, and time-bounded context.",
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
    "5. The content names the specific person, system, relationship, routine, or situation - not generic advice that could apply in any unrelated guide.",
    "6. A lesson must describe a specific failure, surprise, or non-obvious discovery - not routine domain practice.",
    "",
    ...calibrationBlock,
    "",
    "## Output",
    "",
    'Return JSON only: {"entries":[...]}',
    'Use {"entries":[]} when nothing qualifies.',
    "",
    "Each entry must have:",
    '{ "type": "fact|decision|preference|lesson|relationship|milestone", "subject": "2-6 word topic noun phrase", "content": "specific declarative statement grounded in the concrete person, system, relationship, routine, or situation, min 20 chars", "importance": "high|standard|low", "expiry": "permanent|temporary", "tags": ["1-4", "lowercase", "tags"], "source_context": "one sentence, max 20 words" }',
    'Optional when explicitly present in a source tool call: { "claim_key": "entity/attribute" }',
    "",
    "## Few-Shot Examples",
    "",
    "GOOD (fact, high - critical personal safety information):",
    GOOD_EXAMPLE_FACT_HIGH,
    "",
    "GOOD (fact, standard - useful infrastructure detail):",
    GOOD_EXAMPLE_FACT_STANDARD,
    "",
    "GOOD (decision, high - foundational project constraint):",
    GOOD_EXAMPLE_DECISION,
    "",
    "GOOD (preference, standard - communication style):",
    GOOD_EXAMPLE_PREFERENCE,
    "",
    "GOOD (lesson, standard - specific surprising behavior):",
    GOOD_EXAMPLE_LESSON,
    "",
    "GOOD (milestone, low - historical context, code is the source of truth now):",
    GOOD_EXAMPLE_MILESTONE,
    "",
    BAD_EXAMPLE_META,
    "",
    BAD_EXAMPLE_PATCH,
    "",
    BAD_EXAMPLE_MEMORY,
    "",
    BAD_EXAMPLE_GENERIC,
    "",
    BAD_EXAMPLE_OBVIOUS,
    "",
    BAD_EXAMPLE_NEARDUPE,
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
