/**
 * Minimum cleaned-message count required for episode generation.
 */
const MIN_EPISODE_MESSAGES = 4;

/**
 * Maximum transcript size retained for one episode-generation prompt.
 */
const MAX_EPISODE_TRANSCRIPT_CHARS = 14_000;

export { MAX_EPISODE_TRANSCRIPT_CHARS, MIN_EPISODE_MESSAGES };

/**
 * Renders cleaned transcript messages into prompt text for episode generation.
 *
 * @param messages - Cleaned transcript messages.
 * @returns Transcript text with stable role prefixes.
 */
export function renderTranscript(messages: Array<{ role: "user" | "assistant"; text: string }>): string {
  return messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text.trim()}`).join("\n");
}

/**
 * Caps transcript text while preserving both the beginning and the end.
 *
 * @param transcript - Full rendered transcript.
 * @param maxChars - Maximum transcript length to keep.
 * @returns Capped transcript text.
 */
export function capEpisodeTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) {
    return transcript;
  }

  const omissionMarker = "\n\n[Earlier middle transcript omitted for brevity]\n\n";
  const headBudget = Math.max(0, Math.floor((maxChars - omissionMarker.length) * 0.35));
  const tailBudget = Math.max(0, maxChars - omissionMarker.length - headBudget);
  const head = trimToBoundary(transcript.slice(0, headBudget), false);
  const tail = trimToBoundary(transcript.slice(-tailBudget), true);
  return `${head}${omissionMarker}${tail}`.trim();
}

/**
 * Trims transcript slices at whitespace boundaries for cleaner prompt text.
 *
 * @param value - Transcript slice.
 * @param fromStart - Whether the slice is taken from the tail.
 * @returns Boundary-trimmed transcript text.
 */
function trimToBoundary(value: string, fromStart: boolean): string {
  if (value.length === 0) {
    return value;
  }

  if (fromStart) {
    const boundary = value.search(/\s/u);
    return boundary >= 0 ? value.slice(boundary).trimStart() : value.trim();
  }

  const reversedBoundary = value.trimEnd().search(/\s\S*$/u);
  return reversedBoundary >= 0 ? value.slice(0, reversedBoundary).trimEnd() : value.trim();
}
