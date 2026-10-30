import {encodeInstruction,instructions} from '../../../layout/instructions.js';
/**
 * mgk perps-core instruction encoders.
 *
 * Single-byte discriminator (not Anchor's 8-byte SHA256). All multi-byte
 * fields are little-endian. Discriminator table mirrors the Rust
 * `CoreInstruction` enum in programs/perps-core/src/instructions/mod.rs:29-44.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Side } from '../instruction.js';
import { OrderType } from '../state/types.js';

export const CORE_INSTRUCTION = {
  Initialize: instructions.core.Initialize.disc,
  InitPortfolio: instructions.core.InitPortfolio.disc,
  Deposit: instructions.core.Deposit.disc,
  Withdraw: instructions.core.Withdraw.disc,
  CommitOrder: instructions.core.CommitOrder.disc,
  RevealOrder: instructions.core.RevealOrder.disc,
  CloseCommitting: instructions.core.CloseCommitting.disc,
  ClearBatch: instructions.core.ClearBatch.disc,
  SettleBatch: instructions.core.SettleBatch.disc,
  LiquidateUser: instructions.core.LiquidateUser.disc,
  AddInstrument: instructions.core.AddInstrument.disc,
  CancelRestingOrder: instructions.core.CancelRestingOrder.disc,
  ModifyRestingOrder: instructions.core.ModifyRestingOrder.disc,
  CancelAllRestingOrders: instructions.core.CancelAllRestingOrders.disc,
  SetPauseFlags: instructions.core.SetPauseFlags.disc,
  InitVault: instructions.core.InitVault.disc,
  CreateBatch: instructions.core.CreateBatch.disc,
  SetBatchCounter: instructions.core.SetBatchCounter.disc,
  CreatePortfolio: instructions.core.CreatePortfolio.disc,
  InitPortfolioForUser: instructions.core.InitPortfolioForUser.disc,
  /** DFBA single-tx open post (replaces Commit+Reveal). */
  PostOrder: instructions.core.PostOrder.disc,
  /** Governance-only: update batch parameters. */
  SetBatchParams: instructions.core.SetBatchParams.disc,
  /** Governance-only: retune instrument taker/maker fees. */
  SetInstrumentFees: instructions.core.SetInstrumentFees.disc,
  /** Governance-only: bind instrument to price oracle account. */
  SetInstrumentOracle: instructions.core.SetInstrumentOracle.disc,
  /** Governance-only: update D7 funding parameters. */
  SetFundingParams: instructions.core.SetFundingParams.disc,
  /** Authenticated matcher book initialization. */
  InitializeBook: instructions.core.InitializeBook.disc,
} as const;

/** Matcher program discriminators (perps-matcher entrypoint). */
export const MATCHER_INSTRUCTION = {
  ComputeClearing: instructions.matcher.ComputeClearing.disc,
  CancelResting: instructions.matcher.CancelResting.disc,
  ModifyResting: instructions.matcher.ModifyResting.disc,
  ClearAndMatch: instructions.matcher.ClearAndMatch.disc,
  CancelAll: instructions.matcher.CancelAll.disc,
  DfbaClear: instructions.matcher.DfbaClear.disc,
  PlaceResting: instructions.matcher.PlaceResting.disc,
  InitializeBook: instructions.matcher.InitializeBook.disc,
  ConsumeResults: instructions.matcher.ConsumeResults.disc,
} as const;
export type CoreInstruction =
  (typeof CORE_INSTRUCTION)[keyof typeof CORE_INSTRUCTION];

/**
 * InitPortfolio — discriminator + user pubkey + bump, 34 bytes total.
 * Wire format: disc(1) + user(32) + bump(1) = 34.
 *
 * Entrypoint `process_init_portfolio_inner` reads data[0..32] as the
 * user pubkey and data[32] as the bump. The discriminator is stripped
 * by the dispatch layer before reaching the inner function.
 */
export function encodeInitPortfolio(user: Uint8Array, bump: number): Uint8Array {
  return encodeInstruction('core','InitPortfolio',{user,bump});
}

/**
 * Deposit — discriminator + amount (u64 LE).
 */
export function encodeDeposit(amount: bigint): Uint8Array {
  return encodeInstruction('core','Deposit',{amount});
}

/**
 * Withdraw — discriminator + amount (u64 LE).
 */
export function encodeWithdraw(amount: bigint): Uint8Array {
  return encodeInstruction('core','Withdraw',{amount});
}

export interface CommitOrderParams {
  orderType: OrderType;
  instrumentId: number;
  reduceOnly: boolean;
  side: Side;
  price: bigint;
  qty: bigint;
  salt: bigint;
  batchId: bigint;
  commitmentBump: number;
}

/**
 * CommitOrder — discriminator + 9 fields, 39 bytes total.
 * Layout mirrors `process_commit_order` in
 * programs/perps-core/src/instructions/commit_order.rs:96-105.
 */
export function encodeCommitOrder(params: CommitOrderParams): Uint8Array {
  return encodeInstruction('core','CommitOrder',{...params});
}

export interface RevealOrderParams {
  orderType: OrderType;
  instrumentId: number;
  reduceOnly: boolean;
  side: Side;
  price: bigint;
  qty: bigint;
  salt: bigint;
  batchId: bigint;
}

/**
 * RevealOrder — discriminator + 8 fields, 38 bytes total.
 * Layout mirrors `process_reveal_order` in
 * programs/perps-core/src/instructions/reveal_order.rs:18-25.
 * Note: no `commitment_bump` (only CommitOrder takes it).
 */
export function encodeRevealOrder(params: RevealOrderParams): Uint8Array {
  return encodeInstruction('core','RevealOrder',{...params});
}

/**
 * CloseCommitting — discriminator only, no extra data.
 * Wire format: disc(1) + (nothing) = 1 byte.
 * DFBA: transitions Committing → Clearing (skips reveal).
 */
export function encodeCloseCommitting(): Uint8Array {
  return encodeInstruction('core','CloseCommitting',{});
}

export interface PostOrderParams {
  side: Side;
  /** false = taker (default), true = maker */
  isMaker?: boolean;
  price: bigint;
  qty: bigint;
  instrumentId: number;
  reduceOnly?: boolean;
}

/**
 * PostOrder (disc 20) — DFBA open limit post.
 * Wire: disc(1) + side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1) = 22
 */
export function encodePostOrder(params: PostOrderParams): Uint8Array {
  return encodeInstruction('core','PostOrder',{...params});
}

/**
 * Matcher DfbaClear (disc 5).
 * Wire: disc(1) + marginal_size_cap(8) + num_orders(2, always zero) + batch_id(8).
 * Requires the core registry PDA signer; invoked by Core ClearBatch.
 */
export function encodeDfbaClear(batchId: bigint, marginalSizeCap: bigint = BigInt('0xFFFFFFFFFFFFFFFF')): Uint8Array {
  return encodeInstruction('matcher','DfbaClear',{batchId,marginalSizeCap,numOrders:0});
}

/**
 * Matcher PlaceResting (disc 6) — usually invoked via Core PostOrder CPI.
 * Wire: disc(1) + user(32) + side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1) = 54
 */
export function encodePlaceResting(
  user: Uint8Array,
  side: Side,
  isMaker: boolean,
  price: bigint,
  qty: bigint,
  instrumentId: number,
  reduceOnly = false,
): Uint8Array {
  return encodeInstruction('matcher','PlaceResting',{user,side,isMaker,price,qty,instrumentId,reduceOnly});
}

/**
 * ClearBatch — discriminator + 3 u16 LE counts, 7 bytes total.
 * Wire format: disc(1) + num_commitments(2) + num_instruments(2) + num_portfolios(2) = 7.
 */
export function encodeClearBatch(
  numCommitments: number,
  numInstruments: number,
  numPortfolios: number,
): Uint8Array {
  return encodeInstruction('core','ClearBatch',{numCommitments,numInstruments,numPortfolios});
}

/**
 * SettleBatch — discriminator + 2 u16 LE counts, 5 bytes total.
 * Wire format: disc(1) + num_commitments(2) + num_portfolios(2) = 5.
 */
export function encodeSettleBatch(
  numCommitments: number,
  numPortfolios: number,
): Uint8Array {
  return encodeInstruction('core','SettleBatch',{numCommitments,numPortfolios});
}

/**
 * SOL-PERP takeover at a validated conversion oracle. Cancels victim orders,
 * then transfers signed quarter-position steps into the liquidator portfolio.
 * Wire: disc(9) + num_instruments(1 as u16 LE). No auction mark is required.
 */
export function encodeLiquidateUser(numInstruments = 1): Uint8Array {
  if(numInstruments!==1)throw new Error('Only one SOL-PERP instrument is supported'); return encodeInstruction('core','LiquidateUser',{numInstruments});
}

export interface LiquidateUserAccounts {
  victimPortfolio: PublicKey;
  registry: PublicKey;
  vault: PublicKey;
  liquidator: PublicKey;
  liquidatorPortfolio: PublicKey;
  instrument: PublicKey;
  oracle: PublicKey;
  book: PublicKey;
  matcher: PublicKey;
}

/**
 * The liquidator wallet must sign and own liquidatorPortfolio.
 * Request a 1,400,000 compute-unit budget for a worst-case full liquidation.
 */
export function buildLiquidateUser(
  programId: PublicKey,
  accounts: LiquidateUserAccounts,
): TransactionInstruction {
  const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
    pubkey, isWritable, isSigner,
  });
  return new TransactionInstruction({
    programId,
    keys: [
      meta(accounts.victimPortfolio, true),
      meta(accounts.registry, true),
      meta(accounts.vault, true),
      meta(accounts.liquidator, false, true),
      meta(accounts.liquidatorPortfolio, true),
      meta(accounts.instrument),
      meta(accounts.oracle),
      meta(accounts.book, true),
      meta(accounts.matcher),
    ],
    data: Buffer.from(encodeLiquidateUser()),
  });
}

/**
 * CancelRestingOrder — discriminator + order_id (u64), 9 bytes total.
 * Wire format: disc(1) + order_id(8) = 9.
 */
export function encodeCancelRestingOrder(orderId: bigint): Uint8Array {
  return encodeInstruction('core','CancelRestingOrder',{orderId});
}

/**
 * ModifyRestingOrder — discriminator + order_id (u64) + new_qty (u64), 17 bytes total.
 * Wire format: disc(1) + order_id(8) + new_qty(8) = 17.
 */
export function encodeModifyRestingOrder(
  orderId: bigint,
  newQty: bigint,
): Uint8Array {
  return encodeInstruction('core','ModifyRestingOrder',{orderId,newQty});
}

export interface AddInstrumentParams {
  instrumentId: number;
  tickSize: bigint;
  lotSize: bigint;
  imrBps: number;
  mmrBps: number;
  takerFeeBps: number;
  makerFeeBps: number;
  oracleAddr: Uint8Array;
  bump: number;
}

/**
 * AddInstrument (governance-only) — discriminator + 59 bytes, 60 total.
 * Wire format: disc(1) + instrument_id(2) + tick_size(8) + lot_size(8)
 *   + imr_bps(2) + mmr_bps(2) + taker_fee_bps(2) + maker_fee_bps(2)
 *   + oracle_addr(32) + bump(1) = 60.
 */
export function encodeAddInstrument(params: AddInstrumentParams): Uint8Array {
  return encodeInstruction('core','AddInstrument',{...params});
}

/**
 * Initialize — discriminator + 140-byte required body + optional vault bump.
 * Registry parameters precede instrument parameters; see the shared instruction
 * table and process_initialize_inner. The SDK supplies the vault bump (142 total).
 */
export interface InitializeParams {
  governance: Uint8Array;
  baseDeposit: bigint;
  nMin: number;
  tMinSlots: bigint;
  tMaxSlots: bigint;
  tRevealSlots: bigint;
  instrumentId: number;
  tickSize: bigint;
  lotSize: bigint;
  imrBps: number;
  mmrBps: number;
  takerFeeBps: number;
  makerFeeBps: number;
  oracleAddr: Uint8Array;
  registryBump: number;
  instrumentBump: number;
  vaultBump?: number;
  /** @deprecated Initialize no longer accepts a batch bump. */
  batchBump?: number;
  instrumentCount?: number;
  volatilityMultiplier?: number;
  batchIdCounter?: bigint;
}

export function encodeInitialize(params: InitializeParams): Uint8Array {
  return encodeInstruction('core','Initialize',{instrumentCount:1,volatilityMultiplier:10000,batchIdCounter:0n,...params});
}

/**
 * CreatePortfolio — discriminator + bump, 2 bytes total.
 * Atomic create + initialize via invoke_signed(SystemProgram.createAccount).
 * Wire format: disc(1) + bump(1) = 2.
 */
export function encodeCreatePortfolio(bump: number): Uint8Array {
  return encodeInstruction('core','CreatePortfolio',{bump});
}

/**
 * InitPortfolioForUser — discriminator + user_pubkey, 33 bytes total.
 * Keeper calls this to create + initialize a Portfolio PDA for a user.
 * Wire format: disc(1) + user_pubkey(32) = 33.
 * Entrypoint strips disc 19, passes 32-byte user pubkey to inner function.
 */
export function encodeInitPortfolioForUser(user: Uint8Array): Uint8Array {
  return encodeInstruction('core','InitPortfolioForUser',{user});
}

/**
 * SetInstrumentFees (disc 22) — governance retune of taker/maker fees.
 * Wire: disc(1) + taker_fee_bps(u16 LE) + maker_fee_bps(i16 LE) = 5
 */
export function encodeSetInstrumentFees(
  takerFeeBps: number,
  makerFeeBps: number,
): Uint8Array {
  return encodeInstruction('core','SetInstrumentFees',{takerFeeBps,makerFeeBps});
}

/**
 * SetInstrumentOracle (disc 23) — governance-only instrument oracle binding.
 * Wire: disc(1) = 1 byte.
 */
export function encodeSetInstrumentOracle(): Uint8Array {
  return encodeInstruction('core','SetInstrumentOracle',{});
}

/**
 * SetFundingParams (disc 24) — governance-only D7 funding parameter update.
 * Wire: disc(1) + coefficient_bps(i64 LE) + max_rate_bps(i64 LE) + interval_slots(u64 LE) = 25
 */
export function encodeSetFundingParams(
  coefficientBps: number,
  maxRateBps: number,
  intervalSlots: number,
): Uint8Array {
  return encodeInstruction('core','SetFundingParams',{coefficientBps,maxRateBps,intervalSlots});
}

/** InitializeBook — disc(1) + instrument_id(u16 LE). */
export function encodeInitializeBook(instrumentId: number): Uint8Array {
  return encodeInstruction('core','InitializeBook',{instrumentId});
}
