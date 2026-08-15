import type { CodeModel, RouteMapping } from "../types.js";

/**
 * Next.js app-router mapping: `app/product/[handle]/page.tsx` -> `/product/[handle]`.
 * Only page.tsx files are routes.
 */
export function appRouterRoute(filePath: string): string | null {
  const m = filePath.match(/^app\/(.+)\.(tsx|ts|js|jsx)$/);
  if (!m) return null;
  if (!m[1].endsWith("/page")) return null;
  const route = m[1].slice(0, -"/page".length);
  return "/" + route;
}

/** True if the URL path matches a route pattern like /product/[handle]. */
function routeMatches(pattern: string, urlPath: string): boolean {
  const pParts = pattern.split("/").filter(Boolean);
  const uParts = urlPath.split("/").filter(Boolean);
  if (pParts.length !== uParts.length) return false;
  for (let i = 0; i < pParts.length; i++) {
    const pp = pParts[i];
    const up = uParts[i];
    if (pp.startsWith("[") && pp.endsWith("]")) continue;
    if (pp !== up) return false;
  }
  return true;
}

export interface ResolvedRoute {
  filePath: string;
  routePattern: string;
}

const dynamicSegments = (p: string) => (p.match(/\[/g) ?? []).length;

/**
 * The "which file renders this URL" map. Built once from the code model;
 * every caller resolves through it instead of re-walking file paths and
 * re-implementing the matcher.
 *
 * Priority is decided at build time: static segments beat dynamic ones
 * (`app/[page]/page.tsx` -> "/[page]" and `app/search/page.tsx` -> "/search"
 * both match "/search", Next.js prefers the static route), and longer
 * patterns beat shorter ones.
 */
export class RouteMap {
  private constructor(private readonly routes: RouteMapping[]) {}

  static fromModel(model: Pick<CodeModel, "files">): RouteMap {
    return RouteMap.fromFiles(model.files);
  }

  static fromFiles(files: Array<{ path: string }>): RouteMap {
    const routes: RouteMapping[] = [];
    for (const f of files) {
      const routePattern = appRouterRoute(f.path);
      if (routePattern) routes.push({ filePath: f.path, routePattern });
    }
    routes.sort(
      (a, b) =>
        dynamicSegments(a.routePattern) - dynamicSegments(b.routePattern) ||
        b.routePattern.length - a.routePattern.length
    );
    return new RouteMap(routes);
  }

  get size(): number {
    return this.routes.length;
  }

  /** The file that renders a URL path, or null if no route matches. */
  resolve(urlPath: string): ResolvedRoute | null {
    for (const r of this.routes) {
      if (routeMatches(r.routePattern, urlPath)) return r;
    }
    return null;
  }
}
