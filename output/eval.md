# Eval report — vercel/commerce (PR #1527)

Run at: 2026-08-15T18:12:48.482Z

## Tier 1 — deterministic invariants

| check | value | status |
|---|---|---|
| requirements | 4 | — |
| covered by UI | 3 | — |
| absence gaps | 1 | — |
| covered + gaps == reqs | 4 == 4 | PASS |
| dangling cross-layer edges | 0/0/0 | PASS |

## Tier 2 — narrative stability (3 runs, pairwise Jaccard)

| summary | 45% |
| whatToTest | 65% |
| riskAreas | 46% |

## Hallucination guard

Suspicious mentions: (`app/product/[handle]/page.tsx`),, Graph, T-Shirt, Pre-existing

> The blast-radius *sets* (screens, flows, requirements at risk) are produced deterministically from the graph and are bit-identical across runs; only the prose drifts.