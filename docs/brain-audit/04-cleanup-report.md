# Brain Cleanup Report — 2026-02-15

## Backup
`~/.agenr/knowledge.db.pre-cleanup-20260215-221923`

## Before/After
| Metric | Before | After |
|--------|--------|-------|
| Active entries | 11,354 | 9,493 |
| Total pruned | **1,861** | — |

## Pruned by Category

| Category | Count |
|----------|-------|
| 1. Actor-name subjects (user, assistant, EJA, Jim, etc.) | 358 |
| 2. "The assistant …" meta-narration content | 590 |
| 3. Duplicate subject+type groups (>3, kept newest) | 585 |
| 4. Code-artifact subjects (src/*, *.ts*, *.js*) | 328 |

## Post-Cleanup
- Vector index rebuilt: 12,414 entries indexed (includes superseded for embedding coverage)
- DB stats show 9,493 active entries across 7 types
- Top type: fact (5,022), top tag: agenr (901)

## Issues
None encountered. All operations completed cleanly.
