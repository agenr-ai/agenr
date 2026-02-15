# agenr

**/eɪ.dʒɛn.ɚ/** (AY-GEN-ER) — local-first memory for AI agents.

You've had this conversation before. Your AI hasn't.

Every new session starts from zero — no memory of yesterday's decisions, last week's debugging session, or the architecture you spent an hour explaining. Most "memory" tools solve this by embedding text chunks and doing vector search. That's not memory. That's a search engine that doesn't forget.

Real memory strengthens when reinforced, fades when irrelevant, and resolves contradictions. agenr does that. It extracts *structured* knowledge — typed entries with confidence, scope, and expiry — not raw text blobs. Entries that get recalled often grow stronger. Stale entries decay. Contradicted entries get penalized. And consolidation actually *cleans* the database over time, merging near-duplicates and expiring what's no longer relevant. The result is a knowledge base that gets healthier with use, not just bigger.

One local database, shared across every tool that speaks MCP. Your memory stays on your machine.

## What it does

```bash
# Extract knowledge from a conversation transcript
agenr extract session.jsonl --json | agenr store

# Later — in any tool, any session
agenr recall "what package manager did we choose?"
```

```
┌─ fact (0.94) ────────────────────────────────┐
│ Subject: project tooling                      │
│ We switched this project to pnpm.             │
│ Confirmed 3x · Last recalled 2 days ago       │
└───────────────────────────────────────────────┘
```

One local database. Works with Claude Code, Codex, Cursor, or anything that speaks MCP.

## Quick start

```bash
git clone https://github.com/agenr-ai/agenr.git
cd agenr && pnpm install && pnpm build

# Interactive setup — picks your LLM provider and auth method
pnpm exec agenr setup

# Try it on a real transcript (or any text file)
pnpm exec agenr extract your-transcript.txt --json | pnpm exec agenr store
pnpm exec agenr recall "what did we decide about X?" --limit 5
```

> **Note:** agenr is not yet published to npm. Clone the repo for now.

> **Important:** Embeddings always use OpenAI's API (`text-embedding-3-small`), regardless of which LLM provider you choose for extraction. You'll need an `OPENAI_API_KEY` even if you use Anthropic for everything else. Run `agenr setup` and it'll walk you through it.

## How it works

**Extract** — Feed any transcript or text file to an LLM. Out come structured entries: facts, decisions, preferences, todos, relationships, events, lessons.

**Store** — Entries get embedded and compared against what's already in the database. Near-duplicates reinforce existing knowledge instead of piling up. New information gets inserted.

**Recall** — Semantic search plus memory-aware ranking. Entries you recall often score higher. Stale entries decay. Contradicted entries get penalized. It's not just vector search — it's search that understands usage patterns.

**Consolidate** — Over time, near-duplicates accumulate and temporary entries go stale. Consolidation cleans house: rule-based expiry and dedup first, then optional LLM-assisted merging for entries that say the same thing differently. Every merge gets verified before it touches the database.

```text
Extract → Store → Recall → Consolidate
  LLM      dedup    semantic    cleanup
  ↓        + embed  + memory    + merge
entries    → DB     → ranked    → healthier DB
```

## Cross-tool memory via MCP

The point of agenr is that your tools share one brain. Debug a production issue in Claude Code on Monday, and Codex already knows what you found on Wednesday.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.agenr]
command = "node"
args = ["/path/to/agenr/dist/cli.js", "mcp"]
env = { OPENAI_API_KEY = "your-key-here" }
```

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "agenr": {
      "command": "node",
      "args": ["/path/to/agenr/dist/cli.js", "mcp"],
      "env": { "OPENAI_API_KEY": "your-key-here" }
    }
  }
}
```

### Teaching your AI to use agenr

Add this to your coding agent's instructions (e.g., `AGENTS.md` or system prompt):

```markdown
## Memory (agenr)

You have access to persistent memory via the agenr MCP server.

- On session start: call `agenr_recall` with context "session-start" to load relevant memories
- During work: recall specific topics as needed
- When you learn something important: store it with `agenr_store`
- Types: fact, decision, preference, todo, relationship, event, lesson
```

Three MCP tools: `agenr_recall`, `agenr_store`, `agenr_extract`. See [docs/MCP.md](./docs/MCP.md) for the full reference.

## Commands

| Command | Description |
| --- | --- |
| `agenr setup` | Interactive auth/provider/model configuration |
| `agenr extract <files...>` | Extract structured knowledge from text |
| `agenr store [files...]` | Store entries with semantic dedup |
| `agenr recall [query]` | Semantic + memory-aware recall |
| `agenr watch <file>` | Live-watch a growing transcript |
| `agenr ingest <paths...>` | Bulk-ingest files and directories |
| `agenr consolidate` | Rule-based + LLM-assisted knowledge cleanup |
| `agenr mcp` | Start MCP server (stdio) |
| `agenr db stats` | Database statistics |
| `agenr auth status` | Check auth connectivity |

Full flag reference: [docs/CLI.md](./docs/CLI.md)

## Architecture

- **Runtime:** Node.js 20+, TypeScript, ESM
- **Storage:** libsql/SQLite (`~/.agenr/knowledge.db`)
- **Embeddings:** OpenAI `text-embedding-3-small`, 512 dimensions
- **Recall scoring:** Vector similarity × recency × confidence × recall strength, with contradiction penalties and full-text boosting
- **Consolidation:** Two-tier — deterministic rules for cheap cleanup, LLM-assisted clustering for semantic merges, verification before every commit

Deep dive: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) · [docs/CONSOLIDATION.md](./docs/CONSOLIDATION.md)

## Status

agenr is alpha software under active development. The core pipeline (extract → store → recall → consolidate) is stable and tested (222+ tests). We use it daily to manage ~3,000 knowledge entries across multiple AI tools.

What works well: extraction, storage, recall, MCP integration, rules-based consolidation, LLM-assisted merging.

What's next: entity resolution, auto-scheduled consolidation, local embeddings support. See the [kanban board](https://github.com/agenr-ai/agenr/issues) for current priorities.

## Philosophy

The big labs are building bigger brains. We're building better memory. Those are complementary.

Current AI's bottleneck isn't intelligence — it's continuity. A slightly less brilliant model with accumulated context might be more useful than a brilliant amnesiac. What makes a senior engineer senior isn't raw IQ — it's patterns seen, mistakes remembered, approaches that worked. That's memory.

agenr is local-first because your memory is yours. It's structured (not just vectors) because "what did we decide about X?" needs a real answer, not a similarity score. It's open source because memory infrastructure should be shared.

We're not claiming to have solved AI memory. We're sharing an approach that works for us and seeing if it works for others too.

## License

AGPL-3.0 — [LICENSE](./LICENSE) · [LICENSE-FAQ](./LICENSE-FAQ.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
