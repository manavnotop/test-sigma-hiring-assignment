import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../src/config.js";
import { loadAll } from "../src/artifacts.js";
import { artifactSource, graphSource } from "../src/reason/source.js";
import { closeDriver, verifyGraph } from "../src/graph/client.js";

/**
 * Review item 2 invariant: the two blast-radius adapters must agree on the
 * committed artifacts. Runs the artifact adapter over output/ with the PR's
 * changed paths (extracted from the committed report so the test is
 * hermetic), and — when Neo4j is reachable — asserts the graph adapter
 * produces the same files/screens/flows sets.
 */

function changedPathsFromCommittedReport(): string[] {
  const cfg = getConfig();
  const report = readFileSync(
    join(cfg.outputDir, `blast-radius-PR-${cfg.prNumber}.md`),
    "utf-8"
  );
  const paths: string[] = [];
  for (const line of report.split("\n")) {
    const m = line.match(/^- (.+?) \((modified|added|renamed|removed)/);
    if (m) paths.push(m[1]);
  }
  return paths;
}

const canonical = (xs: Array<{ url?: string; label?: string; from?: string; to?: string }>) =>
  xs.map((x) => `${x.url ?? x.label ?? ""}|${x.from ?? ""}|${x.to ?? ""}`).sort();

after(async () => {
  await closeDriver();
});

test("artifact adapter computes blast radius from committed artifacts", async () => {
  const cfg = getConfig();
  const { code } = loadAll(cfg);
  const changed = changedPathsFromCommittedReport().filter((p) =>
    code.files.some((f) => f.path === p)
  );
  assert.ok(changed.length > 0, "no changed paths extracted from committed report");

  const affected = await artifactSource(cfg).computeAffected(changed);
  assert.ok(affected.files.includes(changed[0]), "changed file in affected set");
  for (const s of affected.screens) {
    assert.ok(s.key.startsWith(`${cfg.repoFullName}::screen::`), "screen keys canonical");
  }
});

test("adapters agree on committed artifacts (graph vs artifacts)", async (t) => {
  if (!(await verifyGraph())) {
    t.skip("Neo4j not reachable — start it with `docker compose up -d`");
    return;
  }
  const cfg = getConfig();
  const { code } = loadAll(cfg);
  const changed = changedPathsFromCommittedReport().filter((p) =>
    code.files.some((f) => f.path === p)
  );

  const [fromGraph, fromArtifacts] = await Promise.all([
    graphSource(cfg).computeAffected(changed),
    artifactSource(cfg).computeAffected(changed),
  ]);

  assert.deepEqual(
    [...fromGraph.files].sort(),
    [...fromArtifacts.files].sort(),
    "affected files must agree"
  );
  assert.deepEqual(
    [...fromGraph.symbols].sort(),
    [...fromArtifacts.symbols].sort(),
    "affected symbols must agree"
  );
  assert.deepEqual(
    [...fromGraph.upstreamSymbols].sort(),
    [...fromArtifacts.upstreamSymbols].sort(),
    "upstream symbols must agree"
  );
  assert.deepEqual(
    canonical(fromGraph.screens),
    canonical(fromArtifacts.screens),
    "screens at risk must agree"
  );
  assert.deepEqual(
    canonical(fromGraph.flows),
    canonical(fromArtifacts.flows),
    "flows must agree"
  );
});
