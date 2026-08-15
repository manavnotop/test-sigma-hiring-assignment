# 🛡️ Blast-radius report — PR #1527

**Fix stored XSS in product JSON-LD via unescaped JSON.stringify (CWE-79)** · `open` · base `main` → head `fix/json-ld-xss-script-tag-injection` @ `ec6b916`

> Written for a QA lead who knows the product but not the code. The affected-screens/flows/requirements sections below come from a deterministic traversal of the knowledge graph (code → components → screens → flows → requirements); only the prose is written by an LLM.

## Summary

This fix prevents stored XSS in product JSON-LD blocks by escaping `<` and `>` characters in the JSON output. The vulnerability allowed a malicious product title or description to break out of the JSON-LD script tag and inject arbitrary JavaScript. All product detail pages are affected, and any user flow that renders a product page could be exploited if an attacker can modify product data via the admin or API.

## 🎯 Screens at risk

- Acme Baby Cap Product Page — `https://demo.vercel.store/product/acme-baby-cap`
- Acme Cup Product Detail — `https://demo.vercel.store/product/acme-cup`
- Product Detail Page — `https://demo.vercel.store/product/acme-dog-sweater`
- Acme Circles T-Shirt Product Details — `https://demo.vercel.store/product/acme-geometric-circles-t-shirt`
- 404 Page Not Found — `https://demo.vercel.store/product/acme-insulated-bottle`
- Acme Prism T-Shirt Product Page — `https://demo.vercel.store/product/acme-rainbow-prism-t-shirt`
- Acme Sticker Product Detail — `https://demo.vercel.store/product/acme-sticker`
- 404 Product Not Found — `https://demo.vercel.store/product/acme-travel-mug`

## 🔀 User flows affected

- Acme Baby Cap Product Page → 404 Product Not Found
- Acme Circles T-Shirt Product Details → Acme Cup Product Detail
- 404 Page Not Found → Acme Baby Cap Product Page
- 404 Product Not Found → Acme Sticker Product Detail

## 📋 Requirements at risk

_none_

## ⚠️ Requirements losing coverage

_none_

## 🔍 Pre-existing gaps (requirements with no UI coverage)

These were already untestable in the captured UI — this PR does not cause them, but they matter for planning:

- **R2** Provider integration via fork and swap

## 🧪 What to test

- Acme Baby Cap Product Page: verify that a product title containing </script><script>alert(1)</script> does not execute JavaScript and the JSON-LD block remains intact.
- Acme Cup Product Detail: same test with a malicious description.
- Product Detail Page: check that the fix does not break structured data rendering for normal product titles.
- Acme Circles T-Shirt Product Details: test with special characters like < and > in the product name.
- 404 Page Not Found: ensure the fix does not affect error pages that may render product data.
- Acme Prism T-Shirt Product Page: confirm that the JSON-LD block is properly escaped and valid.
- Acme Sticker Product Detail: test with an image URL containing </script>.
- 404 Product Not Found: verify no regression in product data display.
- Search Results for Shirts: ensure product cards linking to detail pages are safe.
- Bags Collection Listing: check that navigation from a product page to a listing page works correctly.

## ⚠️ Risk areas

- Stored XSS via product title, description, or image URL fields that are rendered in JSON-LD blocks on product detail pages.
- Potential bypass if the escaping is incomplete or if other fields (e.g., SKU, price) are not covered.
- Risk of breaking JSON-LD syntax for legitimate product data if the escaping is applied incorrectly.

## 🔧 What changed in code

- app/product/[handle]/page.tsx (modified, +3/−1)

Affected code (via graph): app/product/[handle]/page.tsx

## 🔍 Honesty & confidence

- Confidence on cross-layer links: **no cross-layer links for at-risk requirements**
- Layers used: ✅ Requirements · ✅ DOM/UI (25 screens crawled) · ✅ Code + graph (tree-sitter)
- Notes: The system could not verify whether the fix is applied to all product detail pages or only the specific file listed. Manual inspection of other pages that use similar JSON-LD rendering is recommended. · The fix only escapes < and >; other dangerous characters like &, ", or ' are not escaped but are handled by JSON.stringify. This is sufficient for the reported attack vector. · No requirements are at risk, but R2 (Provider integration via fork and swap) has no UI coverage, so any changes to that flow are not tested by this PR.
