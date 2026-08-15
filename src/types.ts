export interface InteractiveElement {
  ref: string;
  role: string;
  name: string;
  href?: string;
  inputType?: string;
  placeholder?: string;
}

export interface ScreenTransition {
  fromUrl: string;
  toUrl: string;
  action: string;
  elementText?: string;
  elementRef?: string;
}

export interface Screen {
  screenId: string;
  url: string;
  title: string;
  label: string;
  purpose: string;
  primaryActions: string[];
  keyComponents: string[];
  elements: InteractiveElement[];
  screenshotPath: string;
  snapshotPath: string;
  visited: boolean;
}

export interface CrawlArtifacts {
  baseUrl: string;
  screens: Screen[];
  transitions: ScreenTransition[];
  generatedAt: string;
}

export interface Requirement {
  reqId: string;
  title: string;
  description: string;
  userAction: string;
  expectedOutcome: string;
  sourceAnchor: string;
  priority: string;
}

export interface SymbolNode {
  name: string;
  kind: "function" | "component" | "class" | "method";
  filePath: string;
  line: number;
  exported: boolean;
}

export interface ImportEdge {
  fromFile: string;
  toFile: string;
  importedName: string;
}

export interface RenderEdge {
  fromComponent: string;
  toComponent: string;
  fromFile: string;
  toFile: string;
}

export interface CallEdge {
  fromSymbol: string;
  toSymbol: string;
  fromFile: string;
  toFile: string;
}

export interface FileNode {
  path: string;
  language: string;
  loc: number;
  symbols: SymbolNode[];
  imports: string[];
}

export interface CodeModel {
  fullName: string;
  ref: string;
  files: FileNode[];
  imports: ImportEdge[];
  renders: RenderEdge[];
  calls: CallEdge[];
}

export interface RouteMapping {
  filePath: string;
  routePattern: string; // e.g. /product/[handle]
}

/** A crawl screen with its resolved route (built by the screens writer). */
export interface ScreenWrite {
  screenId: string;
  url: string;
  title: string;
  label: string;
  purpose: string;
  route: string | null;
}

export interface CrossLayerLink {
  reqId: string;
  screenIds: string[];
  filePaths: string[];
  confidence: number;
}

export interface BlastRadius {
  prNumber: number;
  prTitle: string;
  changedFiles: string[];
  affectedFiles: string[];
  affectedComponents: string[];
  affectedScreens: string[];
  affectedFlows: string[][];
  requirementsAtRisk: string[];
  requirementsLosingCoverage: string[];
  uncoveredRequirements: string[];
  report: string;
}

/**
 * Result of the deterministic blast-radius traversal. Produced by both
 * adapters behind the BlastRadiusSource seam: the Neo4j traversal and the
 * in-memory artifacts traversal.
 */
export interface AffectedCode {
  files: string[]; // changed files + files that depend on them (incoming closure)
  symbols: string[]; // symbols defined in changed files
  upstreamSymbols: string[]; // symbols that (transitively) render/call the changed symbols
  flows: Array<{ from: string; to: string; fromLabel: string; toLabel: string }>;
  screens: Array<{ key: string; url: string; label: string }>;
  reqs: Array<{ key: string; reqId: string; title: string; via: string }>;
  losingCoverage: Array<{ key: string; reqId: string; title: string }>;
  uncovered: Array<{ reqId: string; title: string }>;
}
