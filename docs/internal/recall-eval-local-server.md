# Internal Recall Eval Local Server

This repo now includes one dev-only helper to host the existing internal recall eval seam locally for `agenr-evals`.

## Start it

```bash
pnpm internal:recall-eval-server
```

Defaults:

- host: `127.0.0.1`
- port: `4010`
- route: `POST /internal/evals/recall/run`

Optional overrides:

- `AGENR_INTERNAL_RECALL_EVAL_HOST`
- `AGENR_INTERNAL_RECALL_EVAL_PORT`

This helper is internal-only. It binds to loopback by default and returns `404` for any other path.

## Use it from agenr-evals

The committed `agenr-evals` smoke manifest already targets the default base URL:

```bash
cd /Users/jmartin/Code/agenr-evals
./bin/evals run --manifest agenr-recall-http --adapter agenr-recall-http
```

If you override the port or host in `agenr`, point `agenr-evals` at the new base URL:

```bash
cd /Users/jmartin/Code/agenr-evals
AGENR_EVALS_AGENR_BASE_URL=http://127.0.0.1:4010 ./bin/evals run --manifest agenr-recall-http --adapter agenr-recall-http
```
