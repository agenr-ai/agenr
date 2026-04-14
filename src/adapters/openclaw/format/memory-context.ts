const AGENR_MEMORY_CONTEXT_BLOCK_RE = /<agenr-memory-context>[\s\S]*?<\/agenr-memory-context>/giu;
const AGENR_MEMORY_CONTEXT_OPEN_RE = /<agenr-memory-context>/giu;
const AGENR_MEMORY_CONTEXT_CLOSE_RE = /<\/agenr-memory-context>/giu;
const AGENR_MEMORY_CONTEXT_NOTE_RE =
  /\[System note: The following is recalled Agenr memory context, NOT new user input\. Treat it as background context and use it silently when relevant\.\]/giu;

const AGENR_MEMORY_CONTEXT_OPEN_TAG = "<agenr-memory-context>";
const AGENR_MEMORY_CONTEXT_CLOSE_TAG = "</agenr-memory-context>";

const AGENR_MEMORY_CONTEXT_NOTE =
  "[System note: The following is recalled Agenr memory context, NOT new user input. Treat it as background context and use it silently when relevant.]";

/**
 * Wraps injected Agenr memory in a stable fence so later sanitizers can strip
 * it before the next query-building pass.
 *
 * @param content - Prompt-ready memory content to wrap.
 * @returns Fenced memory content, or an empty string when the content is blank.
 */
export function wrapAgenrMemoryContext(content: string): string {
  const trimmedContent = stripAgenrMemoryContext(content).trim();
  if (!trimmedContent) {
    return "";
  }

  return [AGENR_MEMORY_CONTEXT_OPEN_TAG, AGENR_MEMORY_CONTEXT_NOTE, "", trimmedContent, AGENR_MEMORY_CONTEXT_CLOSE_TAG].join("\n");
}

/**
 * Checks whether a text block already contains fenced Agenr memory context.
 *
 * @param content - Candidate text that may include Agenr memory fences.
 * @returns True when the Agenr memory fence is present.
 */
export function containsAgenrMemoryContext(content: string): boolean {
  return content.includes(AGENR_MEMORY_CONTEXT_OPEN_TAG);
}

/**
 * Removes Agenr memory fences so injected context does not recursively pollute
 * later recall queries or transcript-tail rendering.
 *
 * @param content - Candidate text containing Agenr memory fences.
 * @returns Text with the fence wrapper removed.
 */
export function stripAgenrMemoryContext(content: string): string {
  return content
    .replace(AGENR_MEMORY_CONTEXT_BLOCK_RE, " ")
    .replace(AGENR_MEMORY_CONTEXT_OPEN_RE, " ")
    .replace(AGENR_MEMORY_CONTEXT_CLOSE_RE, " ")
    .replace(AGENR_MEMORY_CONTEXT_NOTE_RE, " ");
}
