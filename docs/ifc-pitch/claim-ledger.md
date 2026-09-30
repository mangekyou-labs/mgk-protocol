# MGK IFC Pitch — Design and Claim Ledger

_Status: approved implementation baseline · 2026-08-23_

## Audience and ask

- Audience: licensed members of Vietnam's International Financial Center considering permitted international-index products.
- Commercial ask: begin a legal, product, market-data, and execution design partnership; this is not a retail launch solicitation.
- Approved headline: “Fair execution infrastructure for Vietnam’s next Nasdaq-linked market.”

## Visual direction

- Deck: confident institutional navy combined with warm-editorial asymmetry; warm white field, deep navy ink, one MGK-red accent, flat rules instead of decorative cards.
- Prototype: compact institutional workstation with clear form hierarchy and a receipt that reads like evidence, not a consumer trading app.
- Typography: sans-serif narrative, monospace evidence labels and every numeric value.
- Motion: short, functional lifecycle transitions only; all state remains immediately legible with reduced motion.
- Exclusions: gradients, crypto imagery, decorative glass, generic feature-card grids, invented TAM, invented traction, and unsupported affiliations.

## Claim status

| Claim | Status | Required wording / evidence |
|---|---|---|
| MGK is a working open-source Solana DFBA perps prototype | Shipped prototype | Repository implementation and fresh CI commands; devnet-only, pre-commercial, unaudited |
| DFBA separates maker/taker intent and runs two independent uniform-price auctions | Mechanism | Jump Crypto's original DFBA concept |
| Vietnam IFC has launched and Nasdaq is a founding HCMC member | External fact | Vietnam Government News, 11 February 2026 |
| IFC prioritizes new financial products, sandbox mechanisms, and digital infrastructure | External fact | Vietnam Government News and IFC legislation portal |
| Named Nasdaq index products require licensing | External fact | Nasdaq Global Index licensing page |
| CME's exclusive Nasdaq-100 futures license runs through 2039 | External fact | Nasdaq investor-relations release |
| Vietnamese outward portfolio investment is regulated | External fact | Decree 135/2015/ND-CP |
| SSC has warned about unlicensed international securities platforms | External fact | State Securities Commission investor warning |
| Vietnam operates a crypto-asset market pilot | External fact | Resolution 05/2025/NQ-CP |
| Founder: Kyler Nguyen / Mangekyou Labs; Vietnam eligibility; MGK, Oreka, Kamui, and ZK engineering | Founder-provided | Present as founder background, not third-party endorsement |

## Product boundary

| Licensed partner owns | MGK supplies |
|---|---|
| Eligibility and onboarding | Deterministic batch execution |
| KYC/AML and sanctions controls | Maker/taker intent separation |
| Product and regulatory approval | Uniform-price dual-auction logic |
| Custody, collateral, and cash settlement | Verifiable batch and allocation evidence |
| Market data and index rights | Integration surface for a supervised pilot |

The “US Tech 100 Sandbox” uses simulated prices, balances, fills, and verification metadata. It performs no wallet request, backend call, market-data request, or onchain write. A named live index product remains a partnership and licensing milestone.

## Capability labels

- **Working now:** open-source DFBA perps code, deterministic matching, devnet prototype, SOL collateral.
- **Demonstrated here:** local-state partner sandbox and simulated deterministic receipt.
- **Roadmap:** legal/index review, design-partner interviews, stable-value collateral architecture, market makers, independent security review, supervised pilot.

## Commercial model

Integration/platform license plus a volume-linked execution fee. No price point, user count, volume, TVL, approval, or partnership is claimed.

## Sources

1. [Vietnam Government News — IFC debut in HCMC](https://en.baochinhphu.vn/international-financial-center-makes-debut-in-hcmc-111260211112728619.htm)
2. [Jump Crypto — Dual Flow Batch Auction](https://jumpcrypto.com/resources/dual-flow-batch-auction)
3. [Nasdaq — Index licensing and ETPs](https://www.nasdaq.com/products/global-indexes/licensing-and-etps)
4. [Nasdaq — CME exclusive Nasdaq-100 futures license through 2039](https://ir.nasdaq.com/news-releases/news-release-details/cme-group-and-nasdaq-extend-exclusive-nasdaq-100-futures-license)
5. [Government of Vietnam — Decree 135/2015/ND-CP](https://vanban.chinhphu.vn/default.aspx?docid=182926&pageid=27160)
6. [State Securities Commission — investor warning](https://ssc.gov.vn/webcenter/portal/ubck/pages_r/l/chitit?dDocName=APPSSCGOVVN162147174)
7. [Vietnam IFC Da Nang — legislation](https://vifcdanang.vn/legislation.htm)
8. [Government of Vietnam — Resolution 05/2025/NQ-CP](https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-quyet-so-5-2025-nq-cp-ve-trien-khai-thi-diem-thi-truong-tai-san-ma-hoa-tai-viet-nam-119250909184045221.htm)
