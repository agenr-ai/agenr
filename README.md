```text
 █████╗  ██████╗ ███████╗███╗   ██╗██████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║██╔══██╗
███████║██║  ███╗█████╗  ██╔██╗ ██║██████╔╝
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║██╔══██╗
██║  ██║╚██████╔╝███████╗██║ ╚████║██║  ██║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝
  AGENt memoRy
```

# agenr

**Local-first memory for AI agents.** One SQLite brain that survives restarts, tools, and sessions - shared across OpenClaw, Skeln, and the CLI.

Most runtimes forget what mattered yesterday. agenr keeps memory structured, searchable, and on your machine. Only model and embedding calls leave the box.

## Memory at a glance

agenr splits agent memory into layers. Each answers a different question.

| Layer          | Question                     | In short                                                                                                 |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Durable**    | What is true?                | Facts, decisions, preferences, lessons - distilled knowledge with claim-key lifecycle and hybrid recall. |
| **Episodic**   | What happened?               | Session-level narrative summaries for time-bounded questions like "what did we do last week?"            |
| **Working**    | What are we doing right now? | Transient task state - scratchpad, checkpoints, next actions - injected per turn, not durable truth.     |
| **Procedural** | How do I do this?            | Repo-authored YAML runbooks synced into the store for repeatable workflows.                              |
| **Dreaming**   | Is the corpus healthy?       | Background maintenance: scan, reconcile, and repair durable memory behind an explicit apply gate.        |

**Durable** and **episodic** live in the database. **Working** is session-scoped and fades when the task moves on. **Procedural** is authored in git and synced in. **Dreaming** keeps the long-term store coherent over time.

Deep dives:

- [Durable memory](./docs/DURABLES.md) - store pipeline, claim keys, supersession
- [Episodes](./docs/EPISODES.md) - session summaries and temporal recall
- [Working memory](./docs/OPENCLAW-PLUGIN.md#agenr_work) - `agenr_work`, checkpoints, transient context ([Skeln details](./docs/SKELN-PLUGIN.md))
- [Procedures](./docs/PROCEDURES.md) - authoring, sync, and recall routing
- [Dreaming](./docs/DREAMING.md) - tiers, scan/reconcile/apply, corpus health
- [Recall](./docs/RECALL.md) - hybrid search across memory layers

## Quick start

```bash
pnpm install -g agenr
agenr init
```

The wizard sets up auth, embeddings, your database (`~/.agenr/knowledge.db`), optional OpenClaw plugin install, and an initial transcript ingest pass. Run it again any time to reconfigure or ingest more sessions.

**Manual plugin install**

```bash
# OpenClaw
openclaw plugins install @agenr/openclaw-plugin
openclaw gateway restart

# Skeln - see docs/SKELN-PLUGIN.md for packaging and config
skeln extension add @agenr/skeln-plugin
```

**Try recall from the CLI**

```bash
agenr recall "what decisions did we make about the API?"
agenr ingest ~/.openclaw/agents/main/sessions/   # durable extraction
agenr ingest episodes --recent 30d               # episodic backfill
agenr dream status                               # corpus health
```

Full CLI reference: [AGENTS.md](./AGENTS.md#cli-surface).

## Host integrations

| Host     | Package                  | Agent tools                                                                |
| -------- | ------------------------ | -------------------------------------------------------------------------- |
| OpenClaw | `@agenr/openclaw-plugin` | `agenr_store`, `agenr_recall`, `agenr_fetch`, `agenr_update`, `agenr_work` |
| Skeln    | `@agenr/skeln-plugin`    | above + `get_goal`, `create_goal`, `update_goal`                           |

Both plugins share the same database and recall brain. Details: [OpenClaw plugin](./docs/OPENCLAW-PLUGIN.md), [Skeln plugin](./docs/SKELN-PLUGIN.md).

## Documentation

| Topic                           | Doc                                            |
| ------------------------------- | ---------------------------------------------- |
| Architecture and repo shape     | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Ingest pipelines                | [docs/INGEST.md](./docs/INGEST.md)             |
| Configuration and env overrides | `agenr setup` or `agenr init`                  |
| Contributing / development      | [AGENTS.md](./AGENTS.md)                       |
| Debugging                       | [docs/DEBUGGING.md](./docs/DEBUGGING.md)       |

Config lives at `~/.agenr/config.json` by default. Override with `AGENR_CONFIG_PATH`, `AGENR_CONFIG_DIR`, or `AGENR_DB_PATH`.

## Development

```bash
pnpm install
pnpm build
pnpm check    # format, lint, typecheck, test
```

Sandbox helpers and the full contributor workflow are in [AGENTS.md](./AGENTS.md).

## License

MIT
