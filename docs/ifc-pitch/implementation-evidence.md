# MGK IFC Pitch — Implementation Evidence

_Status: complete · 2026-08-24_

This file records the delivered submission artifacts, implementation decisions, verification evidence, and deviations from the approved claim ledger.

## Artifacts

- Editable two-page 16:9 deck: `docs/ifc-pitch/deck.html`.
- Exact two-page PDF: `docs/ifc-pitch/artifacts/mgk-ifc-pitch.pdf`.
- Page previews: `mgk-ifc-pitch-page-1.png` and `mgk-ifc-pitch-page-2.png` in the same artifacts directory.
- Reproducible renderer: `mgk-frontend/apps/web/scripts/render-ifc-deck.mjs`, exposed as `pnpm render:ifc-deck`.
- Partner sandbox route: `/demo/us-tech-100`.
- Deterministic settled preview: `/demo/us-tech-100?preview=settled`.
- Receipt-screen preview: `mgk-frontend/apps/web/artifacts/us-tech-100-receipt.png`.
- Claim, component, domain, and browser-flow tests alongside the implementation.

## Implementation evidence

- The deck contains the approved headline, English product description, Vietnamese executive summary, partner/MGK responsibility boundary, mechanism explanation, commercial model, and 30/90/180-day roadmap.
- The deck links to `https://mgkprotocol.vercel.app` and `https://github.com/mangekyou-labs/mgk-solana`.
- The sandbox is local-state only. It performs no wallet connection, backend request, live market-data request, or onchain write.
- Eligibility, amounts, balances, prices, fills, batch metadata, and receipts are visibly identified as sandbox or simulated data.
- The settled receipt exposes auction leg, uniform clearing price, filled quantity, allocation rule, batch identifier, ruleset, and verification hash.
- Official regulatory, licensing, IFC, and DFBA mechanism sources are rendered as accessible links.
- The existing SOL-PERP terminal, Rust programs, SDK wire formats, database, and public APIs were not changed.
- No deployment or production-chain operation was performed.

## Fresh verification

- `npx ai-devkit@latest lint` — passed; documentation structure valid.
- `pnpm lint` — passed with 0 errors and 6 pre-existing warnings in unrelated files.
- `pnpm typecheck` — passed.
- `pnpm test -- --reporter=dot` — passed: 52 files, 467 tests.
- `pnpm e2e e2e/us-tech-100.spec.ts --project=chromium --workers=1` — passed: 2 tests, including keyboard lifecycle and deterministic receipt screenshot.
- `pnpm build` — passed; Next.js production output includes `/demo/us-tech-100`.
- `pnpm render:ifc-deck` — passed; regenerated the PDF and both PNG previews.
- PDF page-object check — passed: exactly 2 pages.
- `cargo +stable clippy --all-targets --all-features -- -D warnings` — passed.
- `cargo +stable test --all-features` — passed: 397 tests, 5 ignored.

The repository's active custom `solana` Rust toolchain is Rust 1.79 and does not include the `cargo-clippy` component. Consequently, the literal unqualified clippy command cannot start, and the literal unqualified test command cannot compile current locked dependencies. The same required checks pass with the installed stable toolchain, in the required clippy-then-test order.

## Claim-guard coverage

Automated tests verify the approved headline and links, exact two-slide structure, prohibited-language exclusions, no direct-retail authorization or Nasdaq affiliation claim, visible prototype/roadmap distinctions, official source links, and fresh technical proof derived from the current repository rather than historical test-count claims.

## Deviations

No product, narrative, or deployment-scope deviations. Verification used `cargo +stable` for the Rust checks because of the active custom toolchain limitation documented above.
