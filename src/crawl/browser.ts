import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SnapshotRef {
  name: string;
  role: string;
  url?: string;
}

export interface Snapshot {
  text: string;
  refs: Record<string, SnapshotRef>;
  url: string;
  title: string;
}

export interface EvalResult {
  success: boolean;
  result: unknown;
  error?: string;
}

interface AbResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string | null;
  stderr?: string;
}

/** Thin wrapper around the agent-browser CLI (Vercel) via CDP-connected Chrome. */
export class Browser {
  private lastUrl = "";
  private lastAction = "";
  private lastElementText = "";

  private async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("agent-browser", args, {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
      };
    }
  }

  private realError(stderr: string): string {
    const statusLines = [
      "[agent-browser] launched browser",
      "✓ Screenshot saved",
    ];
    const meaningful = stderr
      .split("\n")
      .filter((l) => l.trim() && !statusLines.some((s) => l.includes(s)));
    return meaningful.join("\n");
  }

  async open(url: string): Promise<{ url: string; title: string }> {
    const { stderr } = await this.run(["open", url]);
    const err = this.realError(stderr);
    if (err) throw new Error(`open failed: ${err}`);
    return this.where();
  }

  async where(): Promise<{ url: string; title: string }> {
    const url = (await this.run(["get", "url"])).stdout.trim();
    const title = (await this.run(["get", "title"])).stdout.trim();
    this.lastUrl = url;
    return { url, title };
  }

  async snapshot(interactive = true): Promise<Snapshot> {
    const args = ["snapshot"];
    if (interactive) args.push("-i", "-u");
    args.push("--json");
    const { stdout } = await this.run(args);
    let parsed: AbResponse;
    try {
      parsed = JSON.parse(stdout) as AbResponse;
    } catch {
      throw new Error(`snapshot parse failed: ${stdout.slice(0, 400)}`);
    }
    const data = (parsed.data ?? {}) as {
      refs?: Record<string, SnapshotRef>;
      snapshot?: string;
      origin?: string;
    };
    const refs = data.refs ?? {};
    const text = data.snapshot ?? "";
    return {
      text,
      refs,
      url: data.origin ?? "",
      title: "",
    };
  }

  async click(refOrSelector: string): Promise<{ url: string; title: string }> {
    this.lastAction = "click";
    this.lastElementText = refOrSelector;
    const { stderr } = await this.run(["click", refOrSelector]);
    const err = this.realError(stderr);
    if (err) {
      throw new Error(`click ${refOrSelector} failed: ${err.slice(0, 300)}`);
    }
    return this.where();
  }

  async fill(ref: string, text: string, submit = false): Promise<{ url: string; title: string }> {
    this.lastAction = "fill";
    this.lastElementText = ref;
    const { stderr } = await this.run(["fill", ref, text]);
    const err = this.realError(stderr);
    if (err) {
      throw new Error(`fill ${ref} failed: ${err.slice(0, 300)}`);
    }
    if (submit) {
      this.lastAction = "press Enter";
      await this.run(["press", "Enter"]);
    }
    return this.where();
  }

  async press(key: string): Promise<{ url: string; title: string }> {
    this.lastAction = `press ${key}`;
    this.lastElementText = "";
    const { stderr } = await this.run(["press", key]);
    const err = this.realError(stderr);
    if (err) throw new Error(`press failed: ${err.slice(0, 300)}`);
    return this.where();
  }

  async back(): Promise<{ url: string; title: string }> {
    this.lastAction = "back";
    this.lastElementText = "";
    await this.run(["back"]);
    return this.where();
  }

  async waitForLoad(): Promise<void> {
    await this.run(["wait", "--load", "networkidle"]);
  }

  async screenshot(path: string): Promise<void> {
    const { stderr } = await this.run(["screenshot", path]);
    const err = this.realError(stderr);
    if (err) throw new Error(`screenshot failed: ${err.slice(0, 200)}`);
  }

  /** Run JS in the page; deterministic data extraction (links, inputs, forms). */
  async eval(js: string): Promise<EvalResult> {
    const { stdout } = await this.run(["eval", js]);
    try {
      const parsed = JSON.parse(stdout) as {
        success?: boolean;
        result?: unknown;
        error?: string;
      };
      // agent-browser eval returns the raw value, or {success, result} wrappers
      if (typeof parsed.success === "boolean") {
        return { success: parsed.success, result: parsed.result, error: parsed.error };
      }
      return { success: true, result: parsed };
    } catch {
      return {
        success: false,
        result: undefined,
        error: `eval parse failed: ${stdout.slice(0, 300)}`,
      };
    }
  }

  /** Extract every same-page link + interactive control deterministically. */
  async extractPageStructure(): Promise<{
    links: Array<{ href: string; text: string }>;
    url: string;
  }> {
    const js = `
      (() => {
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 120) }))
          .filter(l => l.href && l.href.startsWith('http'));
        return { links };
      })()
    `;
    const res = await this.eval(js);
    const url = (await this.where()).url;
    if (!res.success) return { links: [], url };
    const data = res.result as { links: Array<{ href: string; text: string }> };
    const seen = new Set<string>();
    const links = (data.links ?? []).filter((l) => {
      if (seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    });
    return { links, url };
  }

  noteAction(action: string, elementText?: string): void {
    this.lastAction = action;
    this.lastElementText = elementText ?? "";
  }

  get lastTransition(): { action: string; elementText: string } {
    return { action: this.lastAction, elementText: this.lastElementText };
  }

  async close(): Promise<void> {
    await this.run(["close"]);
  }
}
