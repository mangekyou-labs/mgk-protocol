# Security report history

## 2026-08-24 — feature-dfba-auction
- Mode: Comprehensive
- Findings (initial on-chain): 14 (C: 2, H: 5, M: 4, L: 2, I: 2)
- New: 14 | Resolved (this slice): C01 C02 H01 H02 H03 H05 M01; H04 partial (direct invoke only)
- Persistent (accepted / mainnet blockers): H04 Core-caller residual, M02 CORS, M03 unpinned GHA + dead Kani, M04 single upgrade authority, L01 gitignored RENDER_API_KEY, L02 CU-ignored tests, I01 transitive audits, I02 host PDA stub
- Confidence gate: 2/10
- Independent audit: not claimed
- Report: `feature-dfba-auction-2026-08-24.md`

## 2026-08-24 — feature-dfba-auction (frontend/operator re-audit close-out)
- Mode: Comprehensive
- Findings: 26 (C: 2, H: 9, M: 9, L: 3, I: 3)
- New this wave: F-KEEPER-LAYOUT, F-SQLI-CANDLES, F-ORACLE-QUORUM, F-LIQ-DEAD, F-GPA-DOS, F-INDEXER-TRUST, F-SKIP-PREFLIGHT, F-SDK-SETTLE, F-BOOK-CACHE, F-HELIUS-PUBLIC, F-E2E-LAYOUT
- Resolved: F-KEEPER-LAYOUT, F-SQLI-CANDLES, F-ORACLE-QUORUM, F-LIQ-DEAD, F-GPA-DOS (REST), F-INDEXER-TRUST, F-SKIP-PREFLIGHT, F-SDK-SETTLE (SDK), F-BOOK-CACHE
- Accepted: F-HELIUS-PUBLIC (warn-only, no rotation); leftover indexer `keeper.ts` GPA + 5-byte SettleBatch (compatible bump 0); operator GPA in `ops-keeper.js`
- Persistent: H04 Core-caller residual, M02–M04, L01–L02, I01–I02
- Unresolved Critical/High fund-flow: 0; unresolved safety-relevant Medium: 0
- Confidence gate: 2/10
- Independent audit: not claimed
- Report: `feature-dfba-auction-2026-08-24.md`

## 2026-08-24 — feature-dfba-auction (C03–C06 skip-reinit / fill-gate)
- Mode: Comprehensive
- New: C03 Initialize governance overwrite, C04 InitVault wipe, C05 SettleBatch length-only fill apply, C06 Oracle Initialize overwrite
- Resolved: C03, C04, C05 (length-OR), C06 — TDD helpers + instruction gates; discs/layouts/IDs unchanged
- Accepted residual: C05 post-Clear matcher-owned results substitution (results pubkey on Batch is a layout break)
- Persistent: H04 Core-caller residual, M02–M04, L01–L02, I01–I02
- Unresolved Critical/High fund-flow: 0; unresolved safety-relevant Medium: 0
- Evidence: clippy clean; cargo test common 48 / oracle 7 / core 291 / lifecycle 7+4 ignored / matcher 116+1 ignored; lib build ok; sbf 2026-08-25 00:02 (oracle 13360, core 145464, matcher 120344); tools 69
- Confidence gate: 2/10
- Independent audit: not claimed
- Report: `feature-dfba-auction-2026-08-24.md`

## 2026-08-25 — feature-dfba-auction (secrets/CI subagent calibration)
- Mode: Comprehensive
- Parallel scan: 16 claims; **not** treated as new P0
- Stale vs tree (already remediations): CSO-04 SQL candles, CSO-12 oracle timeouts, CSO-13 ephemeral keypair, “no security-reports”
- Already accepted / rotation unauthorized: CSO-01 RENDER_API_KEY, CSO-02 Helius, CSO-03 upgrade EOA, CSO-05 CORS, CSO-06 unpinned GHA + dead Kani, CSO-09/10 audits
- New recorded: F-CSP-CONNECT (`connect-src` includes `https:`) — accepted P2, not funds Medium
- Unresolved Critical/High fund-flow: 0; unresolved safety-relevant Medium: 0
- No key rotation, chmod of `.env`, authority transfer, or deploy
- Confidence gate: 2/10
- Independent audit: not claimed
- Report: `feature-dfba-auction-2026-08-24.md`
