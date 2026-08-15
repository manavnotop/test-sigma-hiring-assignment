import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { fetchReadme } from "../github/api.js";
import { completeCheap, extractJson, hasLlm } from "../llm.js";
import type { Requirement } from "../types.js";

const HEADING = /^(#{1,6})\s+(.*)$/gm;

export function splitSections(md: string): Array<{ heading: string; body: string }> {
  const matches = [...md.matchAll(HEADING)];
  if (matches.length === 0) return [{ heading: "Document", body: md.trim() }];
  const sections: Array<{ heading: string; body: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][2].trim();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    const body = md.slice(start, end).trim();
    if (body) sections.push({ heading, body });
  }
  return sections;
}

const EXTRACT_SYSTEM = `You turn product documentation into a clear list of product requirements.
Your reader is a non-technical product person or QA lead: they understand the product and how people use it, but NOT code.
For the given section, return ONLY JSON:
{"requirements":[{"title":"...","description":"...","user_action":"...","expected_outcome":"...","priority":"high|medium|low"}]}

Rules:
- A requirement must be something a user can see or do (the user does X, the product responds with Y).
- description: 2-3 plain-English sentences walking through what this lets the user do and what they'd see.
- user_action and expected_outcome: one plain sentence each (the When/Then), written for a non-engineer.
- Skip prose that describes no user-facing behaviour; return an empty list then.
- Do not invent features that are not in the text.`;

export interface IngestResult {
  source: string;
  requirements: Requirement[];
  overview: string;
}

export async function ingestRepo(fullName: string): Promise<IngestResult> {
  const cfg = getConfig();
  const md = await fetchReadme(fullName);
  const sections = splitSections(md);
  console.log(`  [ingest] ${sections.length} markdown sections from ${fullName} README`);

  const requirements: Requirement[] = [];
  if (!hasLlm()) {
    // no LLM key: coarse requirement per section heading (still graph-usable)
    sections.forEach((s, i) => {
      requirements.push({
        reqId: `R${i + 1}`,
        title: s.heading,
        description: "",
        userAction: "",
        expectedOutcome: "",
        sourceAnchor: s.heading,
        priority: "medium",
      });
    });
  } else {
    let done = 0;
    for (const section of sections) {
      try {
        const raw = await completeCheap(
          EXTRACT_SYSTEM,
          `Section heading: ${section.heading}\n\nSection body:\n${section.body.slice(0, 6000)}`,
          { temperature: 0.1 },
          "ingest"
        );
        const data = extractJson(raw) as {
          requirements?: Array<{
            title?: string;
            description?: string;
            user_action?: string;
            expected_outcome?: string;
            priority?: string;
          }>;
        };
        for (const r of data.requirements ?? []) {
          if (!r.title) continue;
          requirements.push({
            reqId: "",
            title: r.title.trim(),
            description: (r.description ?? "").trim(),
            userAction: (r.user_action ?? "").trim(),
            expectedOutcome: (r.expected_outcome ?? "").trim(),
            sourceAnchor: section.heading,
            priority: r.priority ?? "medium",
          });
        }
      } catch (e) {
        console.log(`  [ingest] section failed (${section.heading}): ${(e as Error).message}`);
      }
      done++;
      if (done % 5 === 0 || done === sections.length) {
        console.log(`  [ingest] ${done}/${sections.length} sections done, ${requirements.length} requirements`);
      }
    }
  }

  // stable ids in document order; dedupe near-identical titles
  const seen = new Set<string>();
  let n = 0;
  for (const r of requirements) {
    const key = r.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
    r.reqId = `R${n}`;
  }

  const overview = "";
  const result: IngestResult = { source: fullName, requirements, overview };
  const outPath = join(cfg.outputDir, "requirements.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`  [ingest] ${result.requirements.length} requirements -> ${outPath}`);
  return result;
}
