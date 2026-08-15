import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { Context } from "@earendil-works/pi-ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config.js";

export type ModelsCollection = ReturnType<typeof createModels>;
export type ModelRef = NonNullable<
  ModelsCollection extends { getModel: (p: string, m: string) => infer R } ? R : never
>;

let models: ModelsCollection | null = null;
let cheapModel: ModelRef;
let reasonModel: ModelRef;

// --- cost observability ------------------------------------------------------
// Every LLM call records its usage (input/output/cacheRead/cacheWrite/cost) so
// the pipeline can prove prompt-cache hits and report stage-level spend.
export interface UsageRecord {
  tag: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

const usageLog: UsageRecord[] = [];

export function getUsageLog(): UsageRecord[] {
  return usageLog;
}

/** Record usage from a source that streams outside complete() (e.g. the agent loop). */
export function recordUsage(tag: string, model: string, u: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}): void {
  usageLog.push({ tag, model, ...u });
}

/** Aggregate usage per tag, plus totals. */
export function usageSummary(): {
  perTag: Array<{ tag: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>;
  totals: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
} {
  const byTag = new Map<string, UsageRecord[]>();
  for (const r of usageLog) {
    const list = byTag.get(r.tag) ?? [];
    list.push(r);
    byTag.set(r.tag, list);
  }
  const perTag = [...byTag.entries()].map(([tag, rows]) => ({
    tag,
    calls: rows.length,
    input: rows.reduce((a, r) => a + r.input, 0),
    output: rows.reduce((a, r) => a + r.output, 0),
    cacheRead: rows.reduce((a, r) => a + r.cacheRead, 0),
    cacheWrite: rows.reduce((a, r) => a + r.cacheWrite, 0),
    cost: rows.reduce((a, r) => a + r.cost, 0),
  }));
  const totals = perTag.reduce(
    (a, t) => ({
      calls: a.calls + t.calls,
      input: a.input + t.input,
      output: a.output + t.output,
      cacheRead: a.cacheRead + t.cacheRead,
      cacheWrite: a.cacheWrite + t.cacheWrite,
      cost: a.cost + t.cost,
    }),
    { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  );
  return { perTag, totals };
}

/** Write output/cost.json and print a one-line stage breakdown. */
export function saveUsageReport(outputDir: string): void {
  if (usageLog.length === 0) return;
  const { perTag, totals } = usageSummary();
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, "cost.json"),
    JSON.stringify({ perTag, totals, calls: usageLog }, null, 2)
  );
  const cacheHitPct =
    totals.input > 0 ? Math.round((totals.cacheRead / totals.input) * 1000) / 10 : 0;
  console.log(
    `\n[usage] ${totals.calls} calls, ${totals.input} in (${totals.cacheRead} cached = ${cacheHitPct}%), ` +
      `${totals.output} out, $${totals.cost.toFixed(3)} -> output/cost.json`
  );
}

export function getModels(): ModelsCollection {
  ensure();
  return models!;
}

export function getCheapModel(): ModelRef {
  ensure();
  return cheapModel;
}

export function getReasonModel(): ModelRef {
  ensure();
  return reasonModel;
}

function ensure(): void {
  if (models) return;
  const cfg = getConfig();
  if (!cfg.openRouterApiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Create .env from .env.example and add your key."
    );
  }
  // Long prompt-cache retention: on OpenRouter this pins a `prompt_cache_key`
  // on every request (DeepSeek reads cached prefixes at 0.1x input price).
  // read by pi-ai's provider adapters via process.env fallback, so it covers
  // the agent loop as well as the direct stream() calls in complete().
  if (!process.env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = "long";
  models = createModels();
  models.setProvider(openrouterProvider());
  const cheap = models.getModel("openrouter", cfg.cheapModel);
  const reason = models.getModel("openrouter", cfg.reasonModel);
  if (!cheap) throw new Error(`Model not found in openrouter catalog: ${cfg.cheapModel}`);
  if (!reason) throw new Error(`Model not found in openrouter catalog: ${cfg.reasonModel}`);
  cheapModel = cheap;
  reasonModel = reason;
}

export function hasLlm(): boolean {
  return Boolean(getConfig().openRouterApiKey);
}

export interface CompleteOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

async function complete(
  model: ModelRef,
  ctx: Context,
  opts: CompleteOptions = {},
  tag = "llm"
): Promise<string> {
  ensure();
  const streamOptions: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.2,
    cacheRetention: "long",
  };
  if (opts.maxOutputTokens) streamOptions.maxOutputTokens = opts.maxOutputTokens;
  const s = getModels().stream(model, ctx, streamOptions as never);
  for await (const _event of s) {
    /* drain */
  }
  const result = await s.result();
  const u = result.usage;
  usageLog.push({
    tag,
    model: model.id,
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    cost: u.cost.total,
  });
  const text = result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text;
}

/** Cheap model for high-volume structured extraction (ingest, crawl choices). */
export function completeCheap(
  systemPrompt: string,
  userPrompt: string,
  opts?: CompleteOptions,
  tag?: string
): Promise<string> {
  const ctx: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };
  return complete(getCheapModel(), ctx, opts, tag ?? "cheap");
}

/** Reason model for the cross-layer mapping and the blast-radius synthesis. */
export function completeReason(
  systemPrompt: string,
  userPrompt: string,
  opts?: CompleteOptions,
  tag?: string
): Promise<string> {
  const ctx: Context = {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  };
  return complete(getReasonModel(), ctx, opts, tag ?? "reason");
}

/** Tolerant JSON extraction: pulls the first balanced {...} block out of a response. */
export function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object found in LLM output: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}
