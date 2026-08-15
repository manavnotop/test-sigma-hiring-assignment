# Eval report — vercel/commerce (PR #1527)

Run at: 2026-08-14T10:29:59.742Z

## Tier 1 — deterministic invariants

| check | value | status |
|---|---|---|
| requirements | 9 | — |
| covered by UI | 3 | — |
| absence gaps | 6 | — |
| covered + gaps == reqs | 9 == 9 | PASS |
| dangling cross-layer edges | 0/0/0 | PASS |

## Tier 2 — narrative stability (3 runs, pairwise Jaccard)

| summary | 59% |
| whatToTest | 40% |
| riskAreas | 27% |

## Hallucination guard

Suspicious mentions: `app/product/[handle]/page.tsx`., Graph, T-Shirt)., Metadata, Actual, Pre-existing, /product/acme-bomber-jacket,, /product/acme-cup,

> The blast-radius *sets* (screens, flows, requirements at risk) are produced deterministically from the graph and are bit-identical across runs; only the prose drifts.