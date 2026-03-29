import type { AgentToolResult } from "@mariozechner/pi-agent-core";

/**
 * Creates a standard pi-agent-core tool result with a text rendering.
 *
 * @param details - Structured tool payload for logs and downstream consumers.
 * @param text - Optional explicit text content. Defaults to pretty JSON details.
 * @returns Tool result with both human-readable text and structured details.
 */
export function toolResult<T>(details: T, text?: string): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(details, null, 2) }],
    details,
  };
}
