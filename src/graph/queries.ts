import { withSession } from "./client.js";
import { getConfig } from "../config.js";
import type { AffectedCode } from "../types.js";

/**
 * Deterministic blast-radius traversal over the knowledge graph. The caller
 * provides changed file paths only — screen keys are derived here from the
 * committed crawl artifacts, so key-format knowledge stays out of callers.
 */
export async function blastRadiusQueries(changedFiles: string[]): Promise<AffectedCode> {
  const cfg = getConfig();
  const repo = cfg.repoFullName;
  const affected: AffectedCode = {
    files: [...changedFiles],
    symbols: [],
    upstreamSymbols: [],
    flows: [],
    screens: [],
    reqs: [],
    losingCoverage: [],
    uncovered: [],
  };

  await withSession(async (s) => {
    // 1. symbols defined in changed files, plus everything that (transitively)
    //    renders or calls them: a change to X risks the things that depend on X,
    //    not the things X depends on. Depth-capped so shared components don't
    //    flood the set. Self-referential render/call loops (a component
    //    "rendering" itself, an artifact of the local-use model) carry no
    //    blast radius and are excluded — the artifact adapter does the same.
    const r1a = await s.run(
      `MATCH (repo:Repo {full_name:$repo})-[:CONTAINS]->(f:File)
       WHERE f.path IN $paths
       OPTIONAL MATCH (f)-[:DEFINES]->(s:Symbol)
       RETURN f.path AS file, collect(DISTINCT s.name) AS syms`,
      { repo, paths: changedFiles }
    );
    const r1b = await s.run(
      `MATCH (repo:Repo {full_name:$repo})-[:CONTAINS]->(f:File)
       WHERE f.path IN $paths
       MATCH (f)-[:DEFINES]->(s:Symbol)
       OPTIONAL MATCH (s)<-[:RENDERS|CALLS*1..6]-(s2:Symbol)
       WHERE s2 <> s
       OPTIONAL MATCH (s2)<-[:DEFINES]-(f2:File)
       RETURN f.path AS file,
              collect(DISTINCT s2.name) AS upstream,
              collect(DISTINCT f2.path) AS upstreamFiles`,
      { repo, paths: changedFiles }
    );
    for (const row of r1a.records) {
      const syms = (row.get("syms") ?? []) as string[];
      affected.symbols.push(...syms.filter(Boolean));
    }
    for (const row of r1b.records) {
      const upstream = (row.get("upstream") ?? []) as string[];
      const upstreamFiles = (row.get("upstreamFiles") ?? []) as string[];
      affected.upstreamSymbols.push(...upstream.filter(Boolean));
      for (const df of upstreamFiles) {
        if (df && !affected.files.includes(df)) affected.files.push(df);
      }
    }

    // 2. screens at risk: route files that render changed/affected components
    const r2 = await s.run(
      `MATCH (sc:Screen)-[:RENDERED_BY]->(f:File)
       WHERE f.path IN $paths
       RETURN DISTINCT sc.key AS key, sc.url AS url, sc.label AS label`,
      { paths: affected.files }
    );
    for (const row of r2.records) {
      affected.screens.push({
        key: row.get("key"),
        url: row.get("url") ?? "",
        label: row.get("label") ?? "",
      });
    }

    // 3. flows: navigation edges touching affected screens (either endpoint
    //    at risk); the report further narrows to both-endpoints-at-risk.
    const r3 = await s.run(
      `MATCH (a:Screen)-[:NAVIGATES_TO]->(b:Screen)
       WHERE a.key IN $screens OR b.key IN $screens
       RETURN a.key AS from, b.key AS to, a.label AS fromLabel, b.label AS toLabel`,
      { screens: affected.screens.map((x) => x.key) }
    );
    for (const row of r3.records) {
      affected.flows.push({
        from: row.get("from"),
        to: row.get("to"),
        fromLabel: row.get("fromLabel") ?? "",
        toLabel: row.get("toLabel") ?? "",
      });
    }

    // 4. requirements at risk (implemented by an affected file OR covered by an
    //    affected screen). Aggregated: one row per requirement, not per edge —
    //    a requirement with N links must not appear N times in the report.
    const r4 = await s.run(
      `MATCH (r:Requirement)
       OPTIONAL MATCH (r)-[:IMPLEMENTED_BY]->(f:File)
       OPTIONAL MATCH (r)-[:COVERED_BY]->(sc:Screen)
       WITH r, collect(DISTINCT f.path) AS viaFiles, collect(DISTINCT sc.url) AS viaScreens
       WHERE any(p IN viaFiles WHERE p IN $files) OR any(k IN viaScreens WHERE k IN $screens)
       RETURN r.key AS key, r.req_id AS reqId, r.title AS title, viaFiles, viaScreens`,
      { files: affected.files, screens: affected.screens.map((x) => x.key) }
    );
    for (const row of r4.records) {
      const viaFiles = (row.get("viaFiles") ?? []) as string[];
      const viaScreens = (row.get("viaScreens") ?? []) as string[];
      const affectedFile = viaFiles.find((p) => affected.files.includes(p));
      const via = affectedFile
        ? `file ${affectedFile}`
        : `screen ${viaScreens[0] ?? "?"}`;
      affected.reqs.push({
        key: row.get("key"),
        reqId: row.get("reqId"),
        title: row.get("title"),
        via,
      });
    }

    // 5. requirements that LOSE coverage: every covered-by screen is at risk
    const r5 = await s.run(
      `MATCH (r:Requirement)-[:COVERED_BY]->(sc:Screen)
       WITH r, collect(sc.key) AS screens
       WHERE all(k IN screens WHERE k IN $screens)
       RETURN DISTINCT r.key AS key, r.req_id AS reqId, r.title AS title`,
      { screens: affected.screens.map((x) => x.key) }
    );
    for (const row of r5.records) {
      affected.losingCoverage.push({
        key: row.get("key"),
        reqId: row.get("reqId"),
        title: row.get("title"),
      });
    }

    // 6. absence: requirements with no captured UI at all
    const r6 = await s.run(
      `MATCH (r:Requirement)-[:MISSING_UI_COVERAGE]->(:CoverageGap)
       RETURN r.req_id AS reqId, r.title AS title`
    );
    for (const row of r6.records) {
      affected.uncovered.push({ reqId: row.get("reqId"), title: row.get("title") });
    }
  });

  affected.symbols = [...new Set(affected.symbols)];
  affected.upstreamSymbols = [...new Set(affected.upstreamSymbols)];
  affected.files = [...new Set(affected.files)];
  return affected;
}

/** Average confidence over the cross-layer links of the given requirements. */
export async function edgeConfidence(
  reqKeys: string[]
): Promise<{ avg: number; n: number }> {
  if (reqKeys.length === 0) return { avg: 0, n: 0 };
  const res = await withSession(async (s) => {
    const r = await s.run(
      `MATCH (r:Requirement)-[e:COVERED_BY|IMPLEMENTED_BY]->()
       WHERE r.key IN $keys AND e.confidence IS NOT NULL
       RETURN avg(e.confidence) AS avgConf, count(e) AS n`,
      { keys: reqKeys }
    );
    return r.records[0];
  });
  return {
    avg: Number(res?.get("avgConf") ?? 0),
    n: Number(res?.get("n") ?? 0),
  };
}
