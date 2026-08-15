import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactTranscript } from "../src/crawl/context.js";

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "open_url",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 2 };
}

function assistant(): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text: "ok" }] };
}

const LONG_SNAP = "a".repeat(5000);

test("keeps the last keepFull tool results intact, compacts the rest", () => {
  const msgs = [toolResult("x".repeat(5000)), toolResult("two"), toolResult("three")];
  const out = compactTranscript(msgs, 2);
  assert.equal(out.length, 3);
  const texts = out.map((m) => (m.content as Array<{ text: string }>)[0]!.text);
  assert.ok(texts[0]!.includes("[compacted by harness]"), "old result compacted");
  assert.equal(texts[1], "two");
  assert.equal(texts[2], "three");
});

test("short tool results are left alone", () => {
  const msgs = [toolResult("short"), toolResult("next"), toolResult("now")];
  const out = compactTranscript(msgs, 1);
  assert.equal((out[0]!.content as Array<{ text: string }>)[0]!.text, "short");
  assert.equal((out[1]!.content as Array<{ text: string }>)[0]!.text, "next");
  assert.equal((out[2]!.content as Array<{ text: string }>)[0]!.text, "now");
});

test("long old snapshots are truncated to COMPACT_HEAD chars", () => {
  const msgs = [toolResult(LONG_SNAP), toolResult("recent")];
  const out = compactTranscript(msgs, 1);
  const text = (out[0]!.content as Array<{ text: string }>)[0]!.text;
  assert.ok(text.length < 400);
  assert.ok(text.includes("[compacted by harness]"));
});

test("non-tool messages pass through untouched", () => {
  const msgs = [user("hi"), assistant(), toolResult("x")];
  const out = compactTranscript(msgs, 1);
  assert.equal(out[0], msgs[0]);
  assert.equal(out[1], msgs[1]);
  assert.equal(out[2], msgs[2]);
});

test("idempotent: compacting a compacted transcript is a no-op", () => {
  const msgs = [toolResult(LONG_SNAP), toolResult("recent")];
  const once = compactTranscript(msgs, 1);
  const twice = compactTranscript(once, 1);
  assert.deepEqual(twice, once);
});
