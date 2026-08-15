import { withSession } from "./client.js";
import { fileKey, reqKey, screenKey } from "./client.js";
import { completeReason, extractJson } from "../llm.js";
import type { Requirement, ScreenWrite } from "../types.js";

export interface MappingEntry {
  reqId: string;
  screens: Array<{ name: string; confidence: number }>;
  files: Array<{ path: string; confidence: number }>;
}

export interface ResolvedMappings {
  coverRels: Array<{ req: string; screen: string; confidence: number }>;
  implRels: Array<{ req: string; file: string; confidence: number }>;
  coveredIds: Set<string>;
  implementedIds: Set<string>;
  uncoveredIds: string[];
}

export const MAP_SYSTEM = `You connect product requirements to the UI screens that satisfy them and the code files that implement them.

For EACH requirement, list:
- screens: the captured screens that a user would visit to exercise this requirement. Reference each screen by its EXACT label or EXACT url — one of the two strings verbatim, nothing added, no parentheses, no extra words. EMPTY if no captured screen covers it — that is a real and important answer ("absence").
- files: repo file paths (as listed, verbatim) that most likely implement it. EMPTY if none.

Only use exact names/paths from the provided lists. Be conservative: when unsure, leave the list empty rather than guessing. Respond with ONLY JSON:
{"mappings":[{"reqId":"R1","screens":[{"name":"<exact label or url>","confidence":0.9}],"files":[{"path":"<exact path>","confidence":0.8}]}]}
confidence ∈ [0,1] reflects how sure you are that the link is real.`;

/**
 * Proposer adapter — the LLM call that proposes links. Bounded: one call,
 * whitelisted names only (enforced by the resolver downstream). Degraded
 * mode: any failure returns no proposals, and the resolver's absence
 * defaulting still applies.
 */
export async function proposeMappings(
  requirements: Requirement[],
  screens: ScreenWrite[],
  filePaths: Set<string>
): Promise<MappingEntry[]> {
  const reqLines = requirements
    .map((r) => `- ${r.reqId}: ${r.title} | user: ${r.userAction} -> ${r.expectedOutcome}`)
    .join("\n");
  const screenLines =
    screens.map((s) => `- ${s.label || s.title || s.url} (${s.url})`).join("\n") ||
    "(no screens captured)";
  const fileLines = [...filePaths].slice(0, 300).join("\n");
  try {
    const raw = await completeReason(
      MAP_SYSTEM,
      `Requirements:\n${reqLines}\n\nCaptured screens:\n${screenLines}\n\nCode files:\n${fileLines}`,
      undefined,
      "connect.mapping"
    );
    const data = extractJson(raw) as { mappings?: MappingEntry[] };
    return data.mappings ?? [];
  } catch (e) {
    console.log(`  [connect] mapping LLM call failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Deterministic core of the Connect stage: takes proposed (possibly
 * hallucinated) links and resolves them against the whitelist — exact
 * label/url, "label (url)" echoes, url inside text, then fuzzy token overlap
 * — clamps confidence, and defaults absence to a CoverageGap. Pure: no Neo4j,
 * no LLM, fully testable in isolation.
 */
export function resolveMappings(
  fullName: string,
  requirements: Requirement[],
  screens: ScreenWrite[],
  mappings: MappingEntry[],
  filePaths: Set<string>
): ResolvedMappings {
  const byReq = new Map<string, MappingEntry>();
  for (const m of mappings) byReq.set(m.reqId, m);

  // --- whitelist: every resolvable name maps to a real screen id ------------
  const screenByName = new Map<string, string>();
  for (const s of screens) {
    for (const name of [s.label, s.title, s.url]) {
      if (name) screenByName.set(name.trim(), s.screenId);
    }
  }

  const normTokens = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const overlap = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 || b.size === 0) return 0;
    const inter = [...a].filter((x) => b.has(x)).length;
    return inter / Math.max(a.size, b.size);
  };
  const resolveScreen = (raw: string): string | null => {
    const trimmed = raw.trim();
    const direct = screenByName.get(trimmed);
    if (direct) return direct;
    const parens = trimmed.match(/\(([^)]+)\)\s*$/);
    if (parens) {
      const urlKey = screenByName.get(parens[1].trim());
      if (urlKey) return urlKey;
      const bare = trimmed.slice(0, trimmed.lastIndexOf("(")).trim();
      const bareKey = screenByName.get(bare);
      if (bareKey) return bareKey;
    }
    let urlBestKey: string | null = null;
    let urlBestLen = 0;
    for (const [k, v] of screenByName) {
      if (!k.startsWith("http") || !trimmed.includes(k)) continue;
      if (k.length > urlBestLen) {
        urlBestLen = k.length;
        urlBestKey = v;
      }
    }
    if (urlBestKey) return urlBestKey; // longest url key wins (avoids prefix matches)
    const want = normTokens(trimmed);
    let best = 0;
    let bestKey: string | null = null;
    for (const [k, v] of screenByName) {
      if (k.startsWith("http")) continue;
      const score = overlap(want, normTokens(k));
      if (score > best) {
        best = score;
        bestKey = v;
      }
    }
    return best >= 0.6 ? bestKey : null;
  };

  const coveredIds = new Set<string>();
  const implementedIds = new Set<string>();
  const coverRels: ResolvedMappings["coverRels"] = [];
  const implRels: ResolvedMappings["implRels"] = [];

  for (const r of requirements) {
    const m = byReq.get(r.reqId);
    if (!m) continue;
    for (const c of m.screens) {
      const sid = resolveScreen(c.name);
      if (!sid) continue; // hallucinated name -> dropped
      const conf = Math.min(1, Math.max(0, c.confidence ?? 0.5));
      coverRels.push({ req: reqKey(fullName, r.reqId), screen: screenKey(fullName, sid), confidence: conf });
      coveredIds.add(r.reqId);
    }
    for (const f of m.files) {
      const path = f.path.trim();
      if (!filePaths.has(path)) continue; // hallucinated path -> dropped
      const conf = Math.min(1, Math.max(0, f.confidence ?? 0.5));
      implRels.push({ req: reqKey(fullName, r.reqId), file: fileKey(fullName, path), confidence: conf });
      implementedIds.add(r.reqId);
    }
  }

  return {
    coverRels,
    implRels,
    coveredIds,
    implementedIds,
    uncoveredIds: requirements.filter((r) => !coveredIds.has(r.reqId)).map((r) => r.reqId),
  };
}

/**
 * Writer adapter — Cypher writes for the resolved mappings, including the
 * first-class absence default (CoverageGap nodes for requirements with no
 * captured UI coverage).
 */
export async function writeMappings(
  fullName: string,
  resolved: ResolvedMappings
): Promise<void> {
  const repo = fullName;
  await withSession(async (s) => {
    await s.run(
      `UNWIND $rows AS r
       MATCH (a:Requirement {key: r.req}), (b:Screen {key: r.screen})
       MERGE (a)-[e:COVERED_BY]->(b)
       SET e.confidence = r.confidence`,
      { rows: resolved.coverRels }
    );
    await s.run(
      `UNWIND $rows AS r
       MATCH (a:Requirement {key: r.req}), (b:File {key: r.file})
       MERGE (a)-[e:IMPLEMENTED_BY]->(b)
       SET e.confidence = r.confidence`,
      { rows: resolved.implRels }
    );

    const gapRows = resolved.uncoveredIds.map((reqId) => ({
      key: `${reqKey(repo, reqId)}::gap`,
      req: reqKey(repo, reqId),
    }));
    await s.run(
      `UNWIND $rows AS r
       MERGE (g:CoverageGap {key: r.key})
       SET g.full_name = $repo,
           g.reason = 'requirement should be testable but no captured screen exercises it'
       WITH r, g
       MATCH (req:Requirement {key: r.req})
       MERGE (req)-[:MISSING_UI_COVERAGE]->(g)`,
      { repo, rows: gapRows }
    );
  });
}
