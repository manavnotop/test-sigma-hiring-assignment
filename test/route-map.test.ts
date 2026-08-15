import { test } from "node:test";
import assert from "node:assert/strict";
import { appRouterRoute, RouteMap } from "../src/code/route-map.js";

test("appRouterRoute maps app-router page files", () => {
  assert.equal(appRouterRoute("app/product/page.tsx"), "/product");
  assert.equal(appRouterRoute("app/product/[handle]/page.tsx"), "/product/[handle]");
  assert.equal(appRouterRoute("app/[[...slug]]/page.tsx"), "/[[...slug]]");
  assert.equal(appRouterRoute("app/(shop)/page.tsx"), "/(shop)");
});

test("appRouterRoute rejects non-route files", () => {
  assert.equal(appRouterRoute("app/layout.tsx"), null);
  assert.equal(appRouterRoute("app/product/[handle]/page.test.ts"), null);
  assert.equal(appRouterRoute("lib/utils.ts"), null);
  assert.equal(appRouterRoute("components/button.tsx"), null);
});

test("RouteMap.resolve matches dynamic segments", () => {
  const map = RouteMap.fromFiles([
    { path: "app/product/[handle]/page.tsx" },
    { path: "app/cart/page.tsx" },
  ]);
  assert.deepEqual(map.resolve("/product/abc"), {
    filePath: "app/product/[handle]/page.tsx",
    routePattern: "/product/[handle]",
  });
  assert.deepEqual(map.resolve("/cart"), {
    filePath: "app/cart/page.tsx",
    routePattern: "/cart",
  });
});

test("RouteMap.resolve prefers static over dynamic segments", () => {
  const map = RouteMap.fromFiles([
    { path: "app/[page]/page.tsx" },
    { path: "app/search/page.tsx" },
  ]);
  assert.deepEqual(map.resolve("/search"), {
    filePath: "app/search/page.tsx",
    routePattern: "/search",
  });
  assert.deepEqual(map.resolve("/about"), {
    filePath: "app/[page]/page.tsx",
    routePattern: "/[page]",
  });
});

test("RouteMap.resolve returns null when nothing matches", () => {
  const map = RouteMap.fromFiles([{ path: "app/cart/page.tsx" }]);
  assert.deepEqual(map.resolve("/cart"), {
    filePath: "app/cart/page.tsx",
    routePattern: "/cart",
  });
  assert.equal(map.resolve("/cart/extra"), null); // segment count mismatch
  assert.equal(map.resolve("/"), null);
  assert.equal(map.resolve("/nonexistent"), null);
});

test("RouteMap ignores query strings and base paths via pathname", () => {
  const map = RouteMap.fromFiles([{ path: "app/product/[handle]/page.tsx" }]);
  assert.equal(map.resolve("/product/abc"), map.resolve(new URL("https://x.test/product/abc?tab=1").pathname));
});
