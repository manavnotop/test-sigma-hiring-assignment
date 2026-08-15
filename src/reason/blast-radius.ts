import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { loadAll } from "../artifacts.js";
import { fetchPullRequest, fetchPullRequestFiles } from "../github/api.js";
import { computeBlastRadius, graphSource, type BlastRadiusSource } from "./source.js";
import { getNarrativeWriter, type Narrative } from "./narrative.js";
import type { AffectedCode } from "../types.js";

export async function reasonAboutPr(
  source: BlastRadiusSource = graphSource()
): Promise<string> {
  const cfg = getConfig();
  const { crawl, requirements, code } = loadAll(cfg);
  const pr = await fetchPullRequest(cfg.repoFullName, cfg.prNumber);
  const prFiles = await fetchPullRequestFiles(cfg.repoFullName, cfg.prNumber);
  const changedPaths = prFiles
    .map((f) => f.filename)
    .filter((p) => code.files.some((f) => f.path === p));

  console.log(
    `  [reason] PR #${pr.number} "${pr.title}" — ${prFiles.length} files changed (${changedPaths.length} in code layer)`
  );

  const affected = await computeBlastRadius(changedPaths, source);
  const conf = await source.edgeConfidence(affected.reqs.map((r) => r.key));

  // ---- narrative: LLM synthesis (the numbers above are deterministic) ------
  const narrative = await getNarrativeWriter().synthesizeNarrative({
    prTitle: pr.title,
    prBody: pr.body,
    prFiles,
    affected,
    crawl,
    requirements,
  });

  const report = renderReport({
    pr,
    prFiles,
    changedPaths,
    affected,
    narrative,
    confidence: conf,
    layers: {
      crawl: crawl.screens.length > 0,
      code: code.files.length > 0,
      reqs: requirements.length > 0,
      totalScreens: crawl.screens.length,
    },
  });

  const outPath = join(cfg.outputDir, `blast-radius-PR-${pr.number}.md`);
  writeFileSync(outPath, report);
  console.log(`  [reason] report written -> ${outPath}`);
  return outPath;
}

export function renderReport(args: {
  pr: Awaited<ReturnType<typeof fetchPullRequest>>;
  prFiles: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  changedPaths: string[];
  affected: AffectedCode;
  narrative: Narrative;
  confidence: { avg: number; n: number };
  layers: { crawl: boolean; code: boolean; reqs: boolean; totalScreens: number };
}): string {
  const { pr, prFiles, affected, narrative, confidence, layers } = args;
  const reportScreenCount = layers.totalScreens;
  const band = (c: number) => (c >= 0.75 ? "high" : c >= 0.5 ? "medium" : "low");
  const confText =
    confidence.n > 0
      ? `average ${(confidence.avg * 100).toFixed(0)}% across ${confidence.n} cross-layer links (${band(confidence.avg)} band)`
      : "no cross-layer links for at-risk requirements";

  // Flows worth showing: navigation edges where BOTH endpoints are at risk
  const affectedScreenKeys = new Set(affected.screens.map((s) => s.key));
  const flows = affected.flows.filter(
    (f) => affectedScreenKeys.has(f.from) && affectedScreenKeys.has(f.to)
  );

  const L = [
    layers.reqs ? "✅ Requirements" : "⚪ Requirements (none ingested)",
    layers.crawl
      ? `✅ DOM/UI (${reportScreenCount} screens crawled)`
      : "⚪ DOM/UI (no crawl)",
    layers.code ? "✅ Code + graph (tree-sitter)" : "⚪ Code (no parse)",
  ];

  const bullet = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "_none_");

  return `# 🛡️ Blast-radius report — PR #${pr.number}

**${pr.title}** · \`${pr.state}\` · base \`${pr.baseRef}\` → head \`${pr.headRef}\` @ \`${pr.headSha.slice(0, 7)}\`

> Written for a QA lead who knows the product but not the code. The affected-screens/flows/requirements sections below come from a deterministic traversal of the knowledge graph (code → components → screens → flows → requirements); only the prose is written by an LLM.

## Summary

${narrative.summary || "_(no narrative — LLM unavailable; deterministic evidence below)_"}

## 🎯 Screens at risk

${bullet(affected.screens.map((s) => `${s.label || s.url} — \`${s.url}\``))}

## 🔀 User flows affected

${bullet(flows.map((f) => `${f.fromLabel || f.from} → ${f.toLabel || f.to}`))}

## 📋 Requirements at risk

${bullet(affected.reqs.map((r) => `**${r.reqId}** ${r.title} — via ${r.via}`))}

## ⚠️ Requirements losing coverage

${bullet(affected.losingCoverage.map((r) => `**${r.reqId}** ${r.title}`))}

## 🔍 Pre-existing gaps (requirements with no UI coverage)

These were already untestable in the captured UI — this PR does not cause them, but they matter for planning:

${bullet(affected.uncovered.map((r) => `**${r.reqId}** ${r.title}`))}

## 🧪 What to test

${bullet(narrative.whatToTest)}

## ⚠️ Risk areas

${bullet(narrative.riskAreas)}

## 🔧 What changed in code

${bullet(prFiles.map((f) => `${f.filename} (${f.status}, +${f.additions}/−${f.deletions})`))}

Affected code (via graph): ${affected.files.join(", ") || "_none_"}

## 🔍 Honesty & confidence

- Confidence on cross-layer links: **${confText}**
- Layers used: ${L.join(" · ")}
- Notes: ${narrative.notes.length ? narrative.notes.join(" · ") : "none"}
`;
}
