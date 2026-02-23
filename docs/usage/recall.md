# Recall Usage

## Browse Mode

Use browse mode when you want a timeline view of stored memory by importance and date instead of semantic similarity.

- Enable with `--browse`
- Query text is optional and ignored in browse mode
- Browse mode uses a SQL-only path with zero OpenAI API calls

### CLI examples

Browse entries from the last day:

```bash
agenr recall --browse --since 1d
```

Browse entries inside a date window:

```bash
agenr recall --browse --since 14d --until 2026-02-09T00:00:00.000Z
```

Browse recent entries with default limits:

```bash
agenr recall --browse
```

### MCP example

Use `context="browse"` and an optional time filter:

```json
{
  "name": "agenr_recall",
  "arguments": {
    "context": "browse",
    "since": "1d",
    "limit": 20
  }
}
```

In browse mode, no query string is required and no embedding/API call is made.
