/**
 * Shared memory prompt doctrine atoms and surface composers for host adapters.
 */

/** Durable type entry for shared type-guide formatting. */
interface DurableTypeDefinition {
  name: string;
  definition: string;
}

const CLAIM_KEY_SLOT_GUIDANCE =
  'exactly two segments: entity/attribute with one slash. Do not use nested paths like project/category/item; collapse extra words into snake_case on either side, for example "skeln/codebase_layout", "postgres/max_connections", or "project_name/deploy_strategy".';

const CLAIM_KEY_DIRECTIVE_GUIDANCE =
  'For directive entries only (type=directive), use the three-segment family user/memory_directive/<name>, for example "user/memory_directive/weekly_goals".';

export /** Human-readable guidance shown in claimKey-related tool schemas. */ const CLAIM_KEY_DESCRIPTION = `Slot-like durables use ${CLAIM_KEY_SLOT_GUIDANCE} ${CLAIM_KEY_DIRECTIVE_GUIDANCE} Entries with the same claim key are candidates for supersession. Invalid claim keys on agenr_store are dropped with a warning; on agenr_update they reject the call.`;

export /** Section header for host memory prompt injection. */ const MEMORY_RECALL_SECTION_HEADER = "## Memory Recall";

const RECALL_FIRST =
  "Before answering anything about prior work, decisions, preferences, people, dates, unfinished work, or past sessions, call agenr_recall first. Session-start recall is automatic, and conservative before-turn recall may also appear as injected background context; use agenr_recall mid-session when you need context you do not already have.";

const RECALL_MODES =
  "agenr_recall supports exact fact recall plus historical and episodic recall behind one tool: use mode=durables for exact facts, decisions, thresholds, and versions; use mode=auto for prior-state questions like what was the previous approach, what did we use before, or what changed from X to Y; use mode=episodes when you explicitly want session narrative recall.";

const RECALL_TRUNCATED_PREVIEWS = "agenr_recall returns truncated durable previews with ids, scores, and preview_truncated flags.";

const FETCH_WHEN_TRUNCATED = "Call agenr_fetch with id when preview_truncated=true or exact stored wording is required.";

const RECALL_INJECTED_CONTEXT =
  "When Agenr injects memory automatically, treat it as non-user background context and use it silently when relevant rather than forcing it into the reply.";

export /** Recall-mode description used by shared agenr_recall tool schemas. */ const RECALL_MODE_SCHEMA_DESCRIPTION =
  "Recall mode: auto routes between exact durable recall, historical-state recall, procedural recall, and episodes; durables forces exact durable recall; episodes forces temporal or semantic session recall; procedures forces procedural recall.";

const STORE_FUTURE_SESSION_QUESTION =
  "will a fresh future session make a better decision because this was stored, or are you just recording that something happened?";

const STORE_CANONICAL_RECORD =
  "If another system already holds the canonical record - such as version control, a task or ticket tracker, a calendar, a signed document, a chat or email thread, or a database/CRM - usually do not store that record. Store only the durable takeaway: the standing rule, implication, lesson, preference, risk, or relationship.";

const STORE_DO_NOT_PROGRESS_OR_CANONICAL =
  "Do not store progress logs, plans, or data already canonical in git, tickets, calendars, signed docs, chat/email, or databases.";

const STORE_TAKEAWAY_NOT_ACTIVITY = "Store the durable takeaway, standing rule, preference, risk, lesson, or relationship instead of raw activity.";

const STORE_CLAIM_KEY_SLOT_USAGE = "Use claimKey for slot-like facts that may be superseded later, such as versions, strategies, owners, or limits.";

const CLAIM_KEY_PROMPT_LINE = `When storing slot-like facts, pass claimKey as ${CLAIM_KEY_SLOT_GUIDANCE}`;

const CLAIM_KEY_STORE_GUIDELINE = `Format claimKey for slot-like durables as ${CLAIM_KEY_SLOT_GUIDANCE}`;

const DURABLE_TYPE_DEFINITIONS_PROMPT: readonly DurableTypeDefinition[] = [
  { name: "fact", definition: "durable truth about a person, system, place, or how something works" },
  { name: "decision", definition: "standing rule, constraint, policy, or chosen approach future sessions should follow" },
  { name: "preference", definition: "what someone likes, wants, values, or wants avoided" },
  { name: "lesson", definition: "non-obvious takeaway from experience that should change future behavior" },
  { name: "milestone", definition: "rare one-time event with durable future significance, not ordinary task completion" },
];

const DURABLE_TYPE_DEFINITIONS_TOOL: readonly DurableTypeDefinition[] = [
  { name: "fact", definition: "durable truth about a person, system, place, or how something works" },
  { name: "decision", definition: "a standing rule, constraint, policy, or chosen approach future sessions should follow" },
  { name: "preference", definition: "what someone likes, wants, values, or wants avoided" },
  { name: "lesson", definition: "a non-obvious takeaway learned from experience that should change future behavior" },
  { name: "milestone", definition: "a rare one-time event with durable future significance, not ordinary execution progress" },
  { name: "relationship", definition: "a meaningful durable connection between people, groups, or systems" },
];

const STORE_NEGATIVE_EXAMPLES = [
  "I merged PR #123.",
  "I filed a support ticket.",
  "We had a meeting at 3 PM.",
  "I sent the contract for signature.",
  "We spent two hours debugging the outage.",
] as const;

const STORE_POSITIVE_EXAMPLES = [
  { quote: "Always use the structured export path because raw sync corrupts timestamps.", label: "decision or lesson" },
  { quote: "Jim prefers text-first updates and dislikes surprise calls.", label: "preference" },
  { quote: "Service restarts fail unless config Y is enabled.", label: "lesson" },
  { quote: "The office Wi-Fi name is Acorn-5G.", label: "fact" },
] as const;

const STORE_DECISION_CATCH_ALL = "Do not use decision as a catch-all for important activity updates.";

const STORE_ANTI_PATTERNS_TOOL =
  "Do not store plans, checklists, speculative future state, progress snapshots, session narration, or rephrased recalled material.";

const STORE_PROGRESS_SNAPSHOTS = "Do not store progress snapshots or current-state narration about what is happening right now as durable memory.";

const STORE_PLANS_AND_SPECULATION = "Do not store plans, checklists, or speculative future state as facts or decisions.";

const STORE_NO_RESTORING_RECALL = "Do not re-store recalled durables, episode summaries, continuity text, or conversation summaries as new evidence.";

const STORE_NO_META_NARRATION = "Do not store meta narration about the current session.";

const STORE_LIFETIMES =
  "Use memory lifetimes deliberately: core is injected at every session start and should be rare, permanent is durable recall-on-demand memory, and temporary is short-horizon. Importance is 1 to 10; 7 is normal durable memory and 9 to 10 is rare and critical.";

const STORE_SUPERSEDES_TOOL =
  "When replacing an existing fact, pass `supersedes` with the old entry's ID. When storing a slot-like fact (for example, a library version or a rollout strategy), pass `claimKey` to enable future supersession detection.";

const STORE_ASK_BEFORE_STORING = "Do not ask before storing - but do ask whether future-you actually needs it.";

const STORE_OPENCLAW_NOT_LOGGING = `Use agenr_store for durable memory, not for logging. Apply the future-session test: ${STORE_FUTURE_SESSION_QUESTION}`;

const STORE_SKELN_NOT_LOGGING =
  "Use agenr_store for durable memory, not for logging. Store only the durable takeaway, standing rule, preference, risk, lesson, or relationship - not progress logs or data already canonical elsewhere.";

const UPDATE_VS_SUPERSEDES =
  "Use agenr_update to correct metadata on an existing durable. Use agenr_store with supersedes for substantive content replacement.";

const UPDATE_CONTRADICTED_BY_EVIDENCE = "When memory is contradicted by live evidence, fix it with agenr_update instead of silently working around it.";

const UPDATE_TARGET_SELECTOR = "Provide exactly one target selector: id or subject.";

const UPDATE_SUBSTANTIVE_REPLACEMENT = "Use agenr_store with supersedes for substantive content replacement.";

const UPDATE_METADATA_DESCRIPTION =
  "Update an existing memory entry in place. Supports metadata corrections: importance, expiry, claimKey, validFrom, validTo, and project.";

const FETCH_PREFER_ID = "Prefer id from agenr_recall when preview_truncated=true or when exact wording matters.";

const SKELN_RECALL_TOOL_GUIDELINES = [
  "Use focused natural-language queries instead of broad 'everything' searches.",
  "Use mode=procedures for how-to or checklist questions, and mode=episodes for what-happened questions tied to time or sessions.",
  "Use asOf when the user asks what was true at an earlier point in time.",
] as const;

export /** Canonical shared memory doctrine atoms referenced across host surfaces. */ const MEMORY_DOCTRINE = {
  recall: {
    first: RECALL_FIRST,
    modes: RECALL_MODES,
    truncatedPreviews: RECALL_TRUNCATED_PREVIEWS,
    fetchWhenTruncated: FETCH_WHEN_TRUNCATED,
    truncatedPreviewsWithFetch: `${RECALL_TRUNCATED_PREVIEWS} ${FETCH_WHEN_TRUNCATED}`,
    injectedContext: RECALL_INJECTED_CONTEXT,
    modeSchema: RECALL_MODE_SCHEMA_DESCRIPTION,
  },
  store: {
    futureSessionQuestion: STORE_FUTURE_SESSION_QUESTION,
    canonicalRecord: STORE_CANONICAL_RECORD,
    claimKeyPromptLine: CLAIM_KEY_PROMPT_LINE,
    claimKeyStoreGuideline: CLAIM_KEY_STORE_GUIDELINE,
    claimKeySlotUsage: STORE_CLAIM_KEY_SLOT_USAGE,
    openClawNotLogging: STORE_OPENCLAW_NOT_LOGGING,
    skelnNotLogging: STORE_SKELN_NOT_LOGGING,
    decisionCatchAll: STORE_DECISION_CATCH_ALL,
    lifetimes: STORE_LIFETIMES,
  },
  update: {
    vsSupersedes: UPDATE_VS_SUPERSEDES,
    contradictedByEvidence: UPDATE_CONTRADICTED_BY_EVIDENCE,
    targetSelector: UPDATE_TARGET_SELECTOR,
    substantiveReplacement: UPDATE_SUBSTANTIVE_REPLACEMENT,
  },
  fetch: {
    preferId: FETCH_PREFER_ID,
  },
} as const;

/**
 * Formats durable type definitions for prompt or tool surfaces.
 *
 * @param definitions - Ordered durable type definitions.
 * @param separator - Clause separator between type definitions.
 * @returns Type-guide line for host memory surfaces.
 */
function formatDurableTypeGuide(definitions: readonly DurableTypeDefinition[], separator: "; " | ". "): string {
  const clauses = definitions.map((entry) => `${entry.name} = ${entry.definition}`);
  return `Type guide: ${clauses.join(separator)}`;
}

/** Formats the negative store examples line for prompt surfaces. */
function formatUsuallyDoNotStoreLine(): string {
  const leading = STORE_NEGATIVE_EXAMPLES.slice(0, -1)
    .map((example) => `'${example}'`)
    .join(", ");
  const last = STORE_NEGATIVE_EXAMPLES[STORE_NEGATIVE_EXAMPLES.length - 1];
  return `Usually do not store: ${leading}, or '${last}'`;
}

/** Formats the positive store examples line for prompt surfaces. */
function formatDoStoreTakeawayPromptLine(): string {
  const examples = STORE_POSITIVE_EXAMPLES.map((example) => `'${example.quote}' (${example.label})`).join(", ");
  return `Do store the durable takeaway instead: ${examples}.`;
}

/** Formats combined store examples for OpenClaw tool descriptions. */
function formatStoreExamplesToolParagraph(): string {
  const negative = formatUsuallyDoNotStoreLine();
  const positiveQuotes = STORE_POSITIVE_EXAMPLES.map((example) => `'${example.quote}'`).join(" ");
  return `${negative} Do store the takeaway instead: ${positiveQuotes}`;
}

/** Formats the combined store anti-pattern paragraph for OpenClaw tool descriptions. */
function formatStoreAntiPatternsToolParagraph(): string {
  return `${STORE_DECISION_CATCH_ALL} ${STORE_ANTI_PATTERNS_TOOL}`;
}

/**
 * Builds store-tool guideline bullets shared by Skeln tool registration and OpenClaw tool descriptions.
 *
 * @returns Store-tool guideline bullets for host adapters.
 */
export function buildStoreToolGuidelines(): string[] {
  return [STORE_DO_NOT_PROGRESS_OR_CANONICAL, STORE_TAKEAWAY_NOT_ACTIVITY, STORE_CLAIM_KEY_SLOT_USAGE, CLAIM_KEY_STORE_GUIDELINE];
}

/**
 * Builds update-tool guideline bullets shared by host adapters.
 *
 * @returns Update-tool guideline bullets for host adapters.
 */
export function buildUpdateToolGuidelines(): string[] {
  return [UPDATE_TARGET_SELECTOR, UPDATE_SUBSTANTIVE_REPLACEMENT];
}

/**
 * Builds Skeln-specific agenr_recall tool guidelines not already in the system prompt.
 *
 * @returns Recall-tool guideline bullets for Skeln hosts.
 */
export function buildSkelnRecallToolGuidelines(): string[] {
  return [...SKELN_RECALL_TOOL_GUIDELINES];
}

/**
 * Builds OpenClaw store doctrine lines inserted into the system prompt.
 *
 * @returns Prompt lines describing agenr_store usage for OpenClaw hosts.
 */
export function buildOpenClawStorePromptLines(): string[] {
  return [
    STORE_OPENCLAW_NOT_LOGGING,
    STORE_CANONICAL_RECORD,
    formatDurableTypeGuide(DURABLE_TYPE_DEFINITIONS_PROMPT, "; "),
    STORE_DECISION_CATCH_ALL,
    formatUsuallyDoNotStoreLine(),
    formatDoStoreTakeawayPromptLine(),
    STORE_PROGRESS_SNAPSHOTS,
    STORE_PLANS_AND_SPECULATION,
    STORE_NO_RESTORING_RECALL,
    STORE_NO_META_NARRATION,
    STORE_LIFETIMES,
    CLAIM_KEY_PROMPT_LINE,
  ];
}

/**
 * Builds the OpenClaw agenr_store tool description.
 *
 * @returns Tool description describing durable store boundaries for OpenClaw hosts.
 */
export function buildOpenClawStoreToolDescription(): string {
  return [
    `Store a new durable memory entry in agenr. Apply the future-session test first: ${STORE_FUTURE_SESSION_QUESTION}`,
    ...buildStoreToolGuidelines(),
    STORE_CANONICAL_RECORD,
    formatDurableTypeGuide(DURABLE_TYPE_DEFINITIONS_TOOL, ". "),
    formatStoreExamplesToolParagraph(),
    formatStoreAntiPatternsToolParagraph(),
    `${STORE_SUPERSEDES_TOOL} ${CLAIM_KEY_STORE_GUIDELINE}`,
    STORE_ASK_BEFORE_STORING,
  ].join("\n\n");
}

/**
 * Builds the Skeln agenr_store tool description.
 *
 * @returns Tool description describing durable store boundaries for Skeln hosts.
 */
export function buildSkelnStoreToolDescription(): string {
  return "Store a new durable memory entry in agenr. Store only durable facts, decisions, preferences, lessons, milestones, and relationships that help a future Skeln session make a better decision.";
}

/**
 * Builds the OpenClaw agenr_recall tool description.
 *
 * @returns Tool description describing recall mode routing for OpenClaw hosts.
 */
export function buildOpenClawRecallToolDescription(): string {
  return "Retrieve knowledge from agenr long-term memory. Use mode=auto for the normal path, including historical-state questions like what was the previous approach or what changed from X to Y and procedural questions like how to do something or what steps to follow; use mode=durables for exact facts and decisions; use mode=episodes for time-bounded 'what happened' questions; use mode=procedures for canonical methods and checklists. Time periods are parsed from the query text. Session-start recall is already handled automatically.";
}

/**
 * Builds the Skeln agenr_recall tool description.
 *
 * @returns Tool description describing recall mode routing for Skeln hosts.
 */
export function buildSkelnRecallToolDescription(): string {
  return "Retrieve knowledge from agenr long-term memory. Use mode=auto for normal use, including exact facts, historical-state questions, time-bounded episode questions, and procedural questions.";
}

/**
 * Builds the shared agenr_update tool description.
 *
 * @returns Tool description describing update boundaries for host adapters.
 */
export function buildUpdateToolDescription(): string {
  return [UPDATE_METADATA_DESCRIPTION, ...buildUpdateToolGuidelines()].join(" ");
}
