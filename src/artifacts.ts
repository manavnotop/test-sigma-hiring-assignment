import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig, type Config } from "./config.js";
import { screenKey } from "./graph/client.js";
import type { CodeModel, CrawlArtifacts, Requirement } from "./types.js";

export interface Artifacts {
  crawl: CrawlArtifacts;
  requirements: Requirement[];
  code: CodeModel;
}

/**
 * The committed-pipeline interface: output file layout and graph key format
 * are known here and nowhere else. Every stage (connect, reason, report,
 * eval) reads the artifacts through this module instead of re-deriving the
 * layout — a layout change now breaks one module, not four callers.
 */
export function loadAll(cfg: Config = getConfig()): Artifacts {
  const crawl = JSON.parse(
    readFileSync(join(cfg.outputDir, "crawl", "manifest.json"), "utf-8")
  ) as CrawlArtifacts;
  const requirements = JSON.parse(
    readFileSync(join(cfg.outputDir, "requirements.json"), "utf-8")
  ).requirements as Requirement[];
  const code = JSON.parse(
    readFileSync(join(cfg.outputDir, "code.json"), "utf-8")
  ) as CodeModel;
  return { crawl, requirements, code };
}

/** Neo4j screen keys for a crawl — the one place the key format is built. */
export function screenKeys(repo: string, crawl: CrawlArtifacts): string[] {
  return crawl.screens.map((s) => screenKey(repo, s.screenId));
}
