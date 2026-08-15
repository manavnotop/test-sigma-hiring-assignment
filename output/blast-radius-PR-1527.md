# 🛡️ Blast-radius report — PR #1527

**Fix stored XSS in product JSON-LD via unescaped JSON.stringify (CWE-79)** · `open` · base `main` → head `fix/json-ld-xss-script-tag-injection` @ `ec6b916`

> Written for a QA lead who knows the product but not the code. This copy was generated **offline** from the committed crawl artifacts (no knowledge graph, no LLM): the affected-files/screens/flows sections below are deterministic and reproducible with `npm run report` — the same traversal the full-pipeline report runs (artifact adapter vs graph adapter), so the sets agree. The requirements and narrative sections require the connect and reason stages — run `npm run all` (Docker + OpenRouter key) to produce them. See `docs/sample-output.md` for the full-pipeline version.

## Summary

PR #1527 changes 1 file(s) in the code layer: app/product/[handle]/page.tsx. The deterministic route map links that to 12 captured screen(s) at risk (Product Detail Page, Acme Cup Product Detail, Product Detail Page, Product Detail Page, Acme Hoodie Product Detail, Acme Mug Product Detail, Acme Prism T-Shirt Product, Acme Rainbow Sticker Details, Acme Slip-On Shoes Product Page, Acme Sticker Product Detail, Product Detail Page, Acme Webcam Cover Product Page).

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

- Acme Mug Product Detail → Acme Prism T-Shirt Product
- Acme Prism T-Shirt Product → Acme Webcam Cover Product Page
- Product Detail Page → Acme Slip-On Shoes Product Page
- Acme Slip-On Shoes Product Page → Product Detail Page
- Product Detail Page → Product Detail Page
- Product Detail Page → Acme Cup Product Detail
- Acme Cup Product Detail → Acme Hoodie Product Detail

## 📋 Requirements at risk

_not computed in offline mode — requires the knowledge graph (connect stage). Reproduce with `npm run all`._

## ⚠️ Requirements losing coverage

_not computed in offline mode — requires the knowledge graph (connect stage). Reproduce with `npm run all`._

## 🔍 Pre-existing gaps (requirements with no UI coverage)

_not computed in offline mode — requires the knowledge graph (connect stage). Reproduce with `npm run all`._

## 🧪 What to test

- Product Detail Page — `https://demo.vercel.store/product/acme-bomber-jacket`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Cup Product Detail — `https://demo.vercel.store/product/acme-cup`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Product Detail Page — `https://demo.vercel.store/product/acme-drawstring-bag`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Product Detail Page — `https://demo.vercel.store/product/acme-geometric-circles-t-shirt`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Hoodie Product Detail — `https://demo.vercel.store/product/acme-hoodie`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Mug Product Detail — `https://demo.vercel.store/product/acme-mug`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Prism T-Shirt Product — `https://demo.vercel.store/product/acme-rainbow-prism-t-shirt`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Rainbow Sticker Details — `https://demo.vercel.store/product/acme-rainbow-sticker`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Slip-On Shoes Product Page — `https://demo.vercel.store/product/acme-slip-on-shoes`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Sticker Product Detail — `https://demo.vercel.store/product/acme-sticker`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Product Detail Page — `https://demo.vercel.store/product/acme-t-shirt`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.
- Acme Webcam Cover Product Page — `https://demo.vercel.store/product/acme-webcam-cover`: exercise the screen end-to-end (load, primary interactions, navigation) after the change.

## ⚠️ Risk areas

- Offline report: the risk narrative requires the LLM synthesis stage (run `npm run all`). The deterministic sections above stand on their own.

## 🔧 What changed in code

- app/product/[handle]/page.tsx (modified, +3/−1)

Affected code (via graph-equivalent traversal): app/product/[handle]/page.tsx

## 🔍 Honesty & confidence

- Confidence on cross-layer links: **not computed in offline mode** (requires the connect stage).
- Layers used: ✅ Requirements (9 ingested) · ✅ DOM/UI (25 screens crawled) · ✅ Code (66 files parsed, tree-sitter) · ⚪ Knowledge graph (offline)
- Requirements in the graph: R1 Provider-specific template implementation; R2 Provider demo availability; R3 Asset download for providers; R4 Install Orama Search Integration; R5 Install React Bricks Visual CMS Integration; R6 Set up environment variables; R7 Install Vercel CLI and link local instance; R8 Download environment variables; R9 Install dependencies and start development server
