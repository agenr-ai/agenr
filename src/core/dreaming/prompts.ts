import type { DreamSessionStoreDurable } from "./session-store-guard.js";
import type { DreamClaimKeyContextDurable } from "./claim-key-context.js";
import type { TranscriptChunk } from "../types.js";

const GOOD_EPISODE_EXAMPLE = `{
  "type": "preference",
  "subject": "communication style preference",
  "content": "Jim prefers terse responses with an explain-first approach when debugging unfamiliar systems.",
  "importance": "standard",
  "expiry": "permanent",
  "tags": ["communication", "style"],
  "source_context": "User stated response preferences during a personal onboarding session.",
  "claim_key": "jim/communication_style"
}`;

const BAD_EPISODE_PROJECT_SCOPE = `BAD:
{
  "type": "fact",
  "subject": "jim birthday",
  "content": "Jim Martin is 49 years old and his birthday is March 15.",
  "importance": "high",
  "expiry": "permanent",
  "tags": ["family", "personal"],
  "source_context": "User shared family details during casual conversation.",
  "claim_key": "jim/birthday",
  "project": "skeln"
}
WHY: Personal family facts are cross-workspace knowledge. Do not tag them with the session workspace just because the chat happened inside one repo.`;

const BAD_EPISODE_META = `BAD:
{
  "type": "fact",
  "subject": "this session",
  "content": "The session focused on establishing personal facts and preferences for future recall.",
  "importance": "standard",
  "expiry": "temporary",
  "tags": ["session"]
}
WHY: Episode summaries are already meta-narration. Extract only durable facts, preferences, and rules the summary affirms as knowledge.`;

const EMPTY_EXAMPLE = `If nothing qualifies, return exactly:
{"durables":[]}`;

/**
 * Builds the system prompt for dreaming extract over episode summaries.
 *
 * @param options - Optional clock override for recency guidance.
 * @returns System prompt text for the dreaming extract LLM.
 */
export function buildDreamExtractSystemPrompt(options: { currentDate?: string } = {}): string {
  const dateString = options.currentDate ?? new Date().toISOString().slice(0, 10);

  return [
    "You are a selective memory synthesis engine for dreaming maintenance.",
    "",
    `Current date: ${dateString}.`,
    "",
    "Input is a condensed episode summary, not a raw transcript. The summary already collapsed tool chatter,",
    "debugging steps, and session narration. Extract only durable knowledge the summary still affirms as",
    "long-term memory.",
    "",
    "Default action: SKIP. Most episode summaries should produce zero entries.",
    "",
    "## Types",
    "",
    "- fact: Verified descriptive information about a person, project, system, or concept.",
    "- decision: A standing rule, requirement, convention, or durable constraint on future behavior.",
    "- preference: A stated preference, opinion, or value that should influence future behavior.",
    "- lesson: A non-obvious insight from a specific experience, not generic advice.",
    "- milestone: A significant one-time transition, launch, or life/project moment.",
    "- relationship: A connection between named entities or people.",
    "- directive: A memory-behavior instruction about what to suppress or proactively surface.",
    "",
    "## Claim Keys",
    "",
    "- Include `claim_key` on every non-directive entry unless the summary gives no stable entity anchor.",
    "- Use canonical `entity/attribute` form: lowercase snake_case segments separated by `/`.",
    "- Prefer person- or project-scoped entities when the summary names them (`jim/timezone`, `agenr/package_manager`).",
    "- For directive entries, use `user/memory_directive/<name>`.",
    "- If the summary quotes an explicit tool-call claim key, preserve that raw value in `claim_key`.",
    "- Do not emit malformed keys with spaces, mixed casing, or more than four segments.",
    "",
    "## Provenance",
    "",
    "- Every entry must include `source_context`: one sentence, max 20 words, describing what evidence in the summary supports the durable.",
    "",
    "## Project Scope",
    "",
    "- `project` tags knowledge *about* a workspace or product, not the workspace where the chat happened.",
    "- Omit `project` for personal, family, health, preference, and other facts that should follow the user across workspaces.",
    "- Include `project` only when the durable is specifically about one repo, codebase, deployment, or product surface.",
    "- A session may include a workspace hint for context. Treat it as a hint, not a default stamp for every entry.",
    '- Claim keys like `agenr/release_policy` may justify `project: "agenr"`; claim keys like `jim/birthday` should stay unscoped.',
    "",
    "## Importance And Expiry",
    "",
    '- Rate importance as "high", "standard", or "low". Standard is the default.',
    '- Use expiry "permanent" for biographical facts, preferences, and standing rules.',
    '- Use expiry "temporary" for active project state and time-bounded context.',
    '- Extraction assigns "core" only for directive entries.',
    "",
    "## Directive Fields",
    "",
    "- Directive entries require `claim_key`, `directive_polarity`, and usually `directive_trigger`.",
    "",
    "## Existing Claim-Key Context",
    "",
    "- The user prompt may list active corpus durables with existing `claim_key` values.",
    "- Treat those rows as a bounded claim-key map for this episode, not as transcript evidence.",
    "- If the summary is already covered by an existing row, omit it instead of paraphrasing it.",
    "- If the summary adds a genuine update to an existing slot, reuse the exact listed `claim_key`.",
    "- Prefer `refines`-style updates through exact key reuse over minting sibling keys for the same slot.",
    "",
    "## Already Stored In Session",
    "",
    "- The user prompt may list durables already written live through `agenr_store` during this session.",
    "- Do not emit another entry for the same underlying knowledge, even when the episode summary paraphrases it.",
    "- Omit covered facts entirely instead of restating them with a new subject, claim key, or wording.",
    "- When a genuinely new fact remains, emit only that new fact.",
    "- If you must reference an already-stored claim key family, reuse the exact existing `claim_key` rather than inventing a synonym.",
    "",
    "## Anti-Patterns",
    "",
    "- Session summaries, progress narration, or duplicate paraphrases of the same fact.",
    "- Generic advice that could appear in any tutorial.",
    "- Facts the summary only mentions as recalled context without independent affirmation.",
    "",
    "## Calibration",
    "",
    "- Typical good output per episode summary: 0-4 entries.",
    "- Hard maximum: 6 entries. Reaching the cap usually means over-extraction.",
    "- One grounded entry beats three near-duplicates.",
    "",
    "## Output",
    "",
    'Return JSON only: {"durables":[...]}',
    'Use {"durables":[]} when nothing qualifies.',
    "",
    "Each entry must have:",
    '{ "type": "fact|decision|preference|lesson|relationship|milestone|directive", "subject": "2-6 word topic noun phrase", "content": "specific declarative statement, min 20 chars", "importance": "high|standard|low", "expiry": "permanent|temporary|core", "tags": ["1-4", "lowercase", "tags"], "source_context": "one sentence, max 20 words", "claim_key": "entity/attribute" }',
    'Optional: { "project": "workspace-name" } only when the durable is workspace-specific knowledge.',
    "Directive entries also require `directive_polarity` and `directive_trigger` when applicable.",
    "",
    "GOOD:",
    GOOD_EPISODE_EXAMPLE,
    "",
    BAD_EPISODE_PROJECT_SCOPE,
    "",
    BAD_EPISODE_META,
    "",
    EMPTY_EXAMPLE,
  ].join("\n");
}

/**
 * Builds the user prompt for one episode-summary extraction call.
 *
 * @param chunk - Single-message transcript chunk containing the episode summary.
 * @param options - Optional session workspace hint for scope decisions.
 * @returns User message content for the dreaming extract LLM.
 */
export function buildDreamExtractChunkPrompt(
  chunk: TranscriptChunk,
  options: {
    sessionWorkspace?: string | null;
    existingSessionDurables?: DreamSessionStoreDurable[];
    existingClaimKeyContext?: DreamClaimKeyContextDurable[];
  } = {},
): string {
  const sections = ["Episode summary to mine for durable knowledge:"];

  const sessionWorkspace = options.sessionWorkspace?.trim();
  if (sessionWorkspace) {
    sections.push(
      "",
      `Session workspace context: ${sessionWorkspace}`,
      "This names where the conversation happened. Do not default every durable to this project.",
      "Tag `project` only when the knowledge itself is about that workspace.",
    );
  }

  if (options.existingSessionDurables && options.existingSessionDurables.length > 0) {
    sections.push(
      "",
      "Already stored live during this session (do not duplicate or paraphrase):",
      ...options.existingSessionDurables.map(
        (durable) => `- [${durable.type}] ${durable.subject}: ${durable.content}${durable.claimKey ? ` (claim_key: ${durable.claimKey})` : ""}`,
      ),
      "",
      "Emit only durable knowledge from the summary that is not already covered above.",
    );
  }

  if (options.existingClaimKeyContext && options.existingClaimKeyContext.length > 0) {
    sections.push(
      "",
      "Existing active claim-key context (reuse exact keys or skip covered facts):",
      ...options.existingClaimKeyContext.map(
        (durable) =>
          `- [${durable.type}] ${durable.subject}: ${truncatePromptLine(durable.content, 180)} (claim_key: ${durable.claimKey}${durable.project ? `, project: ${durable.project}` : ""})`,
      ),
      "",
      "Do not invent a nearby claim key when one of these keys already names the durable slot.",
    );
  }

  sections.push("---", chunk.text, "---", "", "Return JSON only. No markdown fences, no commentary, and no extra keys.");

  return sections.join("\n");
}

/** Keeps prompt context rows bounded even when existing durable content is long. */
function truncatePromptLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
