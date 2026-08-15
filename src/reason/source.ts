import { getConfig, type Config } from "../config.js";
import { loadAll, screenKeys } from "../artifacts.js";
import { RouteMap } from "../code/route-map.js";
import { blastRadiusQueries, edgeConfidence as graphEdgeConfidence } from "../graph/queries.js";
import type { AffectedCode } from "../types.js";

/**
 * The blast-radius seam: one interface, two adapters.
 *
 * - GraphAdapter (mode "graph")      — Neo4j traversal; full symbol, screen,
 *   flow, requirement and absence results (requires the connect stage).
 * - ArtifactAdapter (mode "artifacts") — in-memory traversal over the
 *   committed artifacts; computes the same files/symbols/screens/flows sets,
 *   and honestly returns empty for the graph-only sections (requirements,
 *   coverage, absence, confidence).
 *
 * Every caller reasons through this seam; nothing else constructs Neo4j
 * screen keys or re-implements the traversal.
 */
export interface BlastRadiusSource {
  readonly mode: "graph" | "artifacts";
  computeAffected(changedPaths: string[]): Promise<AffectedCode>;
  edgeConfidence(reqKeys: string[]): Promise<{ avg: number; n: number }>;
}

/**
 * The seam function: takes changed paths and a source, returns the affected
 * set. Callers never branch on which adapter they hold.
 */
export async function computeBlastRadius(
  changedPaths: string[],
  source: BlastRadiusSource
): Promise<AffectedCode> {
  const affected = await source.computeAffected(changedPaths);
  affected.files = [...new Set(affected.files)];
  affected.symbols = [...new Set(affected.symbols)];
  affected.upstreamSymbols = [...new Set(affected.upstreamSymbols)];
  return affected;
}

/** Neo4j adapter — the full-pipeline source of truth. */
export function graphSource(cfg: Config = getConfig()): BlastRadiusSource {
  return {
    mode: "graph",
    computeAffected: (changedPaths) => blastRadiusQueries(changedPaths),
    edgeConfidence: (reqKeys) => graphEdgeConfidence(reqKeys),
  };
}

// ------------------------------------------------------- artifact adapter

/** In-memory traversal over committed artifacts. Mirrors graph/queries.ts. */
export function artifactSource(cfg: Config = getConfig()): BlastRadiusSource {
  const { crawl, code } = loadAll(cfg);
  const changedFilesOf = (paths: string[]) => {
    const codePaths = new Set(code.files.map((f) => f.path));
    return paths.filter((p) => codePaths.has(p));
  };

  return {
    mode: "artifacts",
    computeAffected: async (changedPaths): Promise<AffectedCode> => {
      const paths = changedFilesOf(changedPaths);
      const affected: AffectedCode = {
        files: [...paths],
        symbols: [],
        upstreamSymbols: [],
        flows: [],
        screens: [],
        reqs: [],
        losingCoverage: [],
        uncovered: [],
      };
      const files = new Set(affected.files);

      // --- file-level incoming closure over RENDERS|CALLS edges: a file that
      // renders or calls a symbol defined in an affected file is itself
      // affected. Depth-capped, exactly as the graph traversal does it.
      const edges: Array<{
        fromFile: string;
        toFile: string;
        fromName: string;
        toName: string;
      }> = [
        ...code.renders.map((e) => ({
          fromFile: e.fromFile,
          toFile: e.toFile,
          fromName: e.fromComponent,
          toName: e.toComponent,
        })),
        ...code.calls.map((e) => ({
          fromFile: e.fromFile,
          toFile: e.toFile,
          fromName: e.fromSymbol,
          toName: e.toSymbol,
        })),
      ];
      for (let depth = 0; depth < 6; depth++) {
        let added = 0;
        for (const e of edges) {
          if (e.toFile === e.fromFile) continue;
          if (files.has(e.toFile) && !files.has(e.fromFile)) {
            files.add(e.fromFile);
            added++;
          }
        }
        if (added === 0) break;
      }

      // --- symbol-level closure: symbols defined in the CHANGED files (not the
      // closure — the graph traversal seeds from changed files only), plus
      // everything that (transitively, <= 6 hops) renders or calls them.
      const changedSymbols = new Set<string>();
      for (const f of code.files) {
        if (!paths.includes(f.path)) continue;
        for (const n of f.symbols.map((s) => s.name)) {
          changedSymbols.add(symKey(f.path, n));
        }
      }
      const upstream = new Set<string>();
      const upstreamFiles = new Set<string>();
      const visited = new Set<string>();
      let frontier = [...changedSymbols];
      for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
        const next = new Set<string>();
        for (const key of frontier) {
          if (visited.has(key)) continue;
          visited.add(key);
          for (const e of edges) {
            if (e.toFile === e.fromFile) continue;
            if (symKey(e.toFile, e.toName) !== key) continue;
            const fromKey = symKey(e.fromFile, e.fromName);
            if (visited.has(fromKey)) continue;
            upstream.add(e.fromName);
            upstreamFiles.add(e.fromFile);
            next.add(fromKey);
          }
        }
        frontier = [...next];
      }
      affected.symbols = [...changedSymbols].map((k) => k.split("::").at(-1) ?? "");
      affected.upstreamSymbols = [...upstream];
      for (const f of upstreamFiles) files.add(f);

      // --- screens at risk: route files that render affected components
      const routeMap = RouteMap.fromModel(code);
      const keys = screenKeys(cfg.repoFullName, crawl); // keys[i] <-> crawl.screens[i]
      const affectedScreens = crawl.screens.filter((s) => {
        const resolved = routeMap.resolve(new URL(s.url).pathname);
        return resolved ? files.has(resolved.filePath) : false;
      });
      const keyOf = (screenId: string) =>
        keys[crawl.screens.findIndex((s) => s.screenId === screenId)] ?? "";
      affected.screens = affectedScreens.map((s) => ({
        key: keyOf(s.screenId),
        url: s.url,
        label: s.label,
      }));

      // --- flows: navigation edges touching affected screens (either endpoint
      // at risk — mirrors graph/queries.ts).
      const riskUrls = new Set(affectedScreens.map((s) => s.url));
      const labelOf = (url: string) =>
        crawl.screens.find((s) => s.url === url)?.label || url;
      const keysByUrl = new Map<string, string>();
      for (const s of crawl.screens) {
        keysByUrl.set(s.url, keyOf(s.screenId));
      }
      for (const t of crawl.transitions) {
        if (!riskUrls.has(t.fromUrl) && !riskUrls.has(t.toUrl)) continue;
        affected.flows.push({
          from: keysByUrl.get(t.fromUrl) ?? "",
          to: keysByUrl.get(t.toUrl) ?? "",
          fromLabel: labelOf(t.fromUrl),
          toLabel: labelOf(t.toUrl),
        });
      }

      affected.files = [...files];
      return affected;
    },
    // graph-only: requires the connect stage
    edgeConfidence: async () => ({ avg: 0, n: 0 }),
  };
}

function symKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}
