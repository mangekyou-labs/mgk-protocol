# mgk Perpetual Futures

mgk uses dual flow batch auctions (DFBA) to trade perpetual futures against a persistent resting order book.

## Language

**Settlement**:
The transition that accounts for a cleared batch's fills, portfolio changes, protocol fees, mark and funding, then opens the next batch for collection.
_Avoid_: Matching, clearing (these determine auction results before settlement).
