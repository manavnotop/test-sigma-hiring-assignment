import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMappings, type MappingEntry } from "../src/graph/mappings.js";
import type { Requirement, ScreenWrite } from "../src/types.js";

const fullName = "acme/store";

const screens: ScreenWrite[] = [
  {
    screenId: "s1",
    url: "https://acme.store/",
    title: "Home",
    label: "Home",
    purpose: "landing",
    route: "/",
  },
  {
    screenId: "s2",
    url: "https://acme.store/product/abc",
    title: "Product Page",
    label: "Product Page",
    purpose: "product detail",
    route: "/product/[handle]",
  },
];

const requirements: Requirement[] = [
  {
    reqId: "R1",
    title: "Browse the product catalog",
    description: "",
    userAction: "user visits the product page",
    expectedOutcome: "sees product details",
    sourceAnchor: "prd",
    priority: "P1",
  },
  {
    reqId: "R2",
    title: "Add item to cart",
    description: "",
    userAction: "user clicks add to cart",
    expectedOutcome: "item is in cart",
    sourceAnchor: "prd",
    priority: "P1",
  },
];

const filePaths = new Set(["app/product/[handle]/page.tsx", "app/cart/page.tsx"]);

const proposal = (reqId: string, screens: Array<[string, number]>, files: Array<[string, number]>): MappingEntry => ({
  reqId,
  screens: screens.map(([name, confidence]) => ({ name, confidence })),
  files: files.map(([path, confidence]) => ({ path, confidence })),
});

test("resolveMappings keeps exact label/url matches", () => {
  const r = resolveMappings(fullName, requirements, screens, [
    proposal("R1", [["Product Page", 0.9]], [["app/product/[handle]/page.tsx", 0.8]]),
  ], filePaths);

  assert.deepEqual(r.coverRels, [
    { req: "acme/store::req::R1", screen: "acme/store::screen::s2", confidence: 0.9 },
  ]);
  assert.deepEqual(r.implRels, [
    { req: "acme/store::req::R1", file: "acme/store:app/product/[handle]/page.tsx", confidence: 0.8 },
  ]);
  assert.ok(r.coveredIds.has("R1"));
});

test("resolveMappings drops hallucinated names and paths", () => {
  const r = resolveMappings(fullName, requirements, screens, [
    proposal("R1", [["Totally Fake Screen", 0.9]], [["not/a/real/path.tsx", 0.8]]),
  ], filePaths);

  assert.equal(r.coverRels.length, 0);
  assert.equal(r.implRels.length, 0);
  assert.equal(r.coveredIds.size, 0);
  assert.ok(r.uncoveredIds.includes("R1"));
});

test("resolveMappings accepts label (url) echoes and urls inside text", () => {
  const r = resolveMappings(fullName, requirements, screens, [
    proposal("R1", [["Product Page (https://acme.store/product/abc)", 0.9]], []),
    proposal("R2", [["visit https://acme.store/product/abc now", 0.7]], []),
  ], filePaths);

  assert.equal(r.coverRels.length, 2);
  assert.ok(r.coverRels.every((c) => c.screen === "acme/store::screen::s2"));
});

test("resolveMappings falls back to fuzzy token overlap", () => {
  const r = resolveMappings(fullName, requirements, screens, [
    proposal("R1", [["The Product Page", 0.9]], []),
  ], filePaths);

  assert.equal(r.coverRels[0]?.screen, "acme/store::screen::s2");
});

test("resolveMappings clamps confidence to [0, 1]", () => {
  const r = resolveMappings(fullName, requirements, screens, [
    proposal("R1", [["Product Page", 1.7], ["Home", -2]], []),
  ], filePaths);

  const confs = new Map(r.coverRels.map((c) => [c.screen, c.confidence]));
  assert.equal(confs.get("acme/store::screen::s2"), 1);
  assert.equal(confs.get("acme/store::screen::s1"), 0);
});

test("resolveMappings defaults absence: requirement with no resolved screen is uncovered", () => {
  const r = resolveMappings(fullName, requirements, screens, [
    proposal("R1", [["Product Page", 0.9]], []),
  ], filePaths);

  assert.deepEqual(r.uncoveredIds, ["R2"]);
});
