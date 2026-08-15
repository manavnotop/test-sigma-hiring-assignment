# Blast-Radius Agent

**TESTSIGMA take-home (Part A + B)** — an agent that **crawls a live application**, **ingests a product spec**, **builds a three-layer knowledge graph** (Requirements / UI / Code) in **Neo4j (Docker)**, and **reasons about the blast radius of a real pull request**.

Stack: **TypeScript end-to-end** · `@earendil-works/pi-agent-core` + `pi-ai` (the **PI harness**, not the coding agent) · **agent-browser** (Vercel) · **tree-sitter** · **Neo4j 5 (Docker)** · **OpenRouter** (DeepSeek V4 Flash).

## Demo targets

| Layer | Target |
|---|---|
| Live app to crawl | `demo.vercel.store` — the **Vercel Commerce** storefront |
| Public repo | `vercel/commerce` (TypeScript, Next.js App Router) |
| Real PR | **#1527** — "Fix stored XSS in product JSON-LD" (1 file, `app/product/[handle]/page.tsx`, +3/−1) |
| Product spec | `vercel/commerce` README |

## How it works (the five stages)

```
crawl ──▶ ingest ──▶ code ──▶ connect ──▶ reason
 │           │         │          │          │
 │  PI agent +       LLM      tree-sitter   LLM      graph traversal
 │  agent-browser    → reqs    TS/TSX/JS     maps     + LLM narrative
 │  → screens,       (req     → symbols,    reqs→     → blast-radius
 │    transitions    layer)   imports,      screens    report (md)
 │                           renders,      + files
 │                           routes        (whitelisted, with
 │                           (code layer)  confidence + absence)
```

1. **Crawl** — a real agent loop on the **PI harness** (`Agent` + tool calling, `streamSimple` over OpenRouter) whose tools are `agent-browser` commands (`open_url`, `click_element`, `fill_input`, `list_frontier`, `finish_crawl`). The agent explores autonomously; the harness deterministically captures every new URL (accessibility snapshot, screenshot, interactive elements, link frontier) and records **interaction transitions**. No LLM key? It falls back to a deterministic BFS crawl — the pipeline still runs, degraded.
2. **Ingest** — fetch the README, split on markdown headings (deterministic), one bounded LLM call per section → testable `{user_action, expected_outcome, priority}` requirements.
3. **Code** — **tree-sitter** (web-tree-sitter + TSX/TS/JS grammars) parses the repo tarball: functions, components, classes, imports, JSX render edges, call edges. Routes are built **once** into a `RouteMap` (`src/code/route-map.ts`) — static-over-dynamic priority — and every stage resolves URLs through it instead of re-implementing the matcher.
4. **Connect** — writes the three layers into Neo4j; one LLM call **proposes** requirement→screen/file links (Proposer adapter), a pure deterministic resolver (`src/graph/mappings.ts`) whitelists and clamps them (hallucinations are dropped, confidence clamped), the Writer adapter writes edges and first-class `CoverageGap` nodes (**absence is modelled as state, not missing rows**).
5. **Reason** — one **seam** (`BlastRadiusSource`, `src/reason/source.ts`) with two adapters: the **graph adapter** (Neo4j traversal — files, symbols, screens, flows, requirements, absence, confidence) and the **artifact adapter** (same traversal over the committed JSON, used by `npm run report` offline). Both compute the same deterministic sets — an invariant test asserts they agree. The **narrative writer** (`src/reason/narrative.ts`) is its own seam: an LLM adapter and a degraded no-key adapter, both writing only from the deterministic evidence. Output: `output/blast-radius-PR-1527.md`.

## Run it

### 0. Prereqs
- Node 20+, Docker (for Neo4j — **nothing Neo4j is installed natively**), `agent-browser` CLI (`npm i -g agent-browser && agent-browser install`)
- An OpenRouter API key

### 1. Setup
```bash
cp .env.example .env        # add OPENROUTER_API_KEY
docker compose up -d        # Neo4j 5 (ports 7474/7687, volume neo4j_data)
npm install
```

### 2. Run the whole pipeline
```bash
npm run all
```
or stage by stage: `npm run crawl` · `npm run ingest` · `npm run code` · `npm run connect` · `npm run reason` · `npm run report`.

### 3. See the output
- `output/blast-radius-PR-1527.md` — the blast-radius report (non-engineer readable), regenerable from the committed JSON artifacts with `npm run report` (no Docker/LLM needed). The committed copy is the offline run; the full-pipeline version (graph + LLM narrative) is in `docs/sample-output.md` and reproduced by `npm run all`.
- `output/crawl/manifest.json` + `output/crawl/screens/*.png|*.json` — crawl artifacts (screenshots + a11y snapshots) from the committed full-budget run: **25 screens, 24 transitions**, including a search (`?q=shirt`) and a sorted-category interaction (`?sort=price-asc`).
- `output/code.json`, `output/requirements.json` — intermediate layers
- `output/cost.json` — per-stage LLM spend + prompt-cache hit stats (cache reads on DeepSeek bill at 0.1× input price; the crawl agent pins OpenRouter sticky routing with a `session_id` and compacts old snapshots out of the transcript — see `docs/design.md` §5.5)
- Neo4j browser: http://localhost:7474 (`neo4j` / `blastradius`)

The absence query (requirements that should be testable but have no captured UI):
```cypher
MATCH (r:Requirement {full_name:"vercel/commerce"})-[:MISSING_UI_COVERAGE]->(:CoverageGap)
RETURN r.req_id, r.title
```

### 4. Eval + tests
```bash
npm run eval          # invariants vs Neo4j + N-run narrative stability + hallucination guard
npm test              # hermetic unit tests (RouteMap, resolver, artifacts)
                      # + adapter-agreement invariant (skips if Neo4j is down)
```

## Deliverables
- `docs/design.md` — Part B design document (agent decomposition, schema, confidence, eval, scope, next week)
- `docs/sample-output.md` — the full-pipeline blast-radius report for PR #1527
- `output/blast-radius-PR-1527.md` — same report, regenerated by `npm run all` (and offline via `npm run report`)
- This README

## Docs
Read in order: **[`docs/design.md`](docs/design.md)** (Part B, opinionated) → **[`docs/sample-output.md`](docs/sample-output.md)** (sample blast-radius report) → **this README** (ops).
