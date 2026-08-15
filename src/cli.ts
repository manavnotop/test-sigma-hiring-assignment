import { getConfig } from "./config.js";
import { verifyGraph, resetRepo } from "./graph/client.js";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const cfg = getConfig();
  console.log(`\n=== blast-radius agent ===`);
  console.log(`app: ${cfg.appBaseUrl}`);
  console.log(`repo: ${cfg.repoFullName}  PR: #${cfg.prNumber}\n`);

  switch (cmd) {
    case "crawl": {
      const { crawlApp } = await import("./crawl/agent.js");
      const { Browser } = await import("./crawl/browser.js");
      await crawlApp(cfg, new Browser());
      break;
    }
    case "ingest": {
      const { ingestRepo } = await import("./ingest/ingest.js");
      await ingestRepo(cfg.repoFullName);
      break;
    }
    case "code": {
      const { buildCodeModel } = await import("./code/code-model.js");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const model = await buildCodeModel(cfg.repoFullName, "main");
      mkdirSync(cfg.outputDir, { recursive: true });
      writeFileSync(join(cfg.outputDir, "code.json"), JSON.stringify(model, null, 2));
      const syms = model.files.reduce((a, f) => a + f.symbols.length, 0);
      console.log(
        `  [code] ${model.files.length} files, ${syms} symbols, ${model.imports.length} imports, ${model.renders.length} renders, ${model.calls.length} calls -> output/code.json`
      );
      break;
    }
    case "connect": {
      if (!(await verifyGraph())) {
        console.error("Neo4j not reachable. Start it: docker compose up -d");
        process.exit(1);
      }
      const { writeCodeLayer, writeRequirementsLayer, writeScreensLayer, connectLayers } =
        await import("./graph/write.js");
      const { loadAll } = await import("./artifacts.js");
      const { RouteMap } = await import("./code/route-map.js");
      const { code, requirements, crawl } = loadAll(cfg);
      await resetRepo(cfg.repoFullName);
      await writeCodeLayer(cfg.repoFullName, code);
      await writeRequirementsLayer(cfg.repoFullName, requirements);
      const screens = await writeScreensLayer(
        cfg.repoFullName,
        crawl,
        RouteMap.fromModel(code)
      );
      const stats = await connectLayers(cfg.repoFullName, requirements, screens, code);
      console.log(
        `  [connect] ${stats.files} files / ${stats.symbols} symbols / ${stats.requirements} reqs / ${stats.screens} screens`
      );
      console.log(`  covered_by_ui: ${stats.coveredByUi.join(", ") || "(none)"}`);
      console.log(`  uncovered (absence): ${stats.uncovered.join(", ") || "(none)"}`);
      console.log(
        `  absence query: MATCH (r:Requirement {full_name:"${cfg.repoFullName}"})-[:MISSING_UI_COVERAGE]->(:CoverageGap) RETURN r.req_id, r.title`
      );
      break;
    }
    case "reason": {
      const { reasonAboutPr } = await import("./reason/blast-radius.js");
      const out = await reasonAboutPr();
      console.log(`  report: ${out}`);
      break;
    }
    case "report": {
      const { runOfflineReport } = await import("./reason/offline-report.js");
      const out = await runOfflineReport();
      console.log(`  offline report: ${out}`);
      break;
    }
    case "all": {
      if (!(await verifyGraph())) {
        console.error("Neo4j not reachable. Start it: docker compose up -d");
        process.exit(1);
      }
      const { mkdirSync } = await import("node:fs");
      mkdirSync(cfg.outputDir, { recursive: true });

      const { crawlApp } = await import("./crawl/agent.js");
      const { Browser } = await import("./crawl/browser.js");
      const crawl = await crawlApp(cfg, new Browser());

      const { ingestRepo } = await import("./ingest/ingest.js");
      const ingestResult = await ingestRepo(cfg.repoFullName);

      const { buildCodeModel } = await import("./code/code-model.js");
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { RouteMap } = await import("./code/route-map.js");
      const model = await buildCodeModel(cfg.repoFullName, "main");
      writeFileSync(join(cfg.outputDir, "code.json"), JSON.stringify(model, null, 2));

      const { writeCodeLayer, writeRequirementsLayer, writeScreensLayer, connectLayers } =
        await import("./graph/write.js");
      await resetRepo(cfg.repoFullName);
      await writeCodeLayer(cfg.repoFullName, model);
      await writeRequirementsLayer(cfg.repoFullName, ingestResult.requirements);
      const screens = await writeScreensLayer(
        cfg.repoFullName,
        crawl,
        RouteMap.fromModel(model)
      );
      const stats = await connectLayers(
        cfg.repoFullName,
        ingestResult.requirements,
        screens,
        model
      );
      console.log(
        `  [connect] ${stats.requirements} reqs, ${stats.screens} screens, ${stats.coveredByUi.length} covered, ${stats.uncovered.length} uncovered`
      );

      const { reasonAboutPr } = await import("./reason/blast-radius.js");
      const out = await reasonAboutPr();
      console.log(`\n  report: ${out}`);
      break;
    }
    case "reset": {
      await resetRepo(cfg.repoFullName);
      console.log(`  reset graph for ${cfg.repoFullName}`);
      break;
    }
    case "eval": {
      const { runEval } = await import("./eval/eval.js");
      await runEval(cfg);
      break;
    }
    default:
      console.log(
        `usage: tsx src/cli.ts <crawl|ingest|code|connect|reason|report|all|reset|eval>`
      );
      process.exit(1);
  }
}

main()
  .then(async () => {
    const { closeDriver } = await import("./graph/client.js");
    closeDriver();
    const { saveUsageReport } = await import("./llm.js");
    saveUsageReport(getConfig().outputDir);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
