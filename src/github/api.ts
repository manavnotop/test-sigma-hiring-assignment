import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GH_API = "https://api.github.com";

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  mergedAt: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface FetchedRepo {
  fullName: string;
  ref: string;
  files: Map<string, string>; // path -> source
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "blast-radius-agent",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
  }
  return (await res.json()) as T;
}

export async function fetchReadme(fullName: string): Promise<string> {
  const res = await fetch(`${GH_API}/repos/${fullName}/readme`, {
    headers: { ...headers(), Accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok) throw new Error(`README fetch failed: ${res.status}`);
  return await res.text();
}

export async function fetchPullRequest(fullName: string, number: number): Promise<PullRequest> {
  const p = await gh<{
    number: number;
    title: string;
    body: string | null;
    state: string;
    merged_at: string | null;
    base: { ref: string };
    head: { ref: string; sha: string };
  }>(`/repos/${fullName}/pulls/${number}`);
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    state: p.state,
    mergedAt: p.merged_at,
    baseRef: p.base.ref,
    headRef: p.head.ref,
    headSha: p.head.sha,
  };
}

export async function fetchPullRequestFiles(
  fullName: string,
  number: number
): Promise<PullRequestFile[]> {
  const files = await gh<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>
  >(`/repos/${fullName}/pulls/${number}/files?per_page=100`);
  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? "",
  }));
}

/** Download the repo tarball at a ref and extract it to memory (path -> source). */
export async function fetchRepoTarball(
  fullName: string,
  ref: string,
  keep: (path: string) => boolean
): Promise<FetchedRepo> {
  const dir = mkdtempSync(join(tmpdir(), "br-repo-"));
  const url = `https://codeload.github.com/${fullName}/tar.gz/${ref}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`tarball download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tarPath = join(dir, "repo.tar.gz");
  await import("node:fs/promises").then((fs) => fs.writeFile(tarPath, buf));
  await execFileAsync("tar", ["-xzf", tarPath, "-C", dir]);
  // tarball root is <owner>-<repo>-<sha>/...
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir);
  const root = entries.find((e) => e !== "repo.tar.gz") ?? "";
  const rootDir = join(dir, root);

  const files = new Map<string, string>();
  async function walk(d: string, prefix: string): Promise<void> {
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        await walk(full, rel);
      } else if (keep(rel)) {
        const st = await stat(full);
        if (st.size > 2_000_000) continue;
        const content = await import("node:fs/promises").then((fs) =>
          fs.readFile(full, "utf-8")
        );
        files.set(rel, content);
      }
    }
  }
  await walk(rootDir, "");
  return { fullName, ref, files };
}
