# 🛡️ Blast-radius report — PR #1527

**Fix stored XSS in product JSON-LD via unescaped JSON.stringify (CWE-79)** · `open` · base `main` → head `fix/json-ld-xss-script-tag-injection` @ `ec6b916`

> Written for a QA lead who knows the product but not the code. The affected-screens/flows/requirements sections below come from a deterministic traversal of the knowledge graph (code → components → screens → flows → requirements); only the prose is written by an LLM. This is the committed full-pipeline output (25 screens crawled) — regenerate with `npm run all`.

## Summary

This PR fixes a stored XSS vulnerability in the JSON-LD script block on product detail pages. The fix escapes `<` and `>` characters in the JSON output to prevent attackers from injecting malicious scripts via product titles, descriptions, or image URLs. All product detail pages and any flows that navigate to them are affected, so QA should verify that product pages render correctly and that no script injection is possible.

## 🎯 Screens at risk

- Product Detail Page — `https://demo.vercel.store/product/acme-bomber-jacket`
- Acme Cup Product Detail — `https://demo.vercel.store/product/acme-cup`
- Product Detail Page — `https://demo.vercel.store/product/acme-drawstring-bag`
- Product Detail Page — `https://demo.vercel.store/product/acme-geometric-circles-t-shirt`
- Acme Hoodie Product Detail — `https://demo.vercel.store/product/acme-hoodie`
- Acme Mug Product Detail — `https://demo.vercel.store/product/acme-mug`
- Acme Prism T-Shirt Product — `https://demo.vercel.store/product/acme-rainbow-prism-t-shirt`
- Acme Rainbow Sticker Details — `https://demo.vercel.store/product/acme-rainbow-sticker`
- Acme Slip-On Shoes Product Page — `https://demo.vercel.store/product/acme-slip-on-shoes`
- Acme Sticker Product Detail — `https://demo.vercel.store/product/acme-sticker`
- Product Detail Page — `https://demo.vercel.store/product/acme-t-shirt`
- Acme Webcam Cover Product Page — `https://demo.vercel.store/product/acme-webcam-cover`

## 🔀 User flows affected

- Acme Cup Product Detail → Acme Hoodie Product Detail
- Product Detail Page → Acme Cup Product Detail
- Product Detail Page → Product Detail Page
- Acme Mug Product Detail → Acme Prism T-Shirt Product
- Acme Prism T-Shirt Product → Acme Webcam Cover Product Page
- Acme Slip-On Shoes Product Page → Product Detail Page
- Product Detail Page → Acme Slip-On Shoes Product Page

## 📋 Requirements at risk

_none_

## ⚠️ Requirements losing coverage

_none_

## 🔍 Pre-existing gaps (requirements with no UI coverage)

These were already untestable in the captured UI — this PR does not cause them, but they matter for planning:

- **R1** Provider-specific template implementation
- **R3** Asset download for providers
- **R4** Install Orama Search Integration
- **R5** Install React Bricks Visual CMS Integration
- **R6** Set up environment variables
- **R7** Install Vercel CLI and link local instance
- **R8** Download environment variables
- **R9** Install dependencies and start development server

## 🧪 What to test

- Product Detail Page (e.g., /product/acme-bomber-jacket) — verify JSON-LD block renders without breaking when product title contains special characters like </script>
- Acme Cup Product Detail -> Acme Hoodie Product Detail flow — ensure cross-product navigation does not trigger XSS
- Homepage Product Grid -> Search Product Listings -> Product Detail Page — test end-to-end flow with a product that has a malicious title in the database
- All product detail screens listed in blast radius — confirm no visible script execution or broken layout
- Stickers Collection Page -> Product Detail Page — check that JSON-LD is properly escaped after navigation

## ⚠️ Risk areas

- If the escaping is incomplete or breaks valid JSON, structured-data consumers (e.g., Google) may fail to parse product info, affecting SEO
- The fix only addresses the JSON-LD script block; other parts of the page using dangerouslySetInnerHTML may still be vulnerable
- Attackers with admin access could still inject malicious content that is rendered elsewhere (e.g., in meta tags or descriptions)

## 🔧 What changed in code

- app/product/[handle]/page.tsx (modified, +3/−1)

Affected code (via graph): app/product/[handle]/page.tsx

## 🔍 Honesty & confidence

- Confidence on cross-layer links: **no cross-layer links for at-risk requirements**
- Layers used: ✅ Requirements · ✅ DOM/UI (25 screens crawled) · ✅ Code + graph (tree-sitter)
- Notes: The system could not verify whether the fix is applied to all instances of JSON.stringify in the codebase — only the specific file was checked · No requirements are at risk, but pre-existing gaps (R1, R3–R9) have no UI coverage and were not tested · The blast radius includes many product detail pages and navigation flows, but the actual impact depends on whether product data is sanitized at input time
