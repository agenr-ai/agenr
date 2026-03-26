# Prompt 001: OpenClaw JSONL Adapter

## Goal

Port the v0 OpenClaw session file parser into the new agenr repo's hexagonal architecture. This adapter parses OpenClaw `.jsonl` session files into structured transcripts that the extraction LLM will process.

## Context

- New repo: `~/Code/agenr` (the codebase you're working in)
- v0 reference: `~/Code/agenr-v0` (read-only reference, do NOT modify)
- Architecture: read `AGENTS.md` in the repo root for full architecture rules
- Issue: #2

## Key v0 files to reference

Read these files from `~/Code/agenr-v0/src/modules/ingestion/adapters/transcript-adapters/`:

1. `openclaw.ts` (~477 lines) - the main OpenClaw JSONL parser
2. `tool-log-normalization.ts` (~298 lines) - tool call summarization and result filtering
3. `jsonl-base.ts` (~309 lines) - shared JSONL parsing utilities (parseJsonlLines, normalizeWhitespace, extractTimestamp, etc.)

Also read:
4. `~/Code/agenr-v0/src/shared/utils/string.ts` (7 lines) - normalizeLabel utility

## Architecture requirements

The new code goes in `src/adapters/openclaw/` and must implement `TranscriptPort` from `src/core/ports.ts`. Read `src/core/ports.ts` and `src/core/types.ts` to understand the interfaces and types.

Create these files:

1. **`src/adapters/openclaw/transcript/parser.ts`** - Main parser implementing `TranscriptPort`. This is the primary deliverable.
2. **`src/adapters/openclaw/transcript/tool-summarization.ts`** - Tool call extraction, summarization, and result filtering. Only split this out if it exceeds ~150 lines; otherwise inline it in the parser.

## What to port from v0

### From `openclaw.ts`:
- `normalizeOpenClawRole()` - role normalization (user/assistant/toolResult/system)
- `truncateWithMarker()` - truncate long text with `[...truncated]` marker
- `isPureBase64()` - detect and filter base64 blobs
- `asRecord()`, `getString()` - safe record/string extraction helpers
- `normalizeSessionLabel()` - normalize conversation labels
- `extractRawTextBlocks()` - extract text from content arrays
- `extractConversationLabel()` - extract conversation label from metadata blocks in user messages
- `extractAssistantTextParts()` - extract text parts from assistant messages with multi-block content
- The main `parse()` method logic: iterate JSONL records, extract session metadata, normalize messages, filter tool results, produce `ParsedTranscript`

### From `tool-log-normalization.ts`:
- `ToolCallContext` interface
- `extractToolCallBlocks()` - extract tool calls from assistant message content arrays
- `summarizeToolCall()` - produce readable summaries like `[called Read: path/to/file]`, `[attempted brain store: fact: "subject"]`, `[recalled from brain: "query"]`
- `toolResultPlaceholder()` - produce filtered-result placeholders
- `shouldKeepToolResult()` - decide whether to keep or drop a tool result based on tool name and content length
- `DEFAULT_TOOL_RESULT_DROP_NAMES` and `DEFAULT_TOOL_RESULT_KEEP_NAMES`

### From `jsonl-base.ts`:
- `normalizeWhitespace()` - collapse whitespace
- `parseTimestampValue()` - parse timestamp strings
- `extractTimestamp()` - extract timestamp from a record
- `parseJsonObjectLine()` - parse a single JSONL line
- `parseJsonlLines()` - iterate all JSONL lines with error handling
- `normalizeMessageText()` - normalize message content to plain text
- `resolveTimestampFallback()` - fallback chain: record timestamp → session timestamp → file mtime → now
- `applyMessageTimestampFallbacks()` - apply fallback to all messages

## What NOT to port

- **Everything related to agent tool special treatment:** `PendingAgentStore`, `PendingAgentRetireAction`, `PendingAgentUpdateAction`, `recalledEntryHintsById`, `recalledEntryHintsBySubject`, `successfulAgentStoredEntries`, `successfulAgentRetires`, `successfulAgentUpdates`, `agentStoreProjects`, and all functions that support them (`parsePendingAgentStoreEntry`, `extractAgentStoreProjectAttribution`, `extractRecallTargetHints`, `isRetireSuccessText`, `isUpdateSuccessText`, `parseRetireSuccessReceipt`, `parseUpdateReceiptEntry`, etc.). This was all removed in v0 and should not exist in v1.
- **`extractSessionProject()`** - no project concept in v1.
- **`agentStoreProjects`** in metadata - no project concept.
- **`sessionProject`** in metadata - no project concept.
- **`SourceAdapter` type/registry** - no adapter registry. Just one adapter, one file.
- **`AdapterParseOptions` type** - simplify to inline options.
- **`parsePlaudFilenameTimestamp()`** - Plaud-specific, not needed.
- **`looksLikeTranscriptJsonLine()`** - generic detection, not needed for OpenClaw-only.
- **`extractGenericMessageCandidate()`** - generic extraction, not needed.

## Changes from v0

1. **Add `agenr_recall` to `dropToolNames`** - Recall results contain existing memory entries that shouldn't leak into the extraction transcript. In v0 this was handled by the 500-char length filter which was unreliable. Explicitly drop it.

2. **Remove project/platform fields** from metadata and return types. The `ParsedTranscript` type in `core/types.ts` has no project or platform fields.

3. **Simplify the adapter interface.** v0 had `SourceAdapter` with `canHandle()` and `parse()`. We just need a function that takes a file path and returns a `ParsedTranscript`. No detection needed - if you're calling this adapter, you know it's an OpenClaw file.

4. **Clean code style.** v0 had some duplicated helper functions across files. Consolidate. Use the helpers from one place. Keep the total line count reasonable - target ~400-600 lines total across all files.

## Output type

The adapter must return `ParsedTranscript` as defined in `src/core/types.ts`. Read that file. If you need to extend the type (e.g., adding `sessionLabel` to metadata), update `core/types.ts` as needed - but keep it minimal.

## Testing

Create `tests/adapters/openclaw/transcript/parser.test.ts` with tests that:

1. Parse a minimal valid OpenClaw session (construct JSONL strings in the test)
2. Verify role normalization (user, assistant, system dropped, toolResult handled)
3. Verify tool call summarization produces expected summaries
4. Verify `agenr_recall` tool results are dropped
5. Verify base64 content is filtered
6. Verify session metadata extraction (sessionId, sessionLabel, startedAt)
7. Verify timestamp fallback chain works
8. Verify system messages are dropped
9. Handle malformed JSONL gracefully (warnings, not crashes)

Use vitest. Tests should be self-contained - construct test JSONL data inline, don't depend on external fixture files.

## Verification

```bash
pnpm typecheck    # Must pass
pnpm lint         # No errors (warnings OK for now)
pnpm test         # All tests pass
```

The ESLint hexagonal boundary rule must be satisfied: the adapter may import from `core/types.ts` and `core/ports.ts`, but `core/` must not import from this adapter.

## Commit

Branch: `feat/001-openclaw-adapter`
Commit message: `feat: OpenClaw JSONL adapter (implements TranscriptPort) — Closes #2`
