export interface ToolCallContext {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ToolSummaryOptions {
  overrides?: Readonly<Record<string, (call: ToolCallContext) => string | undefined>>;
}

export interface ToolResultPolicy {
  dropToolNames?: ReadonlySet<string>;
  keepToolNames?: ReadonlySet<string>;
}

export const DEFAULT_TOOL_RESULT_DROP_NAMES = [
  "read",
  "web_fetch",
  "browser",
  "screenshot",
  "snapshot",
  "canvas",
  "tts",
] as const;

export const DEFAULT_TOOL_RESULT_KEEP_NAMES = ["web_search", "memory_search", "memory_get", "image"] as const;

const DEFAULT_TOOL_RESULT_DROP_NAME_SET = new Set<string>(DEFAULT_TOOL_RESULT_DROP_NAMES);
const DEFAULT_TOOL_RESULT_KEEP_NAME_SET = new Set<string>(DEFAULT_TOOL_RESULT_KEEP_NAMES);

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncateInline(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return value.slice(0, max);
}

function firstStringArgValue(args: Record<string, unknown>, max: number): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return truncateInline(value.trim(), max);
    }
  }

  return undefined;
}

function toolIdentifier(toolName: string, args: Record<string, unknown>): string {
  const normalizedToolName = toolName.trim().toLowerCase();

  if (normalizedToolName === "read" || normalizedToolName === "edit" || normalizedToolName === "write") {
    return getString(args.file_path) ?? getString(args.path) ?? getString(args.file) ?? "(unknown file)";
  }

  if (normalizedToolName === "exec") {
    const command = getString(args.command) ?? getString(args.cmd) ?? "(unknown command)";
    return truncateInline(command, 100);
  }

  if (normalizedToolName === "web_fetch") {
    return getString(args.url) ?? "(unknown url)";
  }

  if (normalizedToolName === "web_search") {
    return getString(args.query) ?? "(unknown query)";
  }

  if (normalizedToolName === "browser") {
    const action = getString(args.action) ?? "(unknown action)";
    const targetUrl = getString(args.targetUrl) ?? getString(args.url);
    return targetUrl ? `${action} ${targetUrl}` : action;
  }

  if (normalizedToolName === "agenr_store") {
    const entries = Array.isArray(args.entries) ? args.entries : [];
    return `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
  }

  if (normalizedToolName === "agenr_recall") {
    const query = getString(args.query) ?? "(no query)";
    return `"${truncateInline(query, 80)}"`;
  }

  if (normalizedToolName === "message") {
    const action = getString(args.action) ?? "(unknown action)";
    const target = getString(args.target) ?? getString(args.to) ?? "(unknown target)";
    return `${truncateInline(action, 80)} to ${truncateInline(target, 80)}`;
  }

  if (normalizedToolName === "sessions_spawn") {
    return getString(args.label) ?? getString(args.task)?.slice(0, 60) ?? "(unknown task)";
  }

  if (normalizedToolName === "image") {
    return getString(args.image) ?? getString(args.url) ?? getString(args.path) ?? "(unknown image)";
  }

  if (normalizedToolName === "canvas") {
    return getString(args.action) ?? "(unknown action)";
  }

  if (normalizedToolName === "tts") {
    const text = getString(args.text) ?? "(unknown text)";
    return truncateInline(text, 50);
  }

  return firstStringArgValue(args, 80) ?? "(unknown)";
}

export function extractToolCallBlocks(content: unknown): ToolCallContext[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCallContext[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    const name = getString(record.name) ?? getString(record.tool) ?? getString(record.tool_name);
    const args = asRecord(record.arguments) ?? asRecord(record.args) ?? asRecord(record.input) ?? {};
    const id =
      getString(record.id) ??
      getString(record.toolCallId) ??
      getString(record.tool_call_id) ??
      getString(record.call_id);

    if ((type === "toolcall" || type === "tool_call" || type === "tool_use" || type === "tooluse") && name) {
      toolCalls.push({ name, args, id });
      continue;
    }

    if (!type && name && ("arguments" in record || "args" in record || "input" in record)) {
      toolCalls.push({ name, args, id });
    }
  }

  return toolCalls;
}

export function summarizeToolCall(call: ToolCallContext, options?: ToolSummaryOptions): string {
  const normalizedToolName = call.name.trim().toLowerCase();
  const override = options?.overrides?.[normalizedToolName];
  if (override) {
    const summary = override(call);
    if (summary) {
      return summary;
    }
  }

  const args = call.args;
  const filePath = getString(args.file_path) ?? getString(args.path) ?? getString(args.file);

  if (normalizedToolName === "read") {
    return `[called Read: ${filePath ?? "(unknown file)"}]`;
  }

  if (normalizedToolName === "write") {
    const content = getString(args.content) ?? getString(args.text) ?? "";
    return `[called Write: ${filePath ?? "(unknown file)"} - ${content.length} chars]`;
  }

  if (normalizedToolName === "edit") {
    const oldText = getString(args.oldText) ?? getString(args.old_string) ?? "";
    return `[called Edit: ${filePath ?? "(unknown file)"} - replaced ${oldText.length} chars]`;
  }

  if (normalizedToolName === "exec") {
    const command = getString(args.command) ?? getString(args.cmd) ?? "(unknown command)";
    return `[called exec: ${truncateInline(command, 200)}]`;
  }

  if (normalizedToolName === "web_search") {
    const query = getString(args.query) ?? "(unknown query)";
    return `[called web_search: ${truncateInline(query, 200)}]`;
  }

  if (normalizedToolName === "web_fetch") {
    const url = getString(args.url) ?? "(unknown url)";
    return `[called web_fetch: ${truncateInline(url, 200)}]`;
  }

  if (normalizedToolName === "browser") {
    const action = getString(args.action) ?? "(unknown action)";
    return `[called browser: ${truncateInline(action, 200)}]`;
  }

  if (normalizedToolName === "message") {
    const action = getString(args.action) ?? "(unknown action)";
    const target = getString(args.target) ?? getString(args.to) ?? "(unknown target)";
    return `[called message: ${truncateInline(action, 200)} to ${truncateInline(target, 200)}]`;
  }

  if (normalizedToolName === "agenr_store") {
    const entries = Array.isArray(args.entries) ? args.entries : [];
    if (entries.length === 0) {
      return "[attempted brain store: (empty)]";
    }

    const summaries = entries
      .slice(0, 3)
      .map((entry) => {
        const record = asRecord(entry);
        if (!record) {
          return null;
        }

        const type = getString(record.type) ?? "unknown";
        const subject = getString(record.subject) ?? "(no subject)";
        return `${type}: "${truncateInline(subject, 60)}"`;
      })
      .filter((summary): summary is string => summary !== null);
    const countSuffix = entries.length > 3 ? ` (+${entries.length - 3} more)` : "";

    return `[attempted brain store: ${summaries.join(", ")}${countSuffix}]`;
  }

  if (normalizedToolName === "agenr_recall") {
    const query = getString(args.query) ?? "(no query)";
    return `[recalled from brain: "${truncateInline(query, 100)}"]`;
  }

  if (normalizedToolName === "sessions_spawn") {
    const label = getString(args.label);
    const mode = getString(args.mode) ?? "run";
    const model = getString(args.model);
    const modelSuffix = model ? ` model=${model}` : "";
    if (label) {
      return `[spawned sub-agent: ${label} (${mode}${modelSuffix})]`;
    }

    const task = getString(args.task) ?? "(no task)";
    return `[spawned sub-agent: ${truncateInline(task, 80)} (${mode}${modelSuffix})]`;
  }

  const relevantArgValue =
    firstStringArgValue(
      Object.fromEntries(
        Object.entries(args).filter(
          ([key]) =>
            !["buffer", "content", "data", "newText", "new_string", "oldText", "old_string"].includes(key) &&
            !(normalizedToolName === "write" && key === "text"),
        ),
      ),
      80,
    ) ?? "(no args)";

  return `[called ${call.name}: ${relevantArgValue}]`;
}

export function toolResultPlaceholder(toolName: string, args: Record<string, unknown>): string {
  const normalizedToolName = toolName.trim().length > 0 ? toolName.trim() : "unknown";
  const identifier = toolIdentifier(normalizedToolName, args);
  return `[tool result from ${normalizedToolName}: ${identifier} - filtered]`;
}

export function shouldKeepToolResult(
  toolName: string | undefined,
  text: string,
  policy?: ToolResultPolicy,
): { keep: boolean; truncateTo?: number } {
  const normalizedToolName = (toolName ?? "").trim().toLowerCase();
  const dropToolNames = policy?.dropToolNames ?? DEFAULT_TOOL_RESULT_DROP_NAME_SET;
  const keepToolNames = policy?.keepToolNames ?? DEFAULT_TOOL_RESULT_KEEP_NAME_SET;

  if (normalizedToolName && dropToolNames.has(normalizedToolName)) {
    return { keep: false };
  }

  if (normalizedToolName && keepToolNames.has(normalizedToolName)) {
    return { keep: true, truncateTo: 2000 };
  }

  if (normalizedToolName === "exec") {
    if (text.length < 1000) {
      return { keep: true, truncateTo: 2000 };
    }

    if (/(error|failed|fail)/i.test(text)) {
      return { keep: true, truncateTo: 2000 };
    }

    return { keep: false };
  }

  if (text.length < 500) {
    return { keep: true, truncateTo: 2000 };
  }

  return { keep: false };
}
