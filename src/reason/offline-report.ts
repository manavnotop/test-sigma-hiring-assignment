import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { loadAll } from "../artifacts.js";
import { fetchPullRequest, fetchPullRequestFiles } from "../github/api.js";
import { artifactSource, computeBlastRadius } from "./source.js";

/**
 * Offline blast-radius report: regenerates the report from the committed
 * artifacts (output/crawl/manifest.json, output/code.json, output/requirements.json)
 * without Neo4j or an LLM. It runs the SAME blast-radius seam as the
 * full-pipeline report (artifact adapter vs graph adapter) — the deterministic
 * sections (files, symbols, screens, flows) are computed by the same
 * traversal and agree with `npm run reason`; the sections that require the
 * connect stage (requirements links, absence, confidence) are marked as such
 * instead of being invented.
 */
export async function runOfflineReport(): Promise<string> {
  const cfg = getConfig();
  const { crawl, requirements, code } = loadAll(cfg);

  const pr = await fetchPullRequest(cfg.repoFullName, cfg.prNumber);
  const prFiles = await fetchPullRequestFiles(cfg.repoFullName, cfg.prNumber);
  const codePaths = new Set(code.files.map((f) => f.path));
  const changedPaths = prFiles.map((f) => f.filename).filter((p) => codePaths.has(p));

  const affected = await computeBlastRadius(changedPaths, artifactSource(cfg));

  // Flows worth showing: navigation edges where BOTH endpoints are at risk
  // (same narrowing the full-pipeline report applies).
  const affectedScreenKeys = new Set(affected.screens.map((s) => s.key));
  const flows = affected.flows.filter(
    (f) => affectedScreenKeys.has(f.from) && affectedScreenKeys.has(f.to)
  );

  const bullet = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "_none_";
  const graphOnly =
    "_not computed in offline mode — requires the knowledge graph (connect stage). Reproduce with `npm run all`._";

  const report = `# 🛡️ Blast-radius report — PR #${pr.number}

**${pr.title}** · \`${pr.state}\` · base \`${pr.baseRef}\` → head \`${pr.headRef}\` @ \`${pr.headSha.slice(0, 7)}\`

> Written for a QA lead who knows the product but not the code. This copy was generated **offline** from the committed crawl artifacts (no knowledge graph, no LLM): the affected-files/screens/flows sections below are deterministic and reproducible with \`npm run report\` — the same traversal the full-pipeline report runs (artifact adapter vs graph adapter), so the sets agree. The requirements and narrative sections require the connect and reason stages — run \`npm run all\` (Docker + OpenRouter key) to produce them. See \`docs/sample-output.md\` for the full-pipeline version.

## Summary

PR #${pr.number} changes ${changedPaths.length} file(s) in the code layer: ${changedPaths.join(", ") || "none"}. The deterministic route map links that to ${affected.screens.length} captured screen(s) at risk (${affected.screens.map((s) => s.label).join(", ") || "none"}).

## 🎯 Screens at risk

${bullet(affected.screens.map((s) => `${s.label || s.url} — \`${s.url}\``))}

## 🔀 User flows affected

${bullet(flows.map((f) => `${f.fromLabel} → ${f.toLabel}`))}

## 📋 Requirements at risk

${graphOnly}

## ⚠️ Requirements losing coverage

${graphOnly}

## 🔍 Pre-existing gaps (requirements with no UI coverage)

${graphOnly}

## 🧪 What to test

${bullet(affected.screens.map((s) => `${s.label || s.url} — \`${s.url}\`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.`))}

## ⚠️ Risk areas

- Offline report: the risk narrative requires the LLM synthesis stage (run \`npm run all\`). The deterministic sections above stand on their own.

## 🔧 What changed in code

${bullet(prFiles.map((f) => `${f.filename} (${f.status}, +${f.additions}/−${f.deletions})`))}

Affected code (via graph-equivalent traversal): ${affected.files.join(", ") || "_none_"}

## 🔍 Honesty & confidence

- Confidence on cross-layer links: **not computed in offline mode** (requires the connect stage).
- Layers used: ✅ Requirements (${requirements.length} ingested) · ✅ DOM/UI (${crawl.screens.length} screens crawled) · ✅ Code (${code.files.length} files parsed, tree-sitter) · ⚪ Knowledge graph (offline)
- Requirements in the graph: ${requirements.map((r) => `${r.reqId} ${r.title}`).join("; ") || "none"}
`;

  const outPath = join(cfg.outputDir, `blast-radius-PR-${pr.number}.md`);
  writeFileSync(outPath, report);
  console.log(`  [report] offline report written -> ${outPath}`);
  return outPath;
}
