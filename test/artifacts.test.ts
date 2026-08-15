import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAll, screenKeys } from "../src/artifacts.js";
import type { Config } from "../src/config.js";
import type { CrawlArtifacts } from "../src/types.js";

const baseCfg: Config = {
  openRouterApiKey: "",
  cheapModel: "gpt-4o-mini",
  reasonModel: "google/gemini-2.5-flash",
  neo4jUri: "bolt://localhost:7687",
  neo4jUsername: "neo4j",
  neo4jPassword: "x",
  neo4jDatabase: "neo4j",
  appBaseUrl: "https://demo.vercel.store",
  repoFullName: "vercel/commerce",
  prNumber: 1,
  crawlMaxScreens: 25,
  crawlMaxActionsPerScreen: 6,
  outputDir: "",
};

test("screenKeys builds graph keys in one place", () => {
  const crawl: CrawlArtifacts = {
    baseUrl: "https://x.test",
    screens: [{ screenId: "s1" } as CrawlArtifacts["screens"][number]],
    transitions: [],
    generatedAt: "",
  };
  assert.deepEqual(screenKeys("acme/store", crawl), ["acme/store::screen::s1"]);
});

test("loadAll reads the committed artifact layout", () => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  try {
    const crawlDir = join(dir, "crawl");
    mkdirSync(crawlDir, { recursive: true });
    writeFileSync(
      join(crawlDir, "manifest.json"),
      JSON.stringify({ baseUrl: "https://x.test", screens: [], transitions: [], generatedAt: "" })
    );
    writeFileSync(join(dir, "requirements.json"), JSON.stringify({ requirements: [{ reqId: "R1" }] }));
    writeFileSync(join(dir, "code.json"), JSON.stringify({ fullName: "acme/store", ref: "main", files: [], imports: [], renders: [], calls: [] }));

    const a = loadAll({ ...baseCfg, outputDir: dir });
    assert.equal(a.crawl.baseUrl, "https://x.test");
    assert.equal(a.requirements[0]?.reqId, "R1");
    assert.equal(a.code.ref, "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
