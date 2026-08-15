import { readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import type { ImportEdge, RenderEdge, SymbolNode } from "../types.js";

export type LanguageKind = "typescript" | "tsx" | "javascript";

interface LoadedParser {
  parser: Parser;
  kind: LanguageKind;
}

const cached: Partial<Record<LanguageKind, LoadedParser>> = {};

async function load(kind: LanguageKind): Promise<LoadedParser> {
  const existing = cached[kind];
  if (existing) return existing;
  const { readFile } = await import("node:fs/promises");
  let wasm: Buffer;
  switch (kind) {
    case "typescript":
      wasm = readFileSync(
        join(process.cwd(), "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm")
      );
      break;
    case "tsx":
      wasm = readFileSync(
        join(process.cwd(), "node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm")
      );
      break;
    default:
      wasm = readFileSync(
        join(process.cwd(), "node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm")
      );
  }
  const language = await Language.load(wasm as unknown as Uint8Array);
  const parser = new Parser();
  parser.setLanguage(language);
  const lp: LoadedParser = { parser, kind };
  cached[kind] = lp;
  return lp;
}

export function initTreeSitter(): Promise<void> {
  return loadAll();
}

async function loadAll(): Promise<void> {
  await Parser.init();
  for (const kind of ["tsx", "typescript", "javascript"] as const) {
    await load(kind);
  }
}

export function languageForPath(path: string): LanguageKind | null {
  const ext = extname(path);
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  return null;
}

interface RawFunction {
  name: string;
  kind: SymbolNode["kind"];
  line: number;
  exported: boolean;
}

export interface ParsedFile {
  path: string;
  loc: number;
  symbols: RawFunction[];
  imports: Array<{ module: string; names: string[]; isRelative: boolean }>;
  jsxUses: string[];
  calls: string[];
}

export function parseFile(path: string, source: string): ParsedFile | null {
  const kind = languageForPath(path);
  if (!kind) return null;
  return parseWith(kind, path, source);
}

function parseWith(kind: LanguageKind, path: string, source: string): ParsedFile | null {
  const lp = cached[kind] ?? loadSync(kind);
  const tree = lp.parser.parse(source);
  if (!tree) throw new Error(`parse failed for ${path}`);
  const root = tree.rootNode;

  const symbols = new Map<number, RawFunction>();
  const jsxUses = new Set<string>();
  const calls = new Set<string>();
  const imports: ParsedFile["imports"] = [];
  const exportedNames = new Set<string>();

  const allNodes: Node[] = [];
  walkAll(root, allNodes);

  for (const node of allNodes) {
    const type = node.type;
    if (type === "function_declaration") {
      const name = node.childForFieldName("name");
      if (!name) continue;
      symbols.set(node.startPosition.row + 1, {
        name: name.text,
        kind: "function",
        line: node.startPosition.row + 1,
        exported: false,
      });
    } else if (type === "class_declaration") {
      const name = node.childForFieldName("name");
      if (!name) continue;
      symbols.set(node.startPosition.row + 1, {
        name: name.text,
        kind: "class",
        line: node.startPosition.row + 1,
        exported: false,
      });
    } else if (type === "method_definition") {
      const name = node.childForFieldName("name");
      if (!name) continue;
      symbols.set(node.startPosition.row + 1, {
        name: name.text,
        kind: "method",
        line: node.startPosition.row + 1,
        exported: false,
      });
    } else if (
      type === "variable_declarator" &&
      (node.childForFieldName("value")?.type === "arrow_function" ||
        node.childForFieldName("value")?.type === "function_expression")
    ) {
      const name = node.childForFieldName("name");
      if (!name || name.type !== "identifier") continue;
      symbols.set(node.startPosition.row + 1, {
        name: name.text,
        kind: "function",
        line: node.startPosition.row + 1,
        exported: false,
      });
    } else if (type === "import_statement") {
      const src = node.childForFieldName("source");
      if (!src) continue;
      const module = src.text.replace(/['"]/g, "");
      const isRelative = module.startsWith(".") || module.startsWith("/");
      const names: string[] = [];
      for (const child of node.namedChildren) {
        if (child.type === "import_clause") {
          for (const spec of child.namedChildren) {
            if (spec.type === "import_specifier") {
              const nm = spec.childForFieldName("name");
              if (nm) names.push(nm.text);
            } else if (spec.type === "import_namespace_identifier" || spec.type === "identifier") {
              names.push(spec.text);
            }
          }
        }
      }
      imports.push({ module, names, isRelative });
    } else if (type === "jsx_opening_element" || type === "jsx_self_closing_element") {
      const name = node.childForFieldName("name");
      if (name && (name.type === "identifier" || name.type === "member_expression")) {
        const first = name.type === "member_expression" ? name.childForFieldName("object") : name;
        if (first && first.type === "identifier") jsxUses.add(first.text);
      }
    } else if (type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn && fn.type === "identifier") calls.add(fn.text);
    } else if (type === "export_statement") {
      const declNodes: Node[] = [];
      walkAll(node, declNodes);
      for (const d of declNodes) {
        if (d.type === "variable_declarator") {
          const name = d.childForFieldName("name");
          if (name && name.type === "identifier") exportedNames.add(name.text);
        } else if (d.type === "function_declaration" || d.type === "class_declaration") {
          const name = d.childForFieldName("name");
          if (name) exportedNames.add(name.text);
        }
      }
    }
  }

  for (const s of symbols.values()) {
    if (exportedNames.has(s.name)) s.exported = true;
  }

  return {
    path,
    loc: source.split("\n").length,
    symbols: [...symbols.values()],
    imports,
    jsxUses: [...jsxUses],
    calls: [...calls],
  };
}

function loadSync(kind: LanguageKind): LoadedParser {
  // synchronous fallback (parser already initialized by initTreeSitter)
  return cached[kind]!;
}

function walkAll(node: Node, acc: Node[]): void {
  acc.push(node);
  for (const child of node.children) walkAll(child, acc);
}

/**
 * Resolve an import to repo-relative candidate paths (ordered by preference),
 * or null when the import is external (npm package). The caller picks the first
 * candidate that actually exists in the file set.
 */
export function resolveImportCandidates(fromFile: string, module: string): string[] | null {
  let base: string;
  if (module.startsWith("./") || module.startsWith("../")) {
    base = join(dirname(fromFile), module);
  } else if (module.startsWith("/")) {
    base = module.slice(1);
  } else {
    // root-relative (baseUrl "."), e.g. "components/layout/footer"
    base = module;
  }
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.css`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const clean = normalize(c).replace(/\\/g, "/");
    if (clean.startsWith("/") || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}
