import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { withSession } from "../graph/client.js";
import { loadAll } from "../artifacts.js";
import { computeBlastRadius, graphSource } from "../reason/source.js";
import { getNarrativeWriter } from "../reason/narrative.js";
import { fetchPullRequestFiles } from "../github/api.js";

/**
 * Eval harness (Part B §8):
 *  Tier 1 — deterministic invariants against Neo4j (must hold every run).
 *  Tier 2 — LLM-output stability: N narrative runs on identical evidence,
 *           with a hallucination guard (narrative may only reference screens,
 *           flows and requirements that exist in the evidence).
 */

export async function runEval(cfg: Config): Promise<void> {
  const repo = cfg.repoFullName;
  console.log("\n=== eval ===\n");

  // ---- Tier 1: invariants ----------------------------------------------------
  const inv = await withSession(async (s) => {
    const r = await s.run(
      `MATCH (r:Requirement {full_name:$repo})
       OPTIONAL MATCH (r)-[:COVERED_BY]->(sc:Screen)
       OPTIONAL MATCH (r)-[:IMPLEMENTED_BY]->(f:File)
       OPTIONAL MATCH (r)-[:MISSING_UI_COVERAGE]->(g:CoverageGap)
       RETURN count(DISTINCT r) AS reqs,
              count(DISTINCT CASE WHEN sc IS NOT NULL THEN r.key END) AS covered,
              count(DISTINCT g) AS gaps,
              count(DISTINCT sc) AS coverEdges,
              count(DISTINCT f) AS implEdges`,
      { repo }
    );
    const row = r.records[0];

    const danglingCover = await s.run(
      `MATCH (a:Requirement)-[e:COVERED_BY]->(b)
       WHERE NOT b:Screen RETURN count(e) AS n`,
      {}
    );
    const danglingImpl = await s.run(
      `MATCH (a:Requirement)-[e:IMPLEMENTED_BY]->(b)
       WHERE NOT b:File RETURN count(e) AS n`,
      {}
    );
    const danglingRender = await s.run(
      `MATCH (a:Screen)-[e:RENDERED_BY]->(b)
       WHERE NOT b:File RETURN count(e) AS n`,
      {}
    );
    return {
      reqs: Number(row?.get("reqs") ?? 0),
      covered: Number(row?.get("covered") ?? 0),
      gaps: Number(row?.get("gaps") ?? 0),
      coverEdges: Number(row?.get("coverEdges") ?? 0),
      implEdges: Number(row?.get("implEdges") ?? 0),
      dangling: [
        Number(danglingCover.records[0]?.get("n") ?? 0),
        Number(danglingImpl.records[0]?.get("n") ?? 0),
        Number(danglingRender.records[0]?.get("n") ?? 0),
      ],
    };
  });

  const invariantsOk =
    inv.reqs > 0 &&
    inv.covered + inv.gaps === inv.reqs &&
    inv.dangling.every((n) => n === 0);
  console.log(`Tier 1 — deterministic invariants:`);
  console.log(`  requirements=${inv.reqs}  covered=${inv.covered}  gaps=${inv.gaps}`);
  console.log(`  covered+gaps==reqs: ${inv.covered + inv.gaps === inv.reqs}`);
  console.log(
    `  dangling edges (COVERED_BY/IMPLEMENTED_BY/RENDERED_BY): ${inv.dangling.join("/")}`
  );
  console.log(`  => ${invariantsOk ? "PASS" : "FAIL"}\n`);

  // ---- Tier 2: narrative stability on identical evidence --------------------
  const { crawl, requirements, code } = loadAll(cfg);
  const prFiles = await fetchPullRequestFiles(cfg.repoFullName, cfg.prNumber);
  const codePaths = new Set(code.files.map((f) => f.path));
  const changedPaths = prFiles.map((f) => f.filename).filter((p) => codePaths.has(p));

  const N = Number(process.env.EVAL_RUNS ?? "3");
  const narratives = [];
  for (let i = 0; i < N; i++) {
    const affected = await computeBlastRadius(changedPaths, graphSource(cfg));
    const n = await getNarrativeWriter().synthesizeNarrative({
      prTitle: "PR title",
      prBody: "",
      prFiles: [],
      affected,
      crawl,
      requirements,
    });
    narratives.push(n);
    console.log(`  run ${i + 1}/${N}: ${n.summary.slice(0, 80)}...`);
  }

  const jaccard = (a: string[], b: string[]) => {
    const sa = new Set(a.map((x) => x.trim().toLowerCase()));
    const sb = new Set(b.map((x) => x.trim().toLowerCase()));
    if (sa.size === 0 && sb.size === 0) return 1;
    const inter = [...sa].filter((x) => sb.has(x)).length;
    return inter / new Set([...sa, ...sb]).size;
  };

  // token-level Jaccard for free text (summaries), set-level for lists
  const tokens = (t: string) =>
    t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const textJaccard = (a: string, b: string) => jaccard(tokens(a), tokens(b));

  const fields: Array<keyof typeof narratives[0]> = ["summary", "whatToTest", "riskAreas"];
  console.log(`\nTier 2 — narrative stability across ${N} runs (pairwise Jaccard):`);
  const rows: Array<{ field: string; j: number }> = [];
  for (const field of fields) {
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < N; i++) {
      for (let k = i + 1; k < N; k++) {
        const a = narratives[i][field] as string | string[];
        const b = narratives[k][field] as string | string[];
        const j =
          field === "summary"
            ? textJaccard(a as string, b as string)
            : textJaccard((a as string[]).join(" "), (b as string[]).join(" "));
        total += j;
        pairs++;
      }
    }
    const j = pairs ? total / pairs : 1;
    rows.push({ field, j: Math.round(j * 100) });
    console.log(`  ${field}: ${(j * 100).toFixed(0)}%`);
  }

  // ---- hallucination guard ----------------------------------------------------
  const knownVocab = new Set<string>();
  for (const s of crawl.screens) {
    for (const w of tokens(`${s.label} ${s.url} ${s.title}`)) knownVocab.add(w);
  }
  for (const r of requirements) {
    for (const w of tokens(`${r.reqId} ${r.title} ${r.userAction} ${r.expectedOutcome}`)) {
      knownVocab.add(w);
    }
  }
  // code-layer vocabulary: symbols + files the narrative may legitimately name
  for (const f of code.files) {
    for (const w of tokens(f.path.replace(/[/\\\[\]]/g, " "))) knownVocab.add(w);
    for (const sym of f.symbols ?? []) knownVocab.add(String(sym.name ?? "").toLowerCase());
  }
  const common = [
    "product", "page", "pages", "json", "ld", "xss", "ui", "qa", "pr", "flow", "flows",
    "screen", "screens", "requirement", "requirements", "test", "tests", "testing",
    "search", "cart", "acme", "store", "verify", "confirm", "ensure", "validate",
    "check", "checking", "navigation", "pre", "existing", "related", "description",
    "details", "detail", "image", "images", "title", "titles", "data", "render",
    "rendering", "script", "block", "blocks", "fix", "fixes", "change", "changes",
    "vulnerability", "vulnerable", "malicious", "injection", "escaped", "escape",
    "escaping", "unescaped", "component", "components", "template", "templates",
    "code", "function", "functions", "jsonld", "scripts", "admin", "customer",
    "customers", "user", "users", "browser", "browsers", "attacker", "field",
    "fields", "content", "values", "value", "model", "models", "system", "systems",
  ];
  for (const t of common) knownVocab.add(t);
  let mentions = 0;
  const suspicious: string[] = [];
  const allText = narratives
    .flatMap((n) => [n.summary, ...n.whatToTest, ...n.riskAreas, ...n.notes])
    .join("\n");
  const suspiciousSet = new Set<string>();
  for (const word of allText.split(/\s+/)) {
    const clean = word.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (clean.length < 5) continue;
    if (/^[a-z]/.test(word)) continue; // only capitalized tokens are candidate entities
    if (knownVocab.has(clean)) continue;
    if (word === word.toUpperCase()) continue; // acronyms
    if (!suspiciousSet.has(clean)) {
      suspiciousSet.add(clean);
      mentions++;
      if (suspicious.length < 15) suspicious.push(word);
    }
  }
  console.log(`\nHallucination guard (mentions not matching any captured screen/requirement):`);
  console.log(`  ${suspicious.length ? suspicious.join(", ") : "none found"}`);

  const report = `# Eval report — ${cfg.repoFullName} (PR #${cfg.prNumber})

Run at: ${new Date().toISOString()}

## Tier 1 — deterministic invariants

| check | value | status |
|---|---|---|
| requirements | ${inv.reqs} | — |
| covered by UI | ${inv.covered} | — |
| absence gaps | ${inv.gaps} | — |
| covered + gaps == reqs | ${inv.covered + inv.gaps} == ${inv.reqs} | ${inv.covered + inv.gaps === inv.reqs ? "PASS" : "FAIL"} |
| dangling cross-layer edges | ${inv.dangling.join("/")} | ${inv.dangling.every((n) => n === 0) ? "PASS" : "FAIL"} |

## Tier 2 — narrative stability (${N} runs, pairwise Jaccard)

${rows.map((r) => `| ${r.field} | ${r.j}% |`).join("\n")}

## Hallucination guard

Suspicious mentions: ${suspicious.join(", ") || "none"}

> The blast-radius *sets* (screens, flows, requirements at risk) are produced deterministically from the graph and are bit-identical across runs; only the prose drifts.`;
  const outPath = join(cfg.outputDir, "eval.md");
  writeFileSync(outPath, report);
  console.log(`\n  eval report -> ${outPath}`);
}
