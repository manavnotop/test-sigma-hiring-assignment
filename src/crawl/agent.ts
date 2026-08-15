import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { getCheapModel, getModels } from "../llm.js";
import type { CrawlArtifacts, InteractiveElement, Screen, ScreenTransition } from "../types.js";
import { Browser } from "./browser.js";
import { compactTranscript } from "./context.js";

const MAX_SNAPSHOT_CHARS = 4000;

export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  let s = u.href;
  if (s.endsWith("/") && s.length > u.origin.length + 1) s = s.slice(0, -1);
  return s;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function screenId(url: string): string {
  return createHash("sha1").update(normalizeUrl(url)).digest("hex").slice(0, 12);
}

interface CrawlState {
  base: string;
  origin: string;
  visited: Set<string>;
  frontier: string[];
  screens: Map<string, Screen>;
  transitions: ScreenTransition[];
  actionsPerUrl: Map<string, number>;
  turns: number;
  finished: boolean;
  log: string[];
  lastUrl: string;
}

export async function crawlApp(cfg: Config, browser: Browser): Promise<CrawlArtifacts> {
  const outDir = join(cfg.outputDir, "crawl");
  const screensDir = join(outDir, "screens");
  mkdirSync(screensDir, { recursive: true });

  const base = normalizeUrl(cfg.appBaseUrl);
  const origin = new URL(base).origin;
  const state: CrawlState = {
    base,
    origin,
    visited: new Set(),
    frontier: [base],
    screens: new Map(),
    transitions: [],
    actionsPerUrl: new Map(),
    turns: 0,
    finished: false,
    log: [],
    lastUrl: "",
  };

  const log = (msg: string) => {
    state.log.push(msg);
    console.log(`  [crawl] ${msg}`);
  };

  // --- deterministic capture: every new URL becomes a Screen -----------------
  async function captureScreen(enterAction: string, elementText?: string): Promise<Screen | null> {
    const { url, title } = await browser.where();
    const norm = normalizeUrl(url);
    if (!sameOrigin(url, cfg.appBaseUrl)) return null;
    if (state.visited.has(norm)) {
      // already captured — idempotent no-op (some paths race the agent loop)
      return state.screens.get(norm) ?? null;
    }

    try {
      await browser.waitForLoad();
    } catch {
      /* non-fatal */
    }

    const snapshot = await browser.snapshot(true);
    const { links } = await browser.extractPageStructure();

    // Enqueue same-origin links we haven't visited yet.
    let queued = 0;
    for (const l of links) {
      let t: string;
      try {
        t = normalizeUrl(l.href);
      } catch {
        continue; // malformed href from the page — skip, never crash the crawl
      }
      if (sameOrigin(t, cfg.appBaseUrl) && !state.visited.has(t) && !state.frontier.includes(t)) {
        state.frontier.push(t);
        queued++;
      }
    }

    // Parse hrefs off the compact snapshot text: `[ref=e1, url=...]`
    const hrefByRef = new Map<string, string>();
    for (const m of snapshot.text.matchAll(/\[ref=(\w+)(?:, url=([^\],\s]+))?\]/g)) {
      if (m[2]) hrefByRef.set(m[1], m[2]);
    }

    const elements: InteractiveElement[] = [];
    const seenEl = new Set<string>();
    for (const [ref, r] of Object.entries(snapshot.refs)) {
      const name = r.name.trim();
      if (!name) continue;
      const key = `${r.role}|${name}`;
      if (seenEl.has(key)) continue;
      seenEl.add(key);
      elements.push({
        ref,
        role: r.role,
        name: name.slice(0, 120),
        href: hrefByRef.get(ref),
      });
    }

    // Screenshot + a11y artifact.
    const sid = screenId(norm);
    const shotPath = `${sid}.png`;
    const snapPath = `${sid}.snapshot.json`;
    try {
      await browser.screenshot(join(screensDir, shotPath));
    } catch (e) {
      log(`screenshot failed for ${norm}: ${(e as Error).message}`);
    }
    writeFileSync(
      join(screensDir, snapPath),
      JSON.stringify({ url: norm, title, text: snapshot.text, refs: snapshot.refs }, null, 2)
    );

    const existing = state.screens.get(norm);
    const screen: Screen = {
      screenId: sid,
      url: norm,
      title,
      label: existing?.label ?? "",
      purpose: existing?.purpose ?? "",
      primaryActions: existing?.primaryActions ?? [],
      keyComponents: existing?.keyComponents ?? [],
      elements,
      screenshotPath: join("screens", shotPath),
      snapshotPath: join("screens", snapPath),
      visited: true,
    };
    state.screens.set(norm, screen);
    state.visited.add(norm);

    // Record the navigation into this URL (chains every captured screen).
    if (state.lastUrl && state.lastUrl !== norm) {
      state.transitions.push({
        fromUrl: state.lastUrl,
        toUrl: norm,
        action: enterAction,
        elementText,
      });
    }
    state.lastUrl = norm;

    log(
      `captured ${norm} — ${elements.length} elements, ${queued} new links queued (${state.visited.size}/${cfg.crawlMaxScreens} screens)`
    );
    return screen;
  }

  function budgetExhausted(): boolean {
    return state.visited.size >= cfg.crawlMaxScreens;
  }

  function sameUrlActionBudget(url: string): boolean {
    return (state.actionsPerUrl.get(url) ?? 0) < cfg.crawlMaxActionsPerScreen;
  }

  async function handleNavigation(prevUrl: string, action: string, elementText?: string) {
    const { url } = await browser.where();
    if (normalizeUrl(url) !== prevUrl) {
      if (!state.visited.has(normalizeUrl(url))) {
        await captureScreen(action, elementText);
        return "navigated+captured";
      }
      // already captured — record the navigation into it (captureScreen owns the
      // transition record for new screens, so we don't double-record)
      state.transitions.push({
        fromUrl: prevUrl,
        toUrl: normalizeUrl(url),
        action,
        elementText,
      });
      return "navigated";
    }
    // same URL: merge any new elements into the screen record
    if (state.screens.has(prevUrl)) {
      const snapshot = await browser.snapshot(true);
      const screen = state.screens.get(prevUrl)!;
      const have = new Set(screen.elements.map((e) => `${e.role}|${e.name}`));
      for (const [ref, r] of Object.entries(snapshot.refs)) {
        const key = `${r.role}|${r.name}`;
        if (!have.has(key) && r.name.trim()) {
          have.add(key);
          screen.elements.push({ ref, role: r.role, name: r.name.slice(0, 120) });
        }
      }
    }
    return "no-navigation";
  }

  // --- tools ----------------------------------------------------------------
  const tools = [
    {
      name: "open_url",
      label: "Open URL",
      description:
        "Navigate to a URL. Must be on the same origin as the app under crawl. The harness captures the screen automatically when you land somewhere new.",
      parameters: Type.Object({
        url: Type.String({ description: "Full URL to open (same origin only)" }),
      }),
      execute: async (_id: string, params: { url: string }) => {
        state.turns++;
        let target: string;
        try {
          target = normalizeUrl(params.url);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `Malformed URL: "${params.url}". Pass a full URL like ${state.base} or a URL from the frontier/snapshot.`,
              },
            ],
            details: { ok: false },
          };
        }
        if (!sameOrigin(target, cfg.appBaseUrl)) {
          return {
            content: [{ type: "text", text: `Blocked: ${target} is not on origin ${state.origin}` }],
            details: { ok: false },
          };
        }
        if (state.visited.has(target)) {
          return {
            content: [{ type: "text", text: `Already visited: ${target}` }],
            details: { ok: true },
          };
        }
        if (budgetExhausted()) {
          return {
            content: [
              {
                type: "text",
                text: `Screen budget exhausted (${state.visited.size}/${cfg.crawlMaxScreens}). Call finish_crawl.`,
              },
            ],
            details: { ok: false },
          };
        }
        await browser.open(target);
        const screen = await captureScreen("navigate");
        const snap = await browser.snapshot(true);
        return {
          content: [
            {
              type: "text",
              text: `Now on ${target}\nTitle: ${screen?.title ?? ""}\n${snap.text.slice(0, MAX_SNAPSHOT_CHARS)}`,
            },
          ],
          details: { ok: true, screens: state.visited.size },
        };
      },
    },
    {
      name: "click_element",
      label: "Click Element",
      description:
        "Click an interactive element by its ref (e.g. @e5). Ref must come from the snapshot you were just shown. Use for links, buttons, tabs, accordions.",
      parameters: Type.Object({
        ref: Type.String({ description: "Element ref like @e5 or e5" }),
      }),
      execute: async (_id: string, params: { ref: string }) => {
        state.turns++;
        const url = normalizeUrl((await browser.where()).url);
        if (!sameUrlActionBudget(url)) {
          return {
            content: [
              {
                type: "text",
                text: `Action budget exhausted on ${url} (${cfg.crawlMaxActionsPerScreen} actions). Move to another page or call finish_crawl.`,
              },
            ],
            details: { ok: false },
          };
        }
        state.actionsPerUrl.set(url, (state.actionsPerUrl.get(url) ?? 0) + 1);
        const ref = params.ref.startsWith("@") ? params.ref : `@${params.ref}`;
        try {
          await browser.click(ref);
        } catch (e) {
          return {
            content: [{ type: "text", text: `Click failed: ${(e as Error).message}` }],
            details: { ok: false },
          };
        }
        const outcome = await handleNavigation(url, "click", ref);
        if (outcome === "navigated+captured") {
          const snap = await browser.snapshot(true);
          return {
            content: [
              {
                type: "text",
                text: `Navigated and captured. New page:\n${snap.text.slice(0, MAX_SNAPSHOT_CHARS)}`,
              },
            ],
            details: { ok: true, outcome },
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                outcome === "navigated"
                  ? `Navigated to ${(await browser.where()).url} (already captured).`
                  : `Clicked ${ref}; no navigation (state change on the same page).`,
            },
          ],
          details: { ok: true, outcome },
        };
      },
    },
    {
      name: "fill_input",
      label: "Fill Input",
      description:
        "Type text into an input (search box etc.) by ref. Set submit=true to press Enter (triggers search).",
      parameters: Type.Object({
        ref: Type.String({ description: "Input ref like @e4 or e4" }),
        text: Type.String({ description: "Text to type" }),
        submit: Type.Boolean({ description: "Press Enter after filling", default: false }),
      }),
      execute: async (_id: string, params: { ref: string; text: string; submit: boolean }) => {
        state.turns++;
        const url = normalizeUrl((await browser.where()).url);
        if (!sameUrlActionBudget(url)) {
          return {
            content: [
              {
                type: "text",
                text: `Action budget exhausted on ${url}. Move to another page or call finish_crawl.`,
              },
            ],
            details: { ok: false },
          };
        }
        state.actionsPerUrl.set(url, (state.actionsPerUrl.get(url) ?? 0) + 1);
        const ref = params.ref.startsWith("@") ? params.ref : `@${params.ref}`;
        try {
          await browser.fill(ref, params.text, params.submit);
        } catch (e) {
          return {
            content: [{ type: "text", text: `Fill failed: ${(e as Error).message}` }],
            details: { ok: false },
          };
        }
        const outcome = await handleNavigation(url, params.submit ? "search submit" : "fill", params.text);
        return {
          content: [
            {
              type: "text",
              text:
                outcome === "navigated+captured"
                  ? `Search navigated to ${(await browser.where()).url} — captured.`
                  : outcome === "navigated"
                    ? `Navigated to ${(await browser.where()).url}.`
                    : "Filled input; page did not navigate.",
            },
          ],
          details: { ok: true, outcome },
        };
      },
    },
    {
      name: "go_back",
      label: "Go Back",
      description: "Navigate back to the previous page in history.",
      parameters: Type.Object({}),
      execute: async () => {
        state.turns++;
        const url = normalizeUrl((await browser.where()).url);
        await browser.back();
        await handleNavigation(url, "back");
        const snap = await browser.snapshot(true);
        return {
          content: [
            {
              type: "text",
              text: `Back on ${(await browser.where()).url}\n${snap.text.slice(0, MAX_SNAPSHOT_CHARS)}`,
            },
          ],
          details: { ok: true },
        };
      },
    },
    {
      name: "list_frontier",
      label: "List Frontier",
      description:
        "List URLs discovered but not yet visited (the exploration frontier). Prefer visiting these over exploring the current page further.",
      parameters: Type.Object({}),
      execute: async () => {
        state.turns++;
        const unvisited = state.frontier.filter((u) => !state.visited.has(u)).slice(0, 20);
        return {
          content: [
            {
              type: "text",
              text:
                unvisited.length === 0
                  ? `Frontier is empty (${state.visited.size} screens visited). You can call finish_crawl.`
                  : `Unvisited URLs (${state.frontier.filter((u) => !state.visited.has(u)).length} total):\n${unvisited.join("\n")}`,
            },
          ],
          details: { ok: true },
        };
      },
    },
    {
      name: "finish_crawl",
      label: "Finish Crawl",
      description:
        "Declare the crawl complete. Call this when the frontier is empty, the budgets are exhausted, or the app's main areas are captured.",
      parameters: Type.Object({}),
      execute: async () => {
        state.finished = true;
        return {
          content: [
            {
              type: "text",
              text: `Crawl finished: ${state.visited.size} screens, ${state.transitions.length} transitions.`,
            },
          ],
          details: { finished: true },
          terminate: true,
        };
      },
    },
  ];

  // --- run the PI agent -----------------------------------------------------
  const { hasLlm } = await import("../llm.js");

  // Seed: capture the base page first.
  await browser.open(base);
  const home = await captureScreen("seed");

  if (!hasLlm()) {
    log("no LLM key — running deterministic breadth-first crawl instead of the agent");
    await deterministicPass(state, browser, cfg, captureScreen, log);
  } else {
    const models = getModels();
    const { recordUsage } = await import("../llm.js");
    const agent = new Agent({
      initialState: {
        systemPrompt: `You are the exploration brain of a web-app crawler for a testing-intelligence system.

App under crawl: ${cfg.appBaseUrl}
Origin (stay here): ${state.origin}
Budgets: max ${cfg.crawlMaxScreens} screens, ${cfg.crawlMaxActionsPerScreen} actions per URL.

The deterministic harness captures every new URL automatically (accessibility snapshot, screenshot, link discovery). Your job is only to CHOOSE where to go and what to exercise:

1. After each tool result you are shown a compact accessibility snapshot with element refs (e.g. @e5).
2. Explore breadth-first: use list_frontier to see unvisited URLs, then open_url to visit them. This is a storefront: home, category pages (All/Shirts/Stickers), product pages, cart, and policy pages are all worth capturing.
3. Exercise state-changing interactions: click a product to view it, add an item to the cart (then open the cart), try the search box (fill_input + submit), open the FAQ/about pages. These create the interaction transitions the knowledge graph needs.
4. Only click elements that appear in the snapshot you were just shown. Re-snapshot happens on navigation; if you want a fresh snapshot use open_url on the current page or rely on the provided text.
5. Constraints: read-only plus harmless cart interactions. Never log in, never submit payment or personal data, never click external links (Deploy on Vercel, View the source, Created by Vercel are off-origin).
6. When the frontier is empty or budgets are nearly exhausted, call finish_crawl. Do not invent URLs — only use the ones you see in snapshots and frontiers.`,
        model: getCheapModel(),
        tools: tools as import("@earendil-works/pi-agent-core").AgentTool[],
      },
      streamFn: models.streamSimple.bind(models),
      // OpenRouter sticky routing: a stable session id pins every turn of this
      // crawl to the same upstream provider, so the DeepSeek prompt cache stays
      // warm across turns (cache reads at 0.1x input price).
      sessionId: `crawl-${screenId(base)}`,
      // Deterministic context compaction: old tool results are shrunk to a
      // one-line summary, keeping the tail of the transcript small so each
      // turn re-bills as few non-cached tokens as possible.
      transformContext: async (messages) => compactTranscript(messages, 2),
    });

    const homeSnap = await browser.snapshot(true);
    // Per-turn usage from the agent loop (cacheRead/cacheWrite/cost) so
    // output/cost.json covers the whole pipeline, not just direct calls.
    agent.subscribe((event) => {
      if (event.type === "message_end" && "usage" in event.message && event.message.usage) {
        const u = event.message.usage;
        recordUsage("crawl.agent", models.getModel("openrouter", cfg.cheapModel)?.id ?? "agent", {
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          cost: u.cost.total,
        });
      }
    });
    await agent.prompt(
      `We are on the home page (already captured):\nTitle: ${home?.title ?? ""}\n${homeSnap.text.slice(0, MAX_SNAPSHOT_CHARS)}\n\nStart exploring the app now.`
    );

    if (state.finished && state.visited.size <= 1) {
      log("agent finished without exploring; forcing one BFS pass over the frontier");
      await deterministicPass(state, browser, cfg, captureScreen, log);
    } else if (
      state.frontier.filter((u) => !state.visited.has(u)).length > 0 &&
      state.visited.size < cfg.crawlMaxScreens
    ) {
      log("agent ended with unvisited frontier; completing with a deterministic BFS pass");
      await deterministicPass(state, browser, cfg, captureScreen, log);
    }
  }

  await browser.close();
  await labelScreens(state, cfg);

  const artifacts: CrawlArtifacts = {
    baseUrl: base,
    screens: [...state.screens.values()].sort((a, b) => a.url.localeCompare(b.url)),
    transitions: state.transitions,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify({ ...artifacts, log: state.log }, null, 2)
  );
  log(
    `done: ${artifacts.screens.length} screens, ${artifacts.transitions.length} transitions -> ${join(outDir, "manifest.json")}`
  );
  return artifacts;
}

/** Deterministic breadth-first fallback so the crawl is reproducible even without an LLM. */
async function deterministicPass(
  state: CrawlState,
  browser: Browser,
  cfg: Config,
  capture: (action: string, el?: string) => Promise<Screen | null>,
  log: (m: string) => void
): Promise<void> {
  while (state.frontier.length > 0 && state.visited.size < cfg.crawlMaxScreens) {
    const next = state.frontier.shift()!;
    if (state.visited.has(next)) continue;
    await browser.open(next);
    const screen = await capture("navigate");
    if (!screen) continue;
    // Exercise the search box on the home page only (deterministic sample).
    if (next === normalizeUrl(cfg.appBaseUrl)) {
      const snap = await browser.snapshot(true);
      const searchRef = Object.entries(snap.refs).find(([, r]) => r.role === "textbox")?.[0];
      if (searchRef) {
        await browser.fill(`@${searchRef}`, "shirt", true);
        const outcome = await capture("search submit", "shirt");
        if (!outcome) await browser.where();
      }
    }
  }
  log("deterministic pass done");
}

// --- semantic labeling pass (LLM, after capture) -----------------------------
async function labelScreens(state: CrawlState, cfg: Config): Promise<void> {
  const { completeCheap, extractJson, hasLlm } = await import("../llm.js");
  const { readFile } = await import("node:fs/promises");
  const screens = [...state.screens.values()].filter((s) => !s.label);
  if (screens.length === 0) return;
  if (!hasLlm()) {
    for (const s of screens) s.label = s.title.slice(0, 80);
    return;
  }
  const system = `You read captured accessibility snapshots of a live web app and describe each screen for a QA lead who knows the product but not code. Return ONLY JSON: {"label":"3-6 word screen name","purpose":"one sentence: what the user does here","primary_actions":["..."],"key_components":["..."]}`;
  const concurrency = 4;
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, screens.length) }, async () => {
      while (i < screens.length) {
        const s = screens[i++];
        try {
          const raw = JSON.parse(
            await readFile(join(cfg.outputDir, "crawl", s.snapshotPath), "utf-8")
          ) as { text: string };
          const out = await completeCheap(
            system,
            `App: ${cfg.appBaseUrl}\nURL: ${s.url}\nTitle: ${s.title}\n\nAccessibility snapshot:\n${raw.text.slice(0, 3500)}`,
            undefined,
            "crawl.label"
          );
          const d = extractJson(out) as {
            label?: string;
            purpose?: string;
            primary_actions?: string[];
            key_components?: string[];
          };
          s.label = (d.label ?? s.title).slice(0, 80);
          s.purpose = (d.purpose ?? "").slice(0, 400);
          s.primaryActions = (d.primary_actions ?? []).slice(0, 8);
          s.keyComponents = (d.key_components ?? []).slice(0, 10);
          console.log(`  [crawl] labeled ${s.url} -> ${s.label}`);
        } catch (e) {
          s.label = s.title.slice(0, 80);
          console.log(`  [crawl] label fallback for ${s.url}: ${(e as Error).message}`);
        }
      }
    })
  );
}
