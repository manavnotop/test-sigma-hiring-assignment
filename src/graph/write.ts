import type { CodeModel, CrawlArtifacts, Requirement, ScreenWrite } from "../types.js";
import { RouteMap } from "../code/route-map.js";
import { fileKey, repoKey, reqKey, screenKey, symbolKey, withSession } from "./client.js";
import { proposeMappings, resolveMappings, writeMappings } from "./mappings.js";

export interface LayerStats {
  files: number;
  symbols: number;
  requirements: number;
  screens: number;
  transitions: number;
  renderEdges: number;
  callEdges: number;
  importEdges: number;
  coveredByUi: string[];
  implementedInCode: string[];
  uncovered: string[];
}

// ---------------------------------------------------------------- code layer

export async function writeCodeLayer(fullName: string, model: CodeModel): Promise<void> {
  const repo = repoKey(fullName);
  await withSession(async (s) => {
    await s.run(
      `MERGE (r:Repo {full_name: $repo}) SET r.ref = $ref`,
      { repo, ref: model.ref }
    );

    const fileRows = model.files.map((f) => ({
      key: fileKey(fullName, f.path),
      path: f.path,
      language: f.language,
      loc: f.loc,
    }));
    await s.run(
      `UNWIND $rows AS r
       MERGE (f:File {key: r.key})
       SET f.full_name = $repo, f.path = r.path, f.language = r.language, f.loc = r.loc
       WITH r, f
       MATCH (repo:Repo {full_name: $repo})
       MERGE (repo)-[:CONTAINS]->(f)`,
      { repo, rows: fileRows }
    );

    const symRows = model.files.flatMap((f) =>
      f.symbols.map((sy) => ({
        key: symbolKey(fullName, f.path, sy.name),
        name: sy.name,
        kind: sy.kind,
        exported: sy.exported,
        fileKey: fileKey(fullName, f.path),
      }))
    );
    await s.run(
      `UNWIND $rows AS r
       MERGE (sy:Symbol {key: r.key})
       SET sy.full_name = $repo, sy.name = r.name, sy.kind = r.kind, sy.exported = r.exported
       WITH r, sy
       MATCH (f:File {key: r.fileKey})
       MERGE (f)-[:DEFINES]->(sy)`,
      { repo, rows: symRows }
    );

    const importRows = model.imports.map((e) => ({
      from: fileKey(fullName, e.fromFile),
      to: fileKey(fullName, e.toFile),
      name: e.importedName,
    }));
    await s.run(
      `UNWIND $rows AS r
       MATCH (a:File {key: r.from}), (b:File {key: r.to})
       MERGE (a)-[:IMPORTS {name: r.name}]->(b)`,
      { rows: importRows }
    );

    const renderRows = model.renders.map((e) => ({
      from: symbolKey(fullName, e.fromFile, e.fromComponent),
      to: symbolKey(fullName, e.toFile, e.toComponent),
    }));
    await s.run(
      `UNWIND $rows AS r
       MATCH (a:Symbol {key: r.from}), (b:Symbol {key: r.to})
       MERGE (a)-[:RENDERS]->(b)`,
      { rows: renderRows }
    );

    const callRows = model.calls.map((e) => ({
      from: symbolKey(fullName, e.fromFile, e.fromSymbol),
      to: symbolKey(fullName, e.toFile, e.toSymbol),
    }));
    await s.run(
      `UNWIND $rows AS r
       MATCH (a:Symbol {key: r.from}), (b:Symbol {key: r.to})
       MERGE (a)-[:CALLS]->(b)`,
      { rows: callRows }
    );
  });
}

// ------------------------------------------------------ requirements + screens

export async function writeRequirementsLayer(
  fullName: string,
  requirements: Requirement[]
): Promise<void> {
  const repo = repoKey(fullName);
  await withSession(async (s) => {
    await s.run(
      `MERGE (r:Repo {full_name: $repo})`,
      { repo }
    );
    const rows = requirements.map((r) => ({
      key: reqKey(fullName, r.reqId),
      reqId: r.reqId,
      title: r.title,
      userAction: r.userAction,
      expectedOutcome: r.expectedOutcome,
      priority: r.priority,
      sourceAnchor: r.sourceAnchor,
    }));
    await s.run(
      `UNWIND $rows AS r
       MERGE (req:Requirement {key: r.key})
       SET req.full_name = $repo,
           req.req_id = r.reqId,
           req.title = r.title,
           req.user_action = r.userAction,
           req.expected_outcome = r.expectedOutcome,
           req.priority = r.priority,
           req.source_anchor = r.sourceAnchor
       WITH r, req
       MATCH (repo:Repo {full_name: $repo})
       MERGE (repo)-[:SPECIFIES]->(req)`,
      { repo, rows }
    );
  });
}

export async function writeScreensLayer(
  fullName: string,
  crawl: CrawlArtifacts,
  routeMap: RouteMap
): Promise<ScreenWrite[]> {
  const repo = repoKey(fullName);
  const writes: ScreenWrite[] = crawl.screens.map((s) => {
    const urlPath = new URL(s.url).pathname;
    const resolved = routeMap.resolve(urlPath);
    return {
      screenId: s.screenId,
      url: s.url,
      title: s.title,
      label: s.label,
      purpose: s.purpose,
      route: resolved?.routePattern ?? null,
    };
  });

  await withSession(async (s) => {
    await s.run(`MERGE (r:Repo {full_name: $repo})`, { repo });
    const rows = writes.map((w) => ({
      key: screenKey(fullName, w.screenId),
      url: w.url,
      title: w.title,
      label: w.label,
      purpose: w.purpose,
      route: w.route,
    }));
    await s.run(
      `UNWIND $rows AS r
       MERGE (sc:Screen {key: r.key})
       SET sc.full_name = $repo, sc.url = r.url, sc.title = r.title,
           sc.label = r.label, sc.purpose = r.purpose, sc.route = r.route
       WITH r, sc
       MATCH (repo:Repo {full_name: $repo})
       MERGE (repo)-[:HAS_SCREEN]->(sc)`,
      { repo, rows }
    );

    // deterministic screen relationships from real navigation events
    const edgeRows: Array<{ from: string; to: string }> = [];
    for (const t of crawl.transitions) {
      const from = crawl.screens.find((s) => s.url === t.fromUrl);
      const to = crawl.screens.find((s) => s.url === t.toUrl);
      if (from && to && from.screenId !== to.screenId) {
        edgeRows.push({ from: screenKey(fullName, from.screenId), to: screenKey(fullName, to.screenId) });
      }
    }
    await s.run(
      `UNWIND $rows AS r
       MATCH (a:Screen {key: r.from}), (b:Screen {key: r.to})
       MERGE (a)-[:NAVIGATES_TO]->(b)`,
      { rows: edgeRows }
    );

    // deterministic route-based screen -> file edges
    const renderedRows: Array<{ screen: string; file: string }> = [];
    for (const w of writes) {
      if (!w.route) continue;
      const resolved = routeMap.resolve(new URL(w.url).pathname);
      if (resolved) renderedRows.push({ screen: screenKey(fullName, w.screenId), file: fileKey(fullName, resolved.filePath) });
    }
    await s.run(
      `UNWIND $rows AS r
       MATCH (sc:Screen {key: r.screen}), (f:File {key: r.file})
       MERGE (sc)-[:RENDERED_BY]->(f)`,
      { rows: renderedRows }
    );
  });

  return writes;
}

// ------------------------------------------------------------------- connect

/**
 * Connect stage: one bounded LLM call proposes links (Proposer adapter);
 * the deterministic resolver whitelists and clamps them; the Writer adapter
 * writes COVERED_BY / IMPLEMENTED_BY edges and CoverageGap absence nodes.
 * The resolver and writer are pure/isolated in graph/mappings.ts — no live
 * Neo4j or LLM needed to test them.
 */
export async function connectLayers(
  fullName: string,
  requirements: Requirement[],
  screens: ScreenWrite[],
  model: CodeModel
): Promise<LayerStats> {
  const filePaths = new Set(model.files.map((f) => f.path));

  const proposed = await proposeMappings(requirements, screens, filePaths);
  const resolved = resolveMappings(fullName, requirements, screens, proposed, filePaths);
  await writeMappings(fullName, resolved);

  const uncovered = requirements
    .filter((r) => !resolved.coveredIds.has(r.reqId))
    .map((r) => r.reqId);
  const stats: LayerStats = {
    files: model.files.length,
    symbols: model.files.reduce((a, f) => a + f.symbols.length, 0),
    requirements: requirements.length,
    screens: screens.length,
    transitions: 0,
    renderEdges: model.renders.length,
    callEdges: model.calls.length,
    importEdges: model.imports.length,
    coveredByUi: [...resolved.coveredIds].sort(),
    implementedInCode: [...resolved.implementedIds].sort(),
    uncovered: [...uncovered].sort(),
  };
  return stats;
}
