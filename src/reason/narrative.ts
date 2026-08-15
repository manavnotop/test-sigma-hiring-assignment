import { completeReason, extractJson, hasLlm } from "../llm.js";
import type { AffectedCode, CrawlArtifacts, Requirement } from "../types.js";

export interface Narrative {
  summary: string;
  whatToTest: string[];
  riskAreas: string[];
  notes: string[];
}

export interface NarrativeArgs {
  prTitle: string;
  prBody: string;
  prFiles: Array<{ filename: string; additions: number; deletions: number; patch: string }>;
  affected: AffectedCode;
  crawl: CrawlArtifacts;
  requirements: Requirement[];
}

/**
 * The narrative seam: deterministic evidence goes in, plain-language prose
 * comes out. Two adapters:
 * - LLM adapter — writes prose for a QA lead; the narrative may only restate
 *   the deterministic evidence, never add risks.
 * - Degraded adapter — no LLM key; returns the honest fallback so the report
 *   is still generated.
 */
export interface NarrativeWriter {
  synthesizeNarrative(args: NarrativeArgs): Promise<Narrative>;
}

const SYSTEM = `You are the narrative writer for a testing-intelligence system. A DETERMINISTIC knowledge-graph traversal has already computed the blast radius (screens, flows, requirements). You write the plain-language explanation a QA lead reads. Do NOT invent risks that are not in the evidence. Be honest about what the system could not see.`;

function userPrompt(args: NarrativeArgs): string {
  const { prTitle, prBody, prFiles, affected, crawl, requirements } = args;
  return `PR title: ${prTitle}
PR description: ${(prBody ?? "").slice(0, 1500)}

Changed files: ${prFiles.map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`).join(", ")}

DETERMINISTIC BLAST RADIUS (from the knowledge graph — trust these, don't contradict them):
- affected code files: ${affected.files.join(", ") || "none"}
- affected components/functions: ${affected.symbols.join(", ") || "none"}
- components/functions that depend on the change (render or call the changed symbols): ${affected.upstreamSymbols.join(", ") || "none"}
- screens at risk: ${affected.screens.map((x) => `${x.label} (${x.url})`).join("; ") || "none"}
- user flows touched: ${affected.flows.map((f) => `${f.fromLabel} -> ${f.toLabel}`).join("; ") || "none"}
- requirements at risk: ${affected.reqs.map((r) => `${r.reqId} ${r.title}`).join("; ") || "none"}
- requirements losing coverage: ${affected.losingCoverage.map((r) => `${r.reqId} ${r.title}`).join("; ") || "none"}
- requirements with NO UI coverage (pre-existing gaps): ${affected.uncovered.map((r) => `${r.reqId} ${r.title}`).join("; ") || "none"}

Screens captured: ${crawl.screens.map((s) => s.label).join(", ")}
Requirements: ${requirements.map((r) => `${r.reqId} ${r.title}`).join("; ").slice(0, 3000)}

Respond with ONLY JSON:
{"summary":"3-4 sentences for a QA lead who knows the product but not code: what the change does in plain language, which parts of the storefront are affected, and what to check.","whatToTest":["specific test scenarios, named by screens/flows"],"riskAreas":["plain-language risk descriptions"],"notes":["honest caveats — anything the system could not map or check"]}`;
}

/** LLM adapter: writes prose against the deterministic evidence. */
export function llmNarrativeWriter(): NarrativeWriter {
  return {
    async synthesizeNarrative(args): Promise<Narrative> {
      try {
        const raw = await completeReason(SYSTEM, userPrompt(args), { temperature: 0.2 }, "reason.narrative");
        const d = extractJson(raw) as Partial<Narrative>;
        return {
          summary: (d.summary ?? "").trim(),
          whatToTest: (d.whatToTest ?? []).slice(0, 12),
          riskAreas: (d.riskAreas ?? []).slice(0, 8),
          notes: (d.notes ?? []).slice(0, 6),
        };
      } catch (e) {
        return fallbackNarrative((e as Error).message);
      }
    },
  };
}

/** Degraded adapter: no LLM key — the deterministic evidence stands alone. */
export function degradedNarrativeWriter(): NarrativeWriter {
  return {
    async synthesizeNarrative(): Promise<Narrative> {
      return fallbackNarrative("LLM unavailable (no OPENROUTER_API_KEY)");
    },
  };
}

export function getNarrativeWriter(): NarrativeWriter {
  return hasLlm() ? llmNarrativeWriter() : degradedNarrativeWriter();
}

function fallbackNarrative(reason: string): Narrative {
  return {
    summary: `Automated analysis could not be written (${reason}). The deterministic evidence below still stands.`,
    whatToTest: [],
    riskAreas: [],
    notes: [],
  };
}
