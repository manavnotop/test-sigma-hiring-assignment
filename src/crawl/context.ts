import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Context compaction for the crawl agent loop.
 *
 * Prompt-caching rule: keep the prefix (system prompt + tool schemas) byte
 * stable; everything dynamic belongs in the tail. The tail is the problem —
 * every turn re-sends ALL tool results at full input price. Old tool results
 * only matter to the agent while it is on that page (refs are page-scoped),
 * so we deterministically shrink them to a one-line summary and keep the
 * most recent `keepFull` results intact.
 *
 * Pure and deterministic: same transcript in, same compacted transcript out.
 */
export const COMPACT_HEAD = 300;

export function compactTranscript(
  messages: AgentMessage[],
  keepFull = 2
): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "toolResult" && messages.length - i > keepFull) {
      const text = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      const compact =
        text.length <= COMPACT_HEAD
          ? text
          : `${text.slice(0, COMPACT_HEAD).trimEnd()} …[compacted by harness]`;
      out.push({ ...m, content: [{ type: "text", text: compact }] });
      continue;
    }
    out.push(m);
  }
  return out;
}
