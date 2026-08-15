# Blast-Radius Agent — Design Document (Part B)

**An agent that crawls a live application, ingests a product spec, builds a three-layer knowledge graph (Requirements / UI / Code) in Neo4j, and reasons about the blast radius of a real pull request.**

> Target: `demo.vercel.store` (live) + `vercel/commerce` (repo) + **PR #1527** ("Fix stored XSS in product JSON-LD", 1 file, +3/−1).
> Read this alongside the code. Where they disagree, the code wins and the doc is wrong.

---

## 0. System at a glance

One TypeScript process, five stages, three external systems:

- **Crawl** — a real agent loop on the **PI harness** (`@earendil-works/pi-agent-core` + `pi-ai`), driving **agent-browser** (Vercel's CDP-based CLI) as its only tool. No browser library of our own; no Playwright; no browser-use cloud.
- **Ingest** — GitHub README → structured requirements (deterministic split + one LLM call per section).
- **Code** — **tree-sitter** (TSX/TS/JS) over the repo tarball: components, functions, imports, JSX render edges, call edges, and deterministic route→file mapping for the Next.js App Router.
- **Graph** — **Neo4j 5 in Docker** (compose, no native install), three layers + first-class absence.
- **Reason** — PR diff + deterministic graph traversal + one LLM call → non-engineer-readable blast-radius report (`output/blast-radius-PR-1527.md`).

Models (OpenRouter): **DeepSeek V4 Flash** for all LLM work (cheap + reason roles are both configurable via env). Everything LLM-shaped is bounded, structured, and whitelisted. The full reasoning for the stack — pi over LangChain/LangGraph, agent-browser over browser-use, V4 Flash over its price tier — is in **Appendix C**.

The whole pipeline runs with `npm run all` (≈ 2–4 min) and degrades gracefully: **drop the LLM key and every stage still runs** — deterministic BFS crawl, heading-level requirements, AST-only graph, evidence-only report. Degradation is a feature we test for, not an accident.

---

## 5. Agent decomposition

### 5.1 The honest shape

There is exactly **one** genuine agent loop in the system — the crawler — and it is built on a real agent harness (pi), not a hand-rolled prompt chain. The other four stages are deterministic orchestration around *bounded, single-purpose* LLM calls. I will defend why that split is correct before describing each stage.

### 5.2 Stage boundaries

| # | Stage | Input → Output | Boundary |
|---|-------|----------------|----------|
| 1 | **Crawl** | `base URL` → `Screen[]`, `Transition[]`, screenshots, a11y snapshots | Ends when the agent calls `finish_crawl`, the frontier is exhausted, or budgets hit (`CRAWL_MAX_SCREENS`, `CRAWL_MAX_ACTIONS_PER_SCREEN`). |
| 2 | **Ingest** | README → `Requirement[]` (R1..Rn) | Ends when every markdown section is processed. |
| 3 | **Code** | repo tarball → `File`/`Symbol` nodes + import/render/call edges + route map | Ends when every source file is parsed. Zero LLM. |
| 4 | **Connect** | reqs + screens + files → cross-layer edges + `CoverageGap` | Ends when every requirement is linked or explicitly gapped. |
| 5 | **Reason** | PR + graph → blast-radius report | Ends when the report file is written. |

The boundaries are *persistence boundaries*, not function calls: each stage writes its artifact to `output/` (crawl manifest, requirements.json, code.json, Neo4j) and the next stage reads from disk/graph. You can re-run `reason` 100 times without touching the graph. That decoupling is what makes `eval` cheap and the system debuggable.

### 5.3 The one real agent: the crawler

The crawler is a **PI harness `Agent`** with six tools, all of which wrap `agent-browser`:

- `open_url` (same-origin enforced, visited-dedup enforced)
- `click_element` (per-URL action budget enforced)
- `fill_input` (+ optional submit — this is how the agent "searched")
- `go_back`
- `list_frontier` (the discovered-but-unvisited URLs)
- `finish_crawl` (terminates the loop)

The agent's *system prompt* describes the product and its goals ("explore breadth-first, exercise state-changing interactions: product clicks, cart, search, filters"). The committed full-budget run (default 25-screen budget) captured **25 screens in 24 transitions**: 12 product pages, 6 category pages, the search results (`?q=shirt`, via a real `fill_input + submit`), a sorted category variant (`?sort=price-asc` — a real interaction the README never mentions), plus about/FAQ/privacy pages.

> **Committed artifacts.** `output/` contains this full-budget run end-to-end (crawl manifest, code/requirements layers, graph-era report, eval). Regenerate everything with `npm run all`; the deterministic sections of the report are also regenerable offline from the committed JSON artifacts with `npm run report` (no Docker/LLM) — a reviewer can verify the deterministic sections without the pipeline.

**What the harness does deterministically around the agent** (this is the part I'd defend to a senior engineer):

- Every URL change triggers a **deterministic capture**: a11y-tree snapshot (`agent-browser snapshot -i -u`), raw DOM link extraction via `eval`, screenshot, element list, and a **transition record** `(fromUrl → toUrl, action, element)`.
- The **frontier** is built from real `href`s by code, never from the model's memory. The agent *chooses* from a list the code computed.
- Same-origin, dedup, per-screen action budgets, and screen-count budgets are enforced in tool execution, not prompt promises.
- If the agent ends with an unvisited frontier, a **deterministic BFS fallback** completes the crawl; with no LLM key at all, the fallback *is* the crawler.

So the line is: **the model decides what to click and what a screen is for; the code decides what a screen is, what links it has, and where you may go.** This is the same philosophy as the rest of the system ("the LLM proposes, Cypher and code dispose") and it's what makes the crawl reproducible enough to diff between runs.

### 5.4 The four bounded LLM calls

| Stage | LLM call | Constraint |
|-------|----------|------------|
| Crawl | (a) the agent loop itself; (b) screen labeling pass | (a) tools enforce budgets; (b) structured JSON, per-screen, parallelized, title fallback |
| Ingest | one call per markdown section → `{title, description, user_action, expected_outcome, priority}` | structured JSON, no requirement may name features absent from the text |
| Connect | one call → req→screens/files mappings **with per-link confidence** | names must match provided lists exactly; anything else is dropped (`write.ts` `connectLayers`) |
| Reason | one call → `{summary, whatToTest, riskAreas, notes}` | the deterministic blast-radius sets are given to it as facts to *explain*, not to decide |

Why this isn't "a chain of prompts dressed up as an agent": (1) the graph — the agent's memory — is almost entirely compiler-grade fact (tree-sitter + route conventions + crawl artifacts); (2) each LLM output is schema-constrained and whitelisted; (3) stages are independently re-runnable and degrade independently. The honest cost: there is **no global planner** — nothing reflects on whether stage 3 produced enough for stage 5. That is the right trade for the time budget, and a planner is the first thing I'd add only *after* the eval harness exists to justify it (§10).

### 5.5 Cost, prompt caching, and the token budget

**Where the money goes.** The agent loop is ~90% of LLM spend: every turn re-sends the *entire* transcript, and the crawl adds ~4k characters of accessibility snapshot per tool result. The one-shot stages (ingest, labels, mapping, narrative) are bounded, sub-1k-token calls — cheap by construction. So efficiency work concentrates on the loop, and it has three parts: **cache compatibility**, **tail compaction**, and **observability**.

**Prompt caching, and how it's wired.** Models are DeepSeek on OpenRouter, whose prompt caching is automatic: cached prefixes are billed at **0.1× input price**. Three levers make sure we actually hit:

1. **Stable prefix.** The system prompt is a static template and the tool-schema array is built once — nothing in the prefix varies between turns (no dates, no counters, no per-turn counts in the system block; dynamic values like budgets and `visited.size` only ever appear in tool *results*, after the cacheable prefix). pi-ai strips message `timestamp`s before the wire, so there's nothing sneaky left to invalidate the cache.
2. **`session_id` pinning.** OpenRouter's sticky routing keeps a conversation on the same upstream provider so its cache stays warm; without a `session_id` it derives the stickiness key by hashing the *first system + first non-system message*. The crawler now passes a stable `sessionId` (`crawl-<url-hash>`) per run, which pins routing explicitly — important because the initial user message contains the home-page snapshot, and we don't want that to be the thing the routing key silently depends on.
3. **Long retention.** `PI_CACHE_RETENTION=long` (also the code default in `src/llm.ts`) makes pi-ai send OpenRouter a `prompt_cache_key` on every request, covering the agent loop as well as the direct calls.

**Tail compaction (the deterministic seam).** The transcript grows by a snapshot per tool result, and every turn re-bills the whole tail at full input price. Fix: the agent's `transformContext` hook compacts **old** tool results to a ≤300-char one-liner while keeping the last two results intact (`src/crawl/context.ts`, pure + unit-tested). Refs are page-scoped — once the agent has left a page, its snapshot is only narrative, so truncation is lossless in the only direction that matters. Same philosophy as everywhere else: **the model decides where to click; the harness decides how much history it gets to re-read.**

**Observability.** Every LLM call (agent turns included, via the `message_end` event) records `input/output/cacheRead/cacheWrite/cost` by stage; each CLI run writes `output/cost.json` and prints a one-line summary with the cache-hit percentage. Without this, "prompt caching works" is a prayer; with it, we can show the 0.1× reads on the same run that produced the report — and the eval can assert caching is active rather than assumed.

What this does **not** do: it doesn't claim a cheaper model, and it doesn't hide the transcript (compaction is deterministic, not LLM-summarized — an LLM summarizer would be another cost *and* would corrupt the "what the agent actually saw" record). It's the cheap, honest 80%: fewer re-billed tokens, provable cache hits.

---

## 6. Graph schema with justification

One Neo4j database, per-repo subgraphs namespaced by `full_name`.

### 6.1 Node types

| Layer | Node | Key fields | Source |
|-------|------|-----------|--------|
| Req | `Requirement` | `key` (`owner/repo::req::R3`), `req_id`, `title`, `user_action`, `expected_outcome`, `priority` | ingest |
| UI | `Screen` | `key` (`owner/repo::screen::<sha1>`), `url`, `label`, `title`, `route` | crawl |
| Code | `Repo` | `full_name`, `ref` | — |
| Code | `File` | `key` (`owner/repo:path`), `path`, `language`, `loc` | tree-sitter |
| Code | `Symbol` | `key` (`owner/repo:path::name`), `name`, `kind` (function/component/class/method), `exported` | tree-sitter |
| **Absence** | `CoverageGap` | `key`, `reason` | computed |

### 6.2 Edge types

- Code: `CONTAINS` (Repo→File), `DEFINES` (File→Symbol), `IMPORTS` (File→File), `RENDERS` (Symbol→Symbol, from JSX usage), `CALLS` (Symbol→Symbol)
- UI: `HAS_SCREEN` (Repo→Screen), `NAVIGATES_TO` (Screen→Screen, from real transition records)
- **Cross-layer**: `RENDERED_BY` (Screen→File — **deterministic**, from the route map), `COVERED_BY` (Requirement→Screen, LLM-proposed, whitelisted, `confidence` property), `IMPLEMENTED_BY` (Requirement→File, same), `SPECIFIES` (Repo→Requirement)
- **Absence**: `MISSING_UI_COVERAGE` (Requirement→CoverageGap)

### 6.3 Why `RENDERED_BY` is deterministic (and why that matters)

The alternative is LLM-guessed screen→code links, and that's a single point of hallucination on the most important edge in the graph. Here, the Next.js App Router convention is a *fact*: `app/product/[handle]/page.tsx` renders `/product/[handle]`. Routes are parsed from file paths **once** into a `RouteMap` (`code/route-map.ts`, static-over-dynamic segment priority, built at `RouteMap.fromModel`); every stage — screens writer, offline traversal, report — resolves crawled URLs through that single map instead of re-walking file paths. The result: **every product page in the crawl is linked to the exact file PR #1527 touches — no LLM involved.** The LLM mapping is then only needed for requirement-level links, where semantic judgement is legitimate.

The same determinism applies to the component graph: `RENDERS` edges come from JSX element names resolved through real import edges (`components/product/product-description.tsx` is a *verified* target, not a guess).

### 6.4 How absence is modelled

Absence is modelled three ways at once, deliberately redundant:

1. **Boolean state on the requirement** (`covered_by_ui`, `implemented_in_code` — the latter two surfaced per-requirement at connect time). Queryable without traversal.
2. **First-class `CoverageGap` node** + `MISSING_UI_COVERAGE` edge. Absence is *visible* in the graph and carries a `reason`.
3. **Default-to-uncovered.** If the mapping LLM names nothing (or is absent), the requirement stays uncovered and gets a gap. **Presence must be proven; absence is the safe default.** A requirement is only "covered" if the model named a screen that actually exists in the crawl — hallucinated names die at the whitelist.

Why not "a requirement with no COVERED_BY edge"? Because missing data and proven-absent are indistinguishable in that model — "we never crawled" looks identical to "we crawled and it's not there". The gap node makes absence an *assertion*.

### 6.5 Justify against the queries the system actually runs

The blast-radius traversal (§8 of this doc, implemented in `graph/queries.ts`) starts from the changed file — the thing a PR gives you — and fans out:

```cypher
MATCH (repo:Repo {full_name:$repo})-[:CONTAINS]->(f:File)
WHERE f.path IN $changedPaths
OPTIONAL MATCH (f)-[:DEFINES]->(s:Symbol)
OPTIONAL MATCH (s)<-[:RENDERS|CALLS*1..6]-(s2:Symbol)<-[:DEFINES]-(f2:File)
-- then: (Screen)-[:RENDERED_BY]->(File) with affected files
-- then: (Requirement)-[:IMPLEMENTED_BY]->(File) / -[:COVERED_BY]->(Screen)
-- then: (Requirement)-[:MISSING_UI_COVERAGE]->(CoverageGap)
```

The second hop is the *incoming* closure: symbols that transitively **render or call** the changed symbols. Direction matters — a change to X risks the things that depend on X, not the things X depends on. An earlier iteration followed the outgoing edges (page → the components it renders) which flagged e.g. the footer as at risk for a product-page change and produced noise like "React Bricks at risk via footer.tsx". Reversing the direction is what makes a change to a shared component (product-card, product-description) reach every page that renders it, and a change to a route page reach its screens. Depth is capped at 6 so a leaf component doesn't flood the set with every page that transitively renders it.

Every hop is index-friendly on `key`/`path`. The `RENDERED_BY` direction (Screen→File) is chosen so the "screens that render a changed file" query starts at the change and fans out — the direction the product needs, not the schema's convenience. One traversal, five bounded queries, zero LLM.

A second query the report leans on is the absence list — the requirements that are *already* untestable before this PR:

```cypher
MATCH (r:Requirement)-[:MISSING_UI_COVERAGE]->(:CoverageGap)
RETURN r.req_id, r.title
```

For the full-pipeline run it returns R1, R3, R4, R5, R6, R7, R8, R9 — requirements describing developer-facing processes (environment setup, Vercel CLI workflows, the integration guide) with no UI to exercise them. That is the honest answer, not noise: **the requirements the spec documents but the product has no surface for.**

---

## 7. Confidence handling under ambiguity

### 7.1 What is actually built

- **Per-edge confidence on cross-layer links.** The mapping LLM returns `confidence ∈ [0,1]` per proposed link; it is stored on the edge. The report surfaces it as a band ("average 80% across N links") rather than a decimal. It's a small feature, but it's the difference between a link the system is sure about and a link it guessed.
- **Whitelsiting as the floor.** A link to a nonexistent screen/file cannot exist. The model cannot express confidence in a thing that isn't there. `eval` verifies this invariant on every run (`dangling edges: 0/0/0`).
- **Absence-as-default (§6.4).** Ambiguity resolves toward "uncovered", the safe direction for a risk-flagging tool.
- **Layer-presence honesty.** The report footer states which layers informed it (`✅ Requirements · ✅ DOM/UI (25 screens crawled) · ✅ Code + graph (tree-sitter)`). When a layer is missing, the report says so — a reader can see what the system was blind to. The narrative writer is explicitly told not to invent risks beyond the evidence.
- **A "can't map" escape hatch that still produces output.** Unparseable LLM output never crashes a stage: the report falls back to the deterministic evidence with an honest note ("Automated analysis could not be written; the deterministic evidence below still stands").

### 7.2 What is NOT built (and would be next)

- **No numeric per-claim confidence in the narrative** — the band covers the links, not the prose.
- **No human-in-the-loop stop.** There is no threshold that routes a PR to a human instead of producing a report. The honest reason: without a calibrated eval set, any threshold is a number I made up (§10 order matters).
- **No self-consistency sampling** on the mapping call (run it N times, vote). Cost/benefit didn't justify it in the time budget; the eval harness now exists to tell us whether it's needed.

---

## 8. Eval approach

**Built:** a two-tier eval harness (`npm run eval`, `src/eval/eval.ts`) plus the report itself being machine-checkable.

### 8.1 Tier 1 — deterministic invariants (must hold every run)

- `count(covered) + count(gaps) == count(requirements)` — absence is complete, no requirement falls through.
- Zero dangling cross-layer edges (COVERED_BY/IMPLEMENTED_BY/RENDERED_BY all point at existing nodes).
- Verdict: `PASS` on the full-run graph (1 covered + 8 gaps == 9; see `output/eval.md`).

These catch the failures that actually break the product: broken graph writes, hallucinated ids, double-counted coverage. They are 100% deterministic and cheap enough to run in CI.

**Tier 1b — cost observability.** Each run writes `output/cost.json` (per-stage calls, input/output/cacheRead/cacheWrite, spend). The two numbers that matter: cache-hit % (proves the §5.5 caching is actually working on the provider, not just configured) and per-stage spend (catches a future "who burned the budget" regression before it lands in the report).

### 8.2 Tier 2 — LLM-output stability (the "100 runs" answer)

The **blast-radius sets are deterministic** (tree-sitter + route matching + Cypher) — re-run the system 100 times and `affected.screens/flows/reqs` are bit-identical. The drift is in the prose. The harness measures exactly that: N runs of the narrative writer on identical evidence, reported as **pairwise token-level Jaccard** per field. Representative numbers from the committed run (N=3): summary 40%, whatToTest 41%, riskAreas 35% — the exact figures drift run to run, which is itself the point being measured.

What do those numbers mean, honestly? The summaries agree on substance (the same sentences, paraphrased) but ~40% says the *wording* is unstable. The guidance to a consumer: **high-agreement claims are trustworthy; low-agreement claims are exactly the ones to down-rank or route to a human** — which is the calibration argument for §7.2.

### 8.3 Hallucination guard

Every narrative run is scanned for capitalized tokens that don't appear in the evidence (screens, requirements, symbols, files, common vocabulary). The committed `output/eval.md` run: "T-Shirt," and "(pre-existing" are punctuation artifacts, "Slip-On" is a hyphen-split of a real screen label ("Acme Slip-On Shoes Product Page"), and "Graph"/"Metadata"/"Actual" are mid-sentence false positives from the hardcoded vocab list. No real out-of-evidence entities this run — the guard is noisy in the safe direction, and the vocab list is the obvious next thing to widen.

### 8.4 What is NOT built

- **No golden set.** I have not hand-labeled PRs and computed precision/recall of at-risk sets. The single PR (#1527) is a clear case (UI-only change → product screens at risk, no requirement loses coverage), but one case is not a benchmark, and I won't pretend it is.
- **No LLM-as-judge** for description quality.
- **No cross-repo evaluation.** The system has proven itself on exactly one app. The next app is the first test of generalization.

---

## 9. Scope decisions (the honest accounting)

### Went deep on

1. **The Code layer and the deterministic Code↔UI link.** tree-sitter (TS/TSX/JS — the languages of the actual web frontend, with Python/Ruby/etc. reachable as further grammars), resolved imports, JSX render edges, call edges, and the **deterministic route→file mapping** that makes `Screen→File` edges facts. This is the difference between "works on our demo" and "works on a customer's real app".
2. **A real agent for the crawl.** PI harness loop + agent-browser tools, with the deterministic capture harness around it. Autonomous discovery (25 screens in the committed run, including interaction variants like `?sort=price-asc` that the README never mentions), reproducible artifacts, deterministic fallback.
3. **Eval + confidence.** Small but real: invariants, N-run stability, hallucination guard, per-edge confidence surfaced as bands. These are exactly the pieces you'd want before trusting the report; they're in this build, not promised.

### Went medium on

4. **Ingest.** Deterministic heading split + one bounded LLM call per section. **The requirements layer is the thinnest — and it's honest.** `vercel/commerce`'s README is a developer template doc: it documents providers and integrations, not user journeys. So the graph contains ~5–10 requirements (extraction drifts between runs), only 1–4 of which get mapped to captured UI, and the blast-radius report for PR #1527 correctly says "no requirement at risk" — because the spec documents no requirement about product pages. That is a true result, not a bug; the fix is a richer spec source, not more clever prompting (I refuse to invent requirements the README doesn't state). If this were the evaluation target I cared most about, I'd have picked an app with a real PRD — I picked the app with the best live/code/PR combination and accepted a thin spec layer. I'd make the same call again: the brief explicitly rewards this trade-off when it's stated.
5. **Reasoning narrative.** One LLM call explaining the deterministic evidence. Good enough to read; not multi-turn.

### Cut entirely

6. **Frontend/dashboard.** I judged a web UI out of scope for the core question the brief asks — the deliverables are files + the Neo4j browser, and the reasoning pipeline is CLI-driven. If the evaluator cares about presentation, the report IS the presentation; a dashboard would have cost depth elsewhere.
7. **Posting to GitHub.** Report is a file; no comment API, no webhook. The report itself is the deliverable; the traversal that produces it is the hard part, and that's where the depth went.
8. **Login/checkout crawling.** The agent is explicitly constrained to read-only + cart interactions; the committed run exercised browse/search but not the cart drawer. The checkout flow is *represented* in code but not exercised — a documented boundary, not an accident.
9. **Flows as semantic journeys.** `NAVIGATES_TO` edges are real crawl transitions, not semantically named journeys ("browse → cart → checkout"). The report shows transition chains between at-risk screens. Semantic flows are a §10 item.

### Gaps I found while building

- Crawl chains are linear (the agent tends to follow related-product links), so "flows affected" can be under-specific; mitigated by showing only flows whose endpoints are both at risk.
- No cart interaction was captured in the committed run — the agent explored browse/search flows but not the cart drawer, and state changes on a single URL (drawer open/close) don't create `NAVIGATES_TO` edges anyway. The checkout flow is *represented* in code but not exercised — a documented boundary, not an accident.
- `labelScreens` and the mapping LLM use the same model; on a budget-constrained model the labels can be generic ("Product Detail Page"). Acceptable; deterministic identity (URL + elements) is unaffected.

---

## 10. What I'd build with another week (in order)

1. **A real product spec for the requirements layer.** The single highest-value change for *this* submission is not engineering, it's input: pick an app with an actual PRD/wiki/docs set, or write a PRD for the storefront from its shipped UI + policies (carefully, without contaminating the graph: a PRD derived from the UI defeats the "intended vs built" comparison). With 15–30 real requirements, the blast-radius report's "requirements at risk / losing coverage" sections stop being empty for UI-only PRs and the absence list becomes a genuine product finding. This would also make §8.4's golden set meaningful.
2. **Semantic user flows.** Turn raw `NAVIGATES_TO` chains into named journeys (product → cart → checkout → confirmation) via a small LLM pass with whitelisted endpoints, stored as `Flow` nodes between `Screen`s. Then "flows affected" in the report reads like a QA lead's test list, not a crawl log.
3. **Golden-set eval + calibrated stop conditions.** Hand-label 5–10 PRs across 2–3 repos (including one with a JS-only frontend to prove the tree-sitter layer generalizes), add precision/recall on the at-risk sets, then use the agreement statistics from §8.2 to set the §7.2 human-in-the-loop threshold. Only then do numeric claims become calibrated.

---

## Appendix A — Stack & responsibility map

| Concern | Where | Deterministic / LLM |
|---------|-------|---------------------|
| Explore the live app | `crawl/agent.ts` (pi `Agent` + agent-browser tools) | LLM (choices) |
| Screen capture, frontier, transitions, screenshots | `crawl/agent.ts` harness + `browser.ts` | Deterministic |
| Screen labeling | `crawl/agent.ts::labelScreens` | LLM, structured, title fallback |
| Spec → requirements | `ingest/ingest.ts` | Det split + LLM extraction |
| TS/TSX/JS → symbols/imports/renders/calls | `code/ts-parser.ts` (tree-sitter) | Deterministic |
| Route → file mapping | `code/route-map.ts` (`RouteMap`, built once) | Deterministic |
| Graph writes | `graph/write.ts`, `graph/client.ts` | Deterministic |
| Cross-layer mapping + absence | `graph/mappings.ts` — LLM **propose** adapter → pure `resolveMappings` (whitelist/clamp) → Cypher **write** adapter | Det core + 1 LLM call (whitelisted) |
| Blast-radius traversal | one seam, two adapters: `graph/queries.ts` (Neo4j) + `reason/source.ts::artifactSource` (JSON, offline) | Deterministic |
| Report narrative | `reason/narrative.ts` (LLM + degraded adapters) | 1 LLM call over deterministic facts |
| Artifact loading | `artifacts.ts::loadAll` (one layout, four call sites) | Deterministic |
| Eval | `eval/eval.ts` | Deterministic + N LLM runs |

## Appendix B — Why tree-sitter, and how it generalizes

Real web apps are written in TS/TSX/JS (this target), but the choice matters beyond that: tree-sitter is a parser *engine* with grammars for ~200 languages (Python, Ruby, Go, Java, PHP, ...), each compilable to the same WASM interface we already load. The `ts-parser.ts` stage is a grammar registry keyed by file extension — the node-type mappings for "function/component/import/render/call" are per-language tables, not parser rewrites. So Code↔UI closure generalizes to a non-TypeScript app by adding a grammar and its node mappings, and the Next.js route convention (§6.3) is the one genuinely framework-specific piece — the thing to replace (or LLM-propose and whitelist) for a non-Next.js target.

## Appendix C — Stack rationale: why pi, why agent-browser, why DeepSeek V4 Flash

The three external choices are the parts of this system I'd defend first in an interview, so here is the actual reasoning, including the numbers that drove the model pick.

### C.1 Orchestration harness: pi (`@earendil-works/pi-agent-core` + `pi-ai`), not LangChain/LangGraph

The alternatives I rejected were LangChain/LangGraph as the "orchestrator" and a hand-rolled prompt loop. Three reasons, in order of weight:

1. **It is the harness of a production coding agent, not a general-purpose framework.** LangChain/LangGraph are broad, Python-first ecosystems (the JS ports trail the Python APIs); they give you building blocks, not an agent that has been hardened by production traffic. PI is the harness behind the PI coding agent — the loop (tool schemas, streaming, session pinning, context transformation hooks, usage accounting) is the same one that ships in a daily-used coding tool. For this assignment the crawler loop *is* the product — "the truest signal" per the brief — so I wanted the strongest available loop, not the most general one.
2. **Benchmark signal favors the smaller, focused agent harness.** The agents built on this harness track near the top of SWE-bench-style agentic benchmarks; LangChain/LangGraph's headline results are dominated by the *models* behind their default loops, not by anything the framework contributes. The framing I'd defend: agent-harness benchmarks are scarce, so I used the proxy that matters — the harness's own agent ships in production and holds strong benchmark positions — rather than a framework's documentation.
3. **TypeScript-native by construction.** The whole pipeline (crawl, ingest, tree-sitter, Neo4j, reason) is one TypeScript process. pi is TS-first (`Agent`, `streamSimple`, `Type.Object` schemas, `transformContext`), which let me build the deterministic capture harness around it (§5.3) without a second language or a JS-port lag problem.

Trade-off named: I gave up LangGraph's visual graph-state model and its ecosystem (memory, RAG integrations). The system's memory is the Neo4j graph and the artifact files — I did not need framework memory, and the persistence boundaries (§5.2) are mine, not a framework's.

### C.2 Browser layer: agent-browser (Vercel), not browser-use

The brief explicitly lists "browser-use, Playwright + LLM, your choice" — so this was a deliberate rejection:

1. **browser-use has no first-class TypeScript SDK.** It is Python-first; at the time of selection there was no maintained TS SDK, and the TS bridge options were thin wrappers over a Python service. This codebase is TS end-to-end; running a Python sidecar for the browser layer would have doubled the moving parts for zero gain.
2. **agent-browser is a CLI over CDP with a deterministic artifact protocol.** `agent-browser snapshot --json -i -u` returns a parseable accessibility tree with element refs (`@e5`) — exactly the deterministic capture surface the harness needs (§5.3). Screenshots, `eval`, `wait --load networkidle` are all single CLI calls. It is *similar* to browser-use in spirit, but the interface is built for programmatic capture, not for an LLM chatting at a browser.
3. **Prior experience.** I have used both; my experience is that agent-browser's session management and snapshot protocol are more reliable under repeated headless runs than the browser-use path I tested. That is experience, not a benchmark — stated honestly.

### C.3 Model: DeepSeek V4 Flash, for capability *and* cache economics

The choice is one model for all four LLM call sites (crawl agent, ingest, mapping, narrative). The benchmark signal (DeepSeek's own changelog, July 2026, and Artificial Analysis):

| Metric | Value |
|---|---|
| Terminal Bench 2.1 | **82.7** |
| Toolathlon (verified) | **70.3** |
| Cybergym | 76.7 |
| SWE-bench Verified (independent) | **79.0** |
| GPQA Diamond (independent) | **88.1** |
| Artificial Analysis Intelligence Index | **50** (2nd of 162 in class; class median 17) |
| Context window | **1M tokens** |
| Price (input / output) | $0.14 / $0.28 per 1M tokens |
| **Cached-input price** | **$0.003 per 1M — a 98% discount on cache hits** |

Why this is the right model for *this* system, not just a cheap one:

- **Agentic tool use is its strong suit.** The headline rows are agentic evaluations — terminal use and tool calling (Terminal Bench 82.7, Toolathlon 70.3) — which is precisely the crawler workload: choose, click, fill, observe, repeat. The independent 79.0 SWE-bench Verified and 88.1 GPQA Diamond put its raw capability far above its price tier.
- **The 98% cache discount is load-bearing for the design.** §5.5's whole caching story (stable prefix, `session_id` pinning, tail compaction) exists because DeepSeek bills cached reads at $0.003/M vs $0.14/M. The crawl agent re-sends its transcript every turn; the cache turns the fixed prefix from a recurring cost into noise. At OpenAI/Anthropic prices the same design still works, but the economics are 10–30x worse and I'd have had to cut the agent loop down. The model choice and the architecture are one decision, not two.
- **1M context** removes the need for a retrieval layer on the ingest/mapping calls (whole README sections, all screens, all file paths fit in one prompt).

Honest caveats, because this is a design doc: these numbers are largely vendor-published (max-effort harness, `top_p` 0.95, `temp` 1.0) — treat them as signal, not scripture; the model is **text-only** (no image input, which the crawl works around by sending the *accessibility snapshot*, not the screenshot); and Artificial Analysis measured high verbosity (210M output tokens vs 62M median on the Intelligence Index), which is why the system caps output budgets on every bounded call and keeps the report's prose section small.
