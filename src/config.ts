import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

export interface Config {
  openRouterApiKey: string;
  cheapModel: string;
  reasonModel: string;

  neo4jUri: string;
  neo4jUsername: string;
  neo4jPassword: string;
  neo4jDatabase: string;

  appBaseUrl: string;
  repoFullName: string;
  prNumber: number;

  crawlMaxScreens: number;
  crawlMaxActionsPerScreen: number;
  githubToken?: string;

  outputDir: string;
}

export function getConfig(): Config {
  const cfg: Config = {
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    cheapModel: process.env.OPENROUTER_MODEL_CHEAP ?? "deepseek/deepseek-v4-flash",
    reasonModel: process.env.OPENROUTER_MODEL_REASON ?? "deepseek/deepseek-v4-flash",

    neo4jUri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4jUsername: process.env.NEO4J_USERNAME ?? "neo4j",
    neo4jPassword: process.env.NEO4J_PASSWORD ?? "blastradius",
    neo4jDatabase: process.env.NEO4J_DATABASE ?? "neo4j",

    appBaseUrl: process.env.APP_BASE_URL ?? "https://demo.vercel.store",
    repoFullName: process.env.REPO_FULL_NAME ?? "vercel/commerce",
    prNumber: Number(process.env.PR_NUMBER ?? "1527"),

    crawlMaxScreens: Number(process.env.CRAWL_MAX_SCREENS ?? "25"),
    crawlMaxActionsPerScreen: Number(process.env.CRAWL_MAX_ACTIONS_PER_SCREEN ?? "6"),
    githubToken: process.env.GITHUB_TOKEN || undefined,

    outputDir: resolve(process.cwd(), "output"),
  };
  return cfg;
}
