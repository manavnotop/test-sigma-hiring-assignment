import type {
  CallEdge,
  CodeModel,
  FileNode,
  ImportEdge,
  RenderEdge,
  SymbolNode,
} from "../types.js";
import { fetchRepoTarball } from "../github/api.js";
import { initTreeSitter, languageForPath, parseFile, resolveImportCandidates } from "./ts-parser.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export async function buildCodeModel(
  fullName: string,
  ref: string
): Promise<CodeModel> {
  await initTreeSitter();

  const repo = await fetchRepoTarball(fullName, ref, (p) => {
    const ext = p.slice(p.lastIndexOf("."));
    return SOURCE_EXTENSIONS.has(ext);
  });

  const parsed = new Map<string, NonNullable<ReturnType<typeof parseFile>>>();
  for (const [path, source] of repo.files) {
    const p = parseFile(path, source);
    if (p) parsed.set(path, p);
  }

  // --- files -----------------------------------------------------------------
  const files: FileNode[] = [];
  const symbolsByFile = new Map<string, SymbolNode[]>();
  for (const [path, p] of parsed) {
    const symbols: SymbolNode[] = p.symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      filePath: path,
      line: s.line,
      exported: s.exported,
    }));
    symbolsByFile.set(path, symbols);
    files.push({
      path,
      language: languageForPath(path) ?? "unknown",
      loc: p.loc,
      symbols,
      imports: p.imports.map((i) => i.module),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // --- import edges (file -> file) -------------------------------------------
  const importEdges: ImportEdge[] = [];
  const symbolOwners = new Map<string, string>(); // symbolName -> file (best-effort single owner)
  for (const [path, p] of parsed) {
    for (const sym of symbolsByFile.get(path) ?? []) {
      if (sym.exported) symbolOwners.set(sym.name, path);
    }
  }

  for (const [fromFile, p] of parsed) {
    for (const imp of p.imports) {
      const candidates = resolveImportCandidates(fromFile, imp.module);
      if (!candidates) continue; // external package
      const toFile = candidates.find((c) => parsed.has(c));
      if (toFile) {
        importEdges.push({
          fromFile,
          toFile,
          importedName: imp.names.join(",") || "*",
        });
      }
    }
  }

  // --- render edges (component -> component) ---------------------------------
  const renderEdges: RenderEdge[] = [];
  const seenRender = new Set<string>();
  const fileSymbolNames = new Map<string, Set<string>>();
  for (const [path, syms] of symbolsByFile) {
    fileSymbolNames.set(path, new Set(syms.map((s) => s.name)));
  }

  const importTarget = new Map<string, string>(); // file -> importedName -> target file
  for (const [fromFile, p] of parsed) {
    for (const imp of p.imports) {
      const candidates = resolveImportCandidates(fromFile, imp.module);
      if (!candidates) continue;
      const toFile = candidates.find((c) => parsed.has(c));
      if (!toFile) continue;
      for (const name of imp.names) importTarget.set(`${fromFile}::${name}`, toFile);
    }
  }

  for (const [fromFile, p] of parsed) {
    for (const used of p.jsxUses) {
      const local = fileSymbolNames.get(fromFile)?.has(used);
      let toFile = fromFile;
      if (!local) {
        const target = importTarget.get(`${fromFile}::${used}`);
        if (!target) continue; // external component or DOM element
        toFile = target;
      }
      const key = `${fromFile}::${used}`;
      if (seenRender.has(key)) continue;
      seenRender.add(key);
      renderEdges.push({ fromComponent: used, toComponent: used, fromFile, toFile });
    }
  }

  // --- call edges (symbol -> symbol, resolved via local defs + imports) -------
  const callEdges: CallEdge[] = [];
  const seenCall = new Set<string>();
  const defsByFile = new Map<string, Map<string, string>>(); // file -> name -> name
  for (const [path, p] of parsed) {
    const names = new Map<string, string>();
    for (const s of symbolsByFile.get(path) ?? []) names.set(s.name, s.name);
    defsByFile.set(path, names);
  }

  for (const [fromFile, p] of parsed) {
    for (const called of p.calls) {
      if (called === "fetch" || called === "console" || called === "require") continue;
      const local = defsByFile.get(fromFile)?.has(called);
      let toFile = fromFile;
      if (!local) {
        const target = importTarget.get(`${fromFile}::${called}`);
        if (!target) continue;
        toFile = target;
        if (!defsByFile.get(toFile)?.has(called)) continue;
      }
      const key = `${fromFile}::${toFile}::${called}`;
      if (seenCall.has(key)) continue;
      seenCall.add(key);
      callEdges.push({
        fromSymbol: called,
        toSymbol: called,
        fromFile,
        toFile,
      });
    }
  }

  return {
    fullName,
    ref,
    files,
    imports: importEdges,
    renders: renderEdges,
    calls: callEdges,
  };
}
