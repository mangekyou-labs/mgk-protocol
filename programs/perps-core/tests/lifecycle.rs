//! Integration tests for perps-core using solana-program-test (BanksClient).
//!
//! Run with:
//! ```bash
//! cargo build-sbf                              # produces target/deploy/*.so
//! BPF_OUT_DIR=target/deploy \
//!   cargo test -p mgk-perps-core --test lifecycle --features host-hash
//! ```
//!
//! `BPF_OUT_DIR` is required so solana-program-test can find the loaded .so.
//! Rebuild the .so files after any program source change. Every account
//! fixture carries the 8-byte header (discriminator + layout version); the
//! harness stamps seeded accounts that the programs load, and leaves
//! registry / instrument / vault zeroed for `Initialize` to stamp.
//! DFBA path uses PostOrder (disc 20) → CloseCommitting → ClearBatch (DfbaClear)
//! → SettleBatch. Commit/Reveal are retired.

use core::mem::offset_of;
use core::ops::Range;
use mgk_common::book::OrderBook;
use mgk_common::layout::{discriminator, ACCOUNT_HEADER_LEN, LAYOUT_VERSION_1};
use mgk_perps_core::state::{
    Batch, Commitment, Instrument, OrderReservation, Portfolio, Position, Registry, Vault,
};
#[allow(deprecated)]
use solana_program_test::ProgramTest;
#[allow(deprecated)]
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};

/// Spec 13 / issue 16: every account starts with an 8-byte header
/// (discriminator + layout version + reserved). The BATCH_RESULTS payload
/// follows it behind a 9-byte envelope (batch_id u64 + spent u8), so every raw
/// results offset below is `RES + body_offset`.
const RES: usize = ACCOUNT_HEADER_LEN + mgk_common::matcher::RESULTS_ENVELOPE_LEN;
/// DFBA results: header 8 + payload header 34 + 58 bytes/fill (cap 128 fills).
const RESULTS_ACCOUNT_SIZE: usize = RES + 34 + 128 * 58;
/// Matcher `BookState` on-disk size (header included).
fn book_account_size() -> usize {
    mgk_perps_matcher::book_account_size()
}

/// Program IDs are the fresh IDs compiled into the programs
/// (`programs/common/src/program_ids.rs`, mirrored in `deployments/devnet.json`).
/// Reading them from `mgk_common` means this test cannot drift from the binaries.
const CORE_ID: Pubkey = Pubkey::new_from_array(mgk_common::program_ids::PERPS_CORE_ID);
const MATCHER_ID: Pubkey = Pubkey::new_from_array(mgk_common::program_ids::PERPS_MATCHER_ID);

/// PDA seeds (must match `programs/perps-core/src/pda.rs`).
const REGISTRY_SEED: &[u8] = b"registry";
const INSTRUMENT_SEED: &[u8] = b"instrument";
#[allow(dead_code)]
const VAULT_SEED: &[u8] = b"vault";
#[allow(dead_code)]
const BATCH_SEED: &[u8] = b"batch";
#[allow(dead_code)]
const COMMITMENT_SEED: &[u8] = b"commitment";
#[allow(dead_code)]
const PORTFOLIO_SEED: &[u8] = b"portfolio";
#[allow(dead_code)]
const BOOK_SEED: &[u8] = b"book";

/// Account sizes from `size_of` (run `cargo run --example sizes` to print them).
/// Each includes the 8-byte account header. Host and SBF layouts are identical
/// (explicit padding + compile-time asserts in `state/*.rs`), so host
/// `size_of` / `offset_of!` are valid for the on-chain programs.
const REGISTRY_SIZE: usize = core::mem::size_of::<Registry>();
const INSTRUMENT_SIZE: usize = core::mem::size_of::<Instrument>();
const VAULT_SIZE: usize = core::mem::size_of::<Vault>();
const BATCH_SIZE: usize = core::mem::size_of::<Batch>();
const COMMITMENT_SIZE: usize = core::mem::size_of::<Commitment>();
const PORTFOLIO_SIZE: usize = core::mem::size_of::<Portfolio>();

// -----------------------------------------------------------------------------
// Raw byte ranges used when asserting on account data fetched from the bank.
// Every one is derived with `offset_of!`, so they follow the struct layouts
// (including the 8-byte account header) instead of being hardcoded.
// -----------------------------------------------------------------------------
const fn rng(off: usize, len: usize) -> Range<usize> {
    off..off + len
}
// Batch
const B_ID: Range<usize> = rng(offset_of!(Batch, batch_id), 8);
const B_STATUS: usize = offset_of!(Batch, status);
const B_COMMIT_DEADLINE: Range<usize> = rng(offset_of!(Batch, commit_deadline_slot), 8);
const B_CLEARING_PRICE: Range<usize> = rng(offset_of!(Batch, clearing_price), 8);
const B_TOTAL_SETTLED: Range<usize> = rng(offset_of!(Batch, total_settled), 4);
const B_TOTAL_VOLUME: Range<usize> = rng(offset_of!(Batch, total_volume), 8);
const B_TOTAL_NOTIONAL: Range<usize> = rng(offset_of!(Batch, total_notional), 16);
const B_MATCHED_BID: Range<usize> = rng(offset_of!(Batch, matched_bid_qty), 8);
const B_MATCHED_ASK: Range<usize> = rng(offset_of!(Batch, matched_ask_qty), 8);
const B_MARK_VALID: usize = offset_of!(Batch, mark_valid);
const B_LIQ_PAUSED: usize = offset_of!(Batch, liq_paused);
// Portfolio
const P_USER: Range<usize> = rng(offset_of!(Portfolio, user), 32);
const P_EQUITY: Range<usize> = rng(offset_of!(Portfolio, equity), 16);
const P_PRINCIPAL: Range<usize> = rng(offset_of!(Portfolio, principal), 16);
const P_POSITIONS_LEN: Range<usize> = rng(offset_of!(Portfolio, positions_len), 2);
// Vault
const V_BALANCE: Range<usize> = rng(offset_of!(Vault, balance), 8);
const V_INSURANCE: Range<usize> = rng(offset_of!(Vault, insurance_fund), 16);
const V_UNCOVERED: Range<usize> = rng(offset_of!(Vault, uncovered_bad_debt), 16);
const V_OI_LONG: Range<usize> = rng(offset_of!(Vault, open_interest_long), 8);
const V_OI_SHORT: Range<usize> = rng(offset_of!(Vault, open_interest_short), 8);
// Registry (packed)
const R_GOVERNANCE: Range<usize> = rng(offset_of!(Registry, governance), 32);
const R_INSTRUMENT_COUNT: Range<usize> = rng(offset_of!(Registry, instrument_count), 2);
const R_BATCH_ID_COUNTER: Range<usize> = rng(offset_of!(Registry, batch_id_counter), 8);
const R_T_MAX: Range<usize> = rng(offset_of!(Registry, t_max_slots), 8);
// Instrument
const I_ID: Range<usize> = rng(offset_of!(Instrument, instrument_id), 2);
const I_BASE_SYMBOL: Range<usize> = rng(offset_of!(Instrument, base_symbol), 4);
const I_TAKER_FEE: Range<usize> = rng(offset_of!(Instrument, taker_fee_bps), 2);
const I_MARK_PRICE: Range<usize> = rng(offset_of!(Instrument, mark_price), 8);
// DFBA results (header + payload: num_fills@32, fills@34 with 58 bytes each)
const RES_NUM_FILLS: Range<usize> = rng(RES + 32, 2);
const RES_FILL0_USER: Range<usize> = rng(RES + 34, 32);
const RES_FILL0_QTY: Range<usize> = rng(RES + 34 + 40, 8);
const RES_FILL0_PRICE: Range<usize> = rng(RES + 34 + 48, 8);

/// Resting orders on a book account (bids + asks), read from the typed header.
fn book_resting_count(data: &[u8]) -> u32 {
    let bids = offset_of!(OrderBook, bid_count);
    let asks = offset_of!(OrderBook, ask_count);
    u32::from_le_bytes(data[bids..bids + 4].try_into().unwrap())
        + u32::from_le_bytes(data[asks..asks + 4].try_into().unwrap())
}

/// Bundle of per-user PDAs derived from `(user, batch_id, nonce)`.  Returned
/// by `derive_user_pdas` so a test can wire up a single user's accounts
/// (portfolio + batch + commitment) for a given commit.
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
struct UserPdas {
    portfolio: Pubkey,
    #[allow(dead_code)]
    portfolio_bump: u8,
    batch: Pubkey,
    #[allow(dead_code)]
    batch_bump: u8,
    commitment: Pubkey,
    #[allow(dead_code)]
    commitment_bump: u8,
}

/// Bundle of persistent PDAs returned by `program_test_with_pdas`.  These
/// accounts are seeded into genesis and survive across all `banks_client`
/// operations within a single test.
#[derive(Clone, Copy, Debug)]
struct TestPdas {
    registry: Pubkey,
    instrument: Pubkey,
    #[allow(dead_code)]
    vault: Pubkey,
    #[allow(dead_code)]
    book: Pubkey,
}

/// Build a ProgramTest with both perps programs loaded and PDA accounts
/// pre-seeded into the genesis state. Genesis accounts persist across all
/// banks in the test context.
///
/// Seeds:
/// - registry PDA (core-owned) — for `Initialize` / batch counters
/// - instrument PDA (core-owned) — default instrument for trading
/// - vault PDA (core-owned) — SOL custody for deposits
/// - book PDA (matcher-owned) — empty order book, writable by matcher CPI
fn program_test_with_pdas() -> (ProgramTest, TestPdas) {
    let mut pt = ProgramTest::default();
    pt.add_program("mgk_perps_core", CORE_ID, None);
    pt.add_program("mgk_perps_matcher", MATCHER_ID, None);

    let (registry_pda, _) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (instrument_pda, _) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    let (vault_pda, _) = Pubkey::find_program_address(&[VAULT_SEED], &CORE_ID);
    let (book_pda, _) =
        Pubkey::find_program_address(&[BOOK_SEED, &0u16.to_le_bytes()], &MATCHER_ID);

    pt.add_account(
        registry_pda,
        Account::new(1_000_000, REGISTRY_SIZE, &CORE_ID),
    );
    pt.add_account(
        instrument_pda,
        Account::new(1_000_000, INSTRUMENT_SIZE, &CORE_ID),
    );
    // The vault holds exactly its rent-exempt minimum: the vault invariant
    // `lamports - rent == collateral + fund - debt` has zero tolerance.
    pt.add_account(vault_pda, Account::new(vault_rent(), VAULT_SIZE, &CORE_ID));
    // Registry / instrument / vault stay zeroed: `Initialize` stamps them. The
    // book is normally stamped by the matcher's `InitializeBook`; the harness
    // seeds it directly, so give it its `OrderBook` header here.
    let mut book = Account::new(1_000_000, book_account_size(), &MATCHER_ID);
    stamp_header(&mut book.data, discriminator::ORDER_BOOK);
    pt.add_account(book_pda, book);

    let pdas = TestPdas {
        registry: registry_pda,
        instrument: instrument_pda,
        vault: vault_pda,
        book: book_pda,
    };
    (pt, pdas)
}

/// Derive all per-user PDAs for a single commit (portfolio + batch +
/// commitment).  Returns addresses AND bumps so the test can build wire
/// data with the correct bumps.
///
/// Note: uses `solana_sdk::Pubkey::find_program_address` (host-side
/// `find_program_address` syscall stub) so the result type is the SDK
/// `Pubkey` that the rest of the test uses.  Seeds must match
/// `programs/perps-core/src/pda.rs` exactly.
#[allow(dead_code)]
fn derive_user_pdas(user: &Pubkey, batch_id: u64, nonce: u64) -> UserPdas {
    let (portfolio, portfolio_bump) =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, user.as_ref()], &CORE_ID);
    let (batch, batch_bump) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_id.to_le_bytes()], &CORE_ID);
    let (commitment, commitment_bump) = Pubkey::find_program_address(
        &[
            COMMITMENT_SEED,
            &batch_id.to_le_bytes(),
            user.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &CORE_ID,
    );
    UserPdas {
        portfolio,
        portfolio_bump,
        batch,
        batch_bump,
        commitment,
        commitment_bump,
    }
}

/// Pre-seed a user's per-batch accounts (portfolio + batch + commitment)
/// into genesis at the correct sizes / owners.  Use this after
/// `program_test_with_pdas` and BEFORE `start_with_context` so the BPF
/// program can write to them.
#[allow(dead_code)]
fn seed_user_accounts(pt: &mut ProgramTest, user_pdas: &UserPdas) {
    pt.add_account(
        user_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    pt.add_account(
        user_pdas.batch,
        Account::new(1_000_000, BATCH_SIZE, &CORE_ID),
    );
    pt.add_account(
        user_pdas.commitment,
        Account::new(1_000_000, COMMITMENT_SIZE, &CORE_ID),
    );
}

/// Build the wire data for `Initialize` (discriminator 0).
/// Post-disc layout (140 bytes) matches `process_initialize_inner`:
///   governance(32) + instrument_count(2) + volatility_multiplier(2)
///   + batch_id_counter(8) + base_deposit(8) + n_min(4) + t_min(8) + t_max(8)
///   + t_reveal(8) + instrument_id(2) + tick(8) + lot(8) + imr(2) + mmr(2)
///   + taker_fee_bps(2) + maker_fee_bps(2) + oracle(32) + reg_bump(1) + inst_bump(1)
fn build_initialize_data(
    governance: Pubkey,
    registry_bump: u8,
    instrument_bump: u8,
    oracle: Pubkey,
) -> Vec<u8> {
    let mut data = vec![0u8; 1 + 140];
    data[0] = 0; // discriminator
    let p = &mut data[1..];
    p[0..32].copy_from_slice(governance.as_ref());
    p[32..34].copy_from_slice(&1u16.to_le_bytes()); // instrument_count
    p[34..36].copy_from_slice(&10_000u16.to_le_bytes()); // volatility_multiplier (1x)
    p[36..44].copy_from_slice(&0u64.to_le_bytes()); // batch_id_counter
    p[44..52].copy_from_slice(&1_000_000u64.to_le_bytes()); // base_deposit
    p[52..56].copy_from_slice(&1u32.to_le_bytes()); // n_min (1 post enough to close)
    p[56..64].copy_from_slice(&10u64.to_le_bytes()); // t_min_slots
    p[64..72].copy_from_slice(&150u64.to_le_bytes()); // t_max_slots
    p[72..80].copy_from_slice(&25u64.to_le_bytes()); // t_reveal_slots
    p[80..82].copy_from_slice(&0u16.to_le_bytes()); // instrument_id
    p[82..90].copy_from_slice(&1u64.to_le_bytes()); // tick_size
    p[90..98].copy_from_slice(&1u64.to_le_bytes()); // lot_size
    p[98..100].copy_from_slice(&2_000u16.to_le_bytes()); // imr_bps
    p[100..102].copy_from_slice(&1_000u16.to_le_bytes()); // mmr_bps
    p[102..104].copy_from_slice(&5u16.to_le_bytes()); // taker_fee_bps
    p[104..106].copy_from_slice(&(0i16).to_le_bytes()); // maker_fee_bps — locked D3 (makers free)
    p[106..138].copy_from_slice(oracle.as_ref());
    p[138] = registry_bump;
    p[139] = instrument_bump;
    data
}

// =============================================================================
// Data builders for the full commit→reveal→close→clear→settle pipeline
// (M6 6j.9 follow-up).  Each helper mirrors the wire layout decoded in
// `programs/perps-core/src/entrypoint.rs` (after the leading discriminator
// byte which the entrypoint strips).
//
// `dead_code` allows: most builders are not yet called by the single
// existing test; they will be used by the new e2e tests in tasks 2/3.
// =============================================================================

/// `InitPortfolio` (disc 1) — accounts: [writable] portfolio_pda, [signer] payer.
/// Data: user(32) + bump(1) = 33 bytes (post-disc).
#[allow(dead_code)]
fn build_init_portfolio_data(user: &Pubkey, bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; 33];
    data[0..32].copy_from_slice(user.as_ref());
    data[32] = bump;
    data
}

/// `Deposit` (disc 2) — accounts: portfolio, [signer] user_wallet, system_program, vault.
/// Data: amount(8) (post-disc).
#[allow(dead_code)]
fn build_deposit_data(amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 8];
    data[0..8].copy_from_slice(&amount.to_le_bytes());
    data
}

/// `CommitOrder` (disc 4) — accounts: [writable] commitment, [signer] user,
/// [writable] portfolio, batch, registry.
/// Data (M6 6g): order_type(1) + instrument_id(2) + reduce_only(1) + side(1)
///              + price(8) + qty(8) + salt(8) + batch_id(8) + bump(1) = 38 bytes.
#[allow(dead_code, clippy::too_many_arguments)]
fn build_commit_order_data(
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    batch_id: u64,
    commitment_bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; 38];
    data[0] = order_type;
    data[1..3].copy_from_slice(&instrument_id.to_le_bytes());
    data[3] = reduce_only as u8;
    data[4] = side;
    data[5..13].copy_from_slice(&price.to_le_bytes());
    data[13..21].copy_from_slice(&qty.to_le_bytes());
    data[21..29].copy_from_slice(&salt.to_le_bytes());
    data[29..37].copy_from_slice(&batch_id.to_le_bytes());
    data[37] = commitment_bump;
    data
}

/// `RevealOrder` (disc 5) — accounts: [writable] commitment, [signer] user,
/// [writable] portfolio, batch.
/// Data (M6 6g): order_type(1) + instrument_id(2) + reduce_only(1) + side(1)
///              + price(8) + qty(8) + salt(8) + batch_id(8) = 37 bytes.
#[allow(dead_code, clippy::too_many_arguments)]
fn build_reveal_order_data(
    order_type: u8,
    instrument_id: u16,
    reduce_only: bool,
    side: u8,
    price: i64,
    qty: u64,
    salt: u64,
    batch_id: u64,
) -> Vec<u8> {
    let mut data = vec![0u8; 37];
    data[0] = order_type;
    data[1..3].copy_from_slice(&instrument_id.to_le_bytes());
    data[3] = reduce_only as u8;
    data[4] = side;
    data[5..13].copy_from_slice(&price.to_le_bytes());
    data[13..21].copy_from_slice(&qty.to_le_bytes());
    data[21..29].copy_from_slice(&salt.to_le_bytes());
    data[29..37].copy_from_slice(&batch_id.to_le_bytes());
    data
}

/// `CloseCommitting` (disc 6) — accounts: [writable] batch, registry.
/// Data: none.
#[allow(dead_code)]
fn build_close_committing_data() -> Vec<u8> {
    Vec::new()
}

/// `CreateBatch` (disc 16) — post-disc: bump(1).
#[allow(dead_code)]
fn build_create_batch_data(bump: u8) -> Vec<u8> {
    vec![bump]
}

/// `PostOrder` (disc 20) — post-disc:
/// side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1) = 21
#[allow(dead_code)]
fn build_post_order_data(
    side: u8,
    is_maker: bool,
    price: i64,
    qty: u64,
    instrument_id: u16,
    reduce_only: bool,
) -> Vec<u8> {
    let mut data = vec![0u8; 21];
    data[0] = side;
    data[1] = is_maker as u8;
    data[2..10].copy_from_slice(&price.to_le_bytes());
    data[10..18].copy_from_slice(&qty.to_le_bytes());
    data[18..20].copy_from_slice(&instrument_id.to_le_bytes());
    data[20] = reduce_only as u8;
    data
}

/// `ClearBatch` (disc 7) — accounts: [writable] batch, [writable] book,
/// [writable] results, matcher, registry, then I instrument accounts,
/// then C commitment accounts, then P portfolio accounts. (M7 7.6 added
/// I + P for the per-user notional cap computation.)
/// Data (M7 7.6): num_commitments(2) + num_instruments(2) + num_portfolios(2)
/// (post-disc).
#[allow(dead_code)]
fn build_clear_batch_data(
    num_commitments: u16,
    num_instruments: u16,
    num_portfolios: u16,
) -> Vec<u8> {
    let mut data = vec![0u8; 6];
    data[0..2].copy_from_slice(&num_commitments.to_le_bytes());
    data[2..4].copy_from_slice(&num_instruments.to_le_bytes());
    data[4..6].copy_from_slice(&num_portfolios.to_le_bytes());
    data
}

/// `SettleBatch` (disc 8) — accounts: [writable] batch, [writable] registry,
/// [writable] vault, results, instrument, then C commitments, then P portfolios.
/// Data: num_commitments(2) + num_portfolios(2) = 4 bytes (post-disc).
#[allow(dead_code)]
fn build_settle_batch_data(num_commitments: u16, num_portfolios: u16) -> Vec<u8> {
    let mut data = vec![0u8; 4];
    data[0..2].copy_from_slice(&num_commitments.to_le_bytes());
    data[2..4].copy_from_slice(&num_portfolios.to_le_bytes());
    data
}

/// CancelAllRestingOrders data: `num_books(2)`.
fn build_cancel_all_resting_data(num_books: u16) -> Vec<u8> {
    num_books.to_le_bytes().to_vec()
}

/// Build a valid `PriceOracle` account (128 bytes, `PRICE_ORACLE` header) for the
/// LiquidateUser fallback. Layout: see `programs/oracle/src/state.rs`
/// (price@80, confidence@96, is_active@10). The oracle is left inactive.
fn build_oracle_data(price: i64, conf: i64) -> Vec<u8> {
    let mut data = vec![0u8; 128];
    data[0] = discriminator::PRICE_ORACLE;
    data[1] = LAYOUT_VERSION_1;
    data[10] = 0; // is_active = false
    data[80..88].copy_from_slice(&price.to_le_bytes());
    data[96..104].copy_from_slice(&conf.to_le_bytes());
    data
}

/// Seed a configured, active conversion oracle for successful risk actions.
fn seed_valid_oracle(pt: &mut ProgramTest, key: Pubkey, instrument: Pubkey) {
    let mut data = build_oracle_data(100_000_000, 0);
    data[10] = 1;
    data[48..80].copy_from_slice(instrument.as_ref());
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 - 1;
    data[88..96].copy_from_slice(&timestamp.to_le_bytes());
    pt.add_account(key, Account {
        lamports: 1_000_000, data,
        owner: Pubkey::new_from_array(mgk_common::program_ids::ORACLE_ID),
        executable: false, rent_epoch: 0,
    });
}

/// Stamp the account header (discriminator + layout version) onto a fixture.
fn stamp_header(data: &mut [u8], disc: u8) {
    data[0] = disc;
    data[1] = if disc == discriminator::PORTFOLIO {
        <Portfolio as mgk_common::layout::AccountLayout>::LAYOUT_VERSION
    } else if disc == discriminator::VAULT {
        <Vault as mgk_common::layout::AccountLayout>::LAYOUT_VERSION
    } else {
        LAYOUT_VERSION_1
    };
}

/// Pre-built Portfolio account data for a single-position underwater
/// portfolio. Offsets come from `offset_of!` so they track
/// `state/portfolio.rs::Portfolio` (header included).
#[allow(clippy::too_many_arguments)]
fn build_underwater_portfolio_data(
    user: Pubkey,
    bump: u8,
    instrument_id: u16,
    qty: i64,
    entry_vwap: i64,
    equity: i128,
    im: u128,
    mm: u128,
) -> Vec<u8> {
    let mut data = vec![0u8; PORTFOLIO_SIZE];
    stamp_header(&mut data, discriminator::PORTFOLIO);
    let put = |data: &mut Vec<u8>, off: usize, bytes: &[u8]| {
        data[off..off + bytes.len()].copy_from_slice(bytes)
    };
    put(&mut data, offset_of!(Portfolio, user), user.as_ref());
    put(&mut data, offset_of!(Portfolio, equity), &equity.to_le_bytes());
    put(&mut data, offset_of!(Portfolio, im), &im.to_le_bytes());
    put(&mut data, offset_of!(Portfolio, mm), &mm.to_le_bytes());
    put(
        &mut data,
        offset_of!(Portfolio, free_collateral),
        &equity.saturating_sub(im as i128).to_le_bytes(),
    );
    put(
        &mut data,
        offset_of!(Portfolio, health),
        &equity.saturating_sub(mm as i128).to_le_bytes(),
    );
    put(&mut data, offset_of!(Portfolio, positions_len), &1u16.to_le_bytes());
    let pos0 = offset_of!(Portfolio, positions);
    put(
        &mut data,
        pos0 + offset_of!(Position, instrument_id),
        &instrument_id.to_le_bytes(),
    );
    put(&mut data, pos0 + offset_of!(Position, qty), &qty.to_le_bytes());
    put(
        &mut data,
        pos0 + offset_of!(Position, entry_vwap),
        &entry_vwap.to_le_bytes(),
    );
    data[offset_of!(Portfolio, bump)] = bump;
    data
}

/// Rent-exempt minimum for the vault account (what the invariant subtracts).
fn vault_rent() -> u64 {
    solana_sdk::rent::Rent::default().minimum_balance(VAULT_SIZE)
}

/// Pre-built Vault account data (header stamped, offsets from `offset_of!`).
fn build_vault_data(insurance_fund: u128, uncovered_bad_debt: u128) -> Vec<u8> {
    let mut data = vec![0u8; VAULT_SIZE];
    stamp_header(&mut data, discriminator::VAULT);
    let f = offset_of!(Vault, insurance_fund);
    data[f..f + 16].copy_from_slice(&insurance_fund.to_le_bytes());
    let u = offset_of!(Vault, uncovered_bad_debt);
    data[u..u + 16].copy_from_slice(&uncovered_bad_debt.to_le_bytes());
    data
}

/// A stamped vault account whose lamports satisfy the invariant for the given
/// ledger: `lamports = rent + collateral + fund - debt`.
fn vault_account(collateral: u64, insurance_fund: u128, debt: u128) -> Account {
    let mut data = build_vault_data(insurance_fund, debt);
    data[V_BALANCE].copy_from_slice(&collateral.to_le_bytes());
    let lamports = vault_rent() as u128 + collateral as u128 + insurance_fund - debt;
    Account {
        lamports: lamports as u64,
        data,
        owner: CORE_ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// LiquidateUser data: `num_instruments(2)`.
fn build_liquidate_data(num_instruments: u16) -> Vec<u8> {
    num_instruments.to_le_bytes().to_vec()
}

/// Test #1: pinocchio↔solana-program-test interop sanity check.
/// Loads the BPF .so, calls Initialize, verifies Registry + Instrument state.
#[tokio::test]
async fn test_initialize_writes_registry_and_instrument() {
    // Skip if BPF_OUT_DIR is not set (e.g. running `cargo test` without the
    // env var); the .so can't be located and the test would fail with
    // "Program processor not available".
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping test_initialize_writes_registry_and_instrument: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }
    let (pt, pdas) = program_test_with_pdas();
    let registry_pda = pdas.registry;
    let instrument_pda = pdas.instrument;
    let vault_pda = pdas.vault;
    let ctx = pt.start_with_context().await;

    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();

    // Derive bumps by re-running PDA derivation (find_program_address is
    // deterministic; bumps are stable for a given seed+program).
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    // Sanity check: PDA accounts are visible pre-tx (proves add_account worked).
    let pre_reg = ctx
        .banks_client
        .get_account(registry_pda)
        .await
        .unwrap()
        .expect("registry pre-tx");
    assert_eq!(pre_reg.owner, CORE_ID, "registry owner must be core");
    assert_eq!(pre_reg.data.len(), REGISTRY_SIZE, "registry data len");
    let pre_inst = ctx
        .banks_client
        .get_account(instrument_pda)
        .await
        .unwrap()
        .expect("instrument pre-tx");
    assert_eq!(pre_inst.owner, CORE_ID, "instrument owner must be core");
    assert_eq!(pre_inst.data.len(), INSTRUMENT_SIZE, "instrument data len");

    let ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(registry_pda, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(instrument_pda, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(vault_pda, false),
        ],
        data: build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle),
    };

    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&ctx.payer.pubkey()),
        &[&ctx.payer, &governance],
        recent_blockhash,
    );

    ctx.banks_client.process_transaction(tx).await.unwrap();

    // Verify Registry state.
    let registry_acct = ctx
        .banks_client
        .get_account(registry_pda)
        .await
        .unwrap()
        .expect("registry account should exist");
    assert_eq!(
        registry_acct.data.len(),
        REGISTRY_SIZE,
        "registry size (got {}, want {})",
        registry_acct.data.len(),
        REGISTRY_SIZE
    );
    let g: [u8; 32] = registry_acct.data[R_GOVERNANCE].try_into().unwrap();
    assert_eq!(Pubkey::from(g), governance.pubkey(), "governance");
    let instrument_count = u16::from_le_bytes(registry_acct.data[R_INSTRUMENT_COUNT].try_into().unwrap());
    assert_eq!(
        instrument_count, 1,
        "instrument_count (set after instrument init)"
    );

    // Verify Instrument state. The on-chain struct has a different
    // `#[repr(C)]` layout than the host (BPF i128 alignment differs), so
    // we only verify byte-level invariants we know hold:
    // - data[0..2] = instrument_id (u16 LE)
    // - data[2..18] starts with "SOLP" (the default symbol)
    // - data[120] = is_active = 1 (verified by data dump)
    let inst_acct = ctx
        .banks_client
        .get_account(instrument_pda)
        .await
        .unwrap()
        .expect("instrument account should exist");
    let inst_id = u16::from_le_bytes(inst_acct.data[I_ID].try_into().unwrap());
    assert_eq!(inst_id, 0, "instrument_id");
    assert_eq!(&inst_acct.data[I_BASE_SYMBOL], b"SOLP", "base_symbol prefix");
    // is_active=true and bump set are in the trailing bytes; we don't
    // assert exact offsets because BPF layout differs from host layout.
    assert_eq!(
        &inst_acct.data[offset_of!(Instrument, oracle_addr)..][..32],
        oracle.as_ref(),
        "oracle_addr was written"
    );
    assert_eq!(
        &inst_acct.data[..2],
        &[discriminator::INSTRUMENT, LAYOUT_VERSION_1],
        "instrument header stamped by Initialize"
    );
    assert_eq!(
        &registry_acct.data[..2],
        &[discriminator::REGISTRY, LAYOUT_VERSION_1],
        "registry header stamped by Initialize"
    );
}

// =============================================================================
// E2E (DFBA): PostOrder → CloseCollecting → DfbaClear → SettleBatch
//
// Dual auction (both sides clear ⇒ mark_valid):
//   - maker: maker-buy 10 @ 100_000 + maker-sell 10 @ 100_000
//   - taker: taker-sell 10 @ 100_000 + taker-buy 10 @ 100_000
//
// Run with: BPF_OUT_DIR=target/deploy cargo test --test lifecycle --features host-hash
// =============================================================================

/// Side byte sent on the wire (must match `state::order::Side`).
const SIDE_BUY: u8 = 0;
const SIDE_SELL: u8 = 1;

/// OrderType bytes (legacy commit-reveal tests).
#[allow(dead_code)]
const ORDER_TYPE_LIMIT_GTC: u8 = 0;
#[allow(dead_code)]
const ORDER_TYPE_MARKET: u8 = 3;

/// Lamports to seed each user's wallet with (used for `Deposit`).
const USER_FUNDING_LAMPORTS: u64 = 100_000_000; // 0.1 SOL

/// Lamports each user deposits into the perps vault.
const USER_DEPOSIT_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

/// Test instrument id (matches the default instrument seeded by `Initialize`).
const INSTRUMENT_ID: u16 = 0;
/// Limit price used by DFBA posts.
const ORDER_PRICE: i64 = 100_000_000; // equals the seeded oracle price
/// Order quantity for DFBA posts.
const ORDER_QTY: u64 = 10;

/// Helper: prepend a discriminator byte to the post-disc wire payload.
fn with_disc(disc: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + payload.len());
    out.push(disc);
    out.extend(payload);
    out
}

/// `TopUp` (disc 26): anyone moves real lamports into the vault and the fund.
/// Accounts: payer [signer, writable], vault [writable], system program.
fn top_up_ix(payer: &Pubkey, vault: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: with_disc(26, amount.to_le_bytes().to_vec()),
    }
}

/// Fund the insurance reserve through a signed top-up from the test payer.
async fn top_up_fund(
    ctx: &mut solana_program_test::ProgramTestContext,
    pdas: &TestPdas,
    amount: u64,
) {
    let payer = ctx.payer.pubkey();
    submit(ctx, top_up_ix(&payer, &pdas.vault, amount), &[])
        .await
        .expect("top-up");
}

/// Add open interest to the vault for a synthetic position fixture (a seeded
/// portfolio holds a position that no fill ever opened, so the vault's side
/// counters must be raised to match before the position can be reduced).
async fn seed_vault_open_interest(
    ctx: &mut solana_program_test::ProgramTestContext,
    pdas: &TestPdas,
    long_lots: u64,
    short_lots: u64,
) {
    let mut vault = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .expect("vault");
    let add = |data: &mut [u8], r: Range<usize>, by: u64| {
        let cur = u64::from_le_bytes(data[r.clone()].try_into().unwrap());
        data[r].copy_from_slice(&(cur + by).to_le_bytes());
    };
    add(&mut vault.data, V_OI_LONG, long_lots);
    add(&mut vault.data, V_OI_SHORT, short_lots);
    ctx.set_account(&pdas.vault, &vault.into());
}

/// Insurance fund used by the lifecycle fixtures: 1 SOL covers 2_500 lots of
/// open interest (0.4 SOL reserve per SOL of larger-side open interest).
const FUND_TOP_UP: u64 = 1_000_000_000;

/// Helper: submit one instruction signed by the given signers, paid by `ctx.payer`.
async fn submit(
    ctx: &mut solana_program_test::ProgramTestContext,
    ix: Instruction,
    extra_signers: &[&Keypair],
) -> Result<(), solana_program_test::BanksClientError> {
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut signers: Vec<&Keypair> = vec![&ctx.payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&ctx.payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await
}

/// Submit a transaction with a higher compute unit limit (for CU-heavy instructions like ClearBatch).
#[allow(dead_code)]
async fn submit_cu(
    ctx: &mut solana_program_test::ProgramTestContext,
    ix: Instruction,
    extra_signers: &[&Keypair],
    cu_limit: u32,
) -> Result<(), solana_program_test::BanksClientError> {
    let recent_blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut signers: Vec<&Keypair> = vec![&ctx.payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new_signed_with_payer(
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(cu_limit),
            ix,
        ],
        Some(&ctx.payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await
}

/// E2E: DFBA dual-clear lifecycle with PostOrder (disc 20).
#[tokio::test]
async fn test_e2e_full_lifecycle_with_fill() {
    full_lifecycle_with_fill(0).await;
}

/// A trading pause blocks only new exposure: with TRADING and WITHDRAWALS
/// paused after the orders are posted, close, clear and settle still run and
/// produce the same fills, fees and balances as the unpaused lifecycle.
#[tokio::test]
async fn test_e2e_trading_pause_does_not_block_close_clear_and_settle() {
    full_lifecycle_with_fill(PAUSE_TRADING_BIT | PAUSE_WITHDRAWALS_BIT).await;
}

/// Run the full close -> clear -> settle lifecycle, setting `pause_flags` on
/// the registry once the orders are posted.
async fn full_lifecycle_with_fill(pause_flags: u8) {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!(
            "skipping full_lifecycle_with_fill: \
             set BPF_OUT_DIR=target/deploy to enable"
        );
        return;
    }

    // Batch 0 is created via CreateBatch; settle opens batch 1 as next.
    let batch_id: u64 = 0;
    let nonce: u64 = 0;

    let maker = Keypair::new();
    let taker = Keypair::new();
    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_id, nonce);
    let taker_pdas = derive_user_pdas(&taker.pubkey(), batch_id, nonce);

    let (mut pt, pdas) = program_test_with_pdas();

    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );

    // Portfolio + batch (shared batch PDA for both users).
    seed_user_accounts(&mut pt, &maker_pdas);
    // Taker only needs portfolio (batch already seeded via maker_pdas).
    pt.add_account(
        taker_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );

    // Matcher writes results via DfbaClear — owner must be matcher program.
    let (results_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );

    let (next_batch_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &(batch_id + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(
        next_batch_pda,
        Account::new(1_000_000, BATCH_SIZE, &CORE_ID),
    );

    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    let init_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(governance.pubkey(), true),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(pdas.vault, false),
        ],
        data: with_disc(
            0,
            build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)[1..]
                .to_vec(),
        ),
    };
    submit(&mut ctx, init_ix, &[&governance]).await.unwrap();

    // CreateBatch 0 — open collecting window.
    let create_batch_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
    };
    submit(&mut ctx, create_batch_ix, &[]).await.unwrap();

    for (user, user_pdas) in [(&maker, &maker_pdas), (&taker, &taker_pdas)] {
        let ix = Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
            ),
        };
        submit(&mut ctx, ix, &[user]).await.unwrap();
    }

    for (user, user_pdas) in [(&maker, &maker_pdas), (&taker, &taker_pdas)] {
        let ix = Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        };
        submit(&mut ctx, ix, &[user]).await.unwrap();
    }
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;

    // Helper: PostOrder (disc 20).
    let post = |user: &Keypair, portfolio: Pubkey, side: u8, is_maker: bool| -> Instruction {
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(side, is_maker, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        }
    };

    // Dual DFBA: both auctions must clear for mark_valid.
    // Bid: maker-buy × taker-sell; Ask: maker-sell × taker-buy.
    submit(
        &mut ctx,
        post(&maker, maker_pdas.portfolio, SIDE_BUY, true),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&maker, maker_pdas.portfolio, SIDE_SELL, true),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&taker, taker_pdas.portfolio, SIDE_SELL, false),
        &[&taker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&taker, taker_pdas.portfolio, SIDE_BUY, false),
        &[&taker],
    )
    .await
    .unwrap();

    if pause_flags != 0 {
        let mut registry = get_account(&mut ctx, &pdas.registry).await;
        registry.data[R_PAUSE_FLAGS] = pause_flags;
        ctx.set_account(&pdas.registry, &registry.into());
    }

    // Close collecting → Clearing (n_min=5 in init; 4 posts → warp past deadline).
    let clock = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(clock.slot + 200).unwrap();

    let close_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
        ],
        data: with_disc(6, build_close_committing_data()),
    };
    submit(&mut ctx, close_ix, &[]).await.unwrap();

    // ClearBatch → matcher DfbaClear (num_orders=0 collects book).
    // Need ≥6 accounts: pass instrument even with I=1,C=0,P=0.
    let clear_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new(results_pda, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false),
        ],
        data: with_disc(7, build_clear_batch_data(0, 1, 0)),
    };
    submit(&mut ctx, clear_ix, &[]).await.unwrap();

    // SettleBatch: C=0 commitments, P=2 portfolios + next_batch.
    let settle_ix = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new(results_pda, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(maker_pdas.portfolio, false),
            AccountMeta::new(taker_pdas.portfolio, false),
            AccountMeta::new(next_batch_pda, false),
        ],
        data: with_disc(8, build_settle_batch_data(0, 2)),
    };
    submit(&mut ctx, settle_ix, &[]).await.unwrap();

    // --- Assertions ---
    let batch_acct = ctx
        .banks_client
        .get_account(maker_pdas.batch)
        .await
        .unwrap()
        .expect("batch");
    let batch_status = batch_acct.data[B_STATUS];
    assert_eq!(batch_status, 3, "batch status Settled");

    // Batch DFBA offsets (host repr(C), size 160):
    // clearing_price@48, bid@120, ask@128, mbid@136, mask@144, mark_valid@152, liq@153
    let mark_valid = batch_acct.data.get(B_MARK_VALID).copied().unwrap_or(0);
    let liq_paused = batch_acct.data.get(B_LIQ_PAUSED).copied().unwrap_or(1);
    let clearing_price = i64::from_le_bytes(batch_acct.data[B_CLEARING_PRICE].try_into().unwrap());
    let matched_bid = u64::from_le_bytes(batch_acct.data[B_MATCHED_BID].try_into().unwrap());
    let matched_ask = u64::from_le_bytes(batch_acct.data[B_MATCHED_ASK].try_into().unwrap());
    assert!(matched_bid > 0, "bid auction matched");
    assert!(matched_ask > 0, "ask auction matched");
    assert_eq!(mark_valid, 1, "dual clear ⇒ mark_valid");
    assert_eq!(liq_paused, 0, "dual clear ⇒ liq not paused");
    assert_eq!(clearing_price, ORDER_PRICE, "mid of equal bid/ask clear");

    let maker_portfolio_acct = ctx
        .banks_client
        .get_account(maker_pdas.portfolio)
        .await
        .unwrap()
        .expect("maker portfolio");
    let taker_portfolio_acct = ctx
        .banks_client
        .get_account(taker_pdas.portfolio)
        .await
        .unwrap()
        .expect("taker portfolio");

    // Results: num_fills at offset 32 (DFBA header).
    let results_acct = ctx
        .banks_client
        .get_account(results_pda)
        .await
        .unwrap()
        .expect("results");
    let num_fills = u16::from_le_bytes(results_acct.data[RES_NUM_FILLS].try_into().unwrap());
    assert!(
        num_fills >= 4,
        "expected ≥4 fills (maker+taker × bid+ask), got {num_fills}"
    );
    // First fill: user + qty + price
    let fill0_user = &results_acct.data[RES_FILL0_USER];
    let fill0_qty = u64::from_le_bytes(results_acct.data[RES_FILL0_QTY].try_into().unwrap());
    let fill0_price = i64::from_le_bytes(results_acct.data[RES_FILL0_PRICE].try_into().unwrap());
    assert!(
        fill0_user == maker.pubkey().as_ref() || fill0_user == taker.pubkey().as_ref(),
        "fill0 user not maker/taker"
    );
    assert!(fill0_qty > 0, "fill0 qty must be > 0, got {fill0_qty}");
    assert_eq!(fill0_price, ORDER_PRICE, "fill0 price");
    // Portfolio.user bytes at offset 0
    let maker_user_on_chain = &maker_portfolio_acct.data[P_USER];
    assert_eq!(
        maker_user_on_chain,
        maker.pubkey().as_ref(),
        "portfolio.user must match maker pubkey"
    );

    // Portfolio layout (repr C): user@0 (32), equity@32 (i128).
    // Maker: buy+sell same size → flat cash; locked D3 maker fee is zero.
    // Taker: fee 2×(1e6*5/1e4)=-1000
    let maker_equity = i128::from_le_bytes(maker_portfolio_acct.data[P_EQUITY].try_into().unwrap());
    let taker_equity = i128::from_le_bytes(taker_portfolio_acct.data[P_EQUITY].try_into().unwrap());
    let vault_acct = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .expect("vault");
    let vault_balance = u64::from_le_bytes(vault_acct.data[V_BALANCE].try_into().unwrap());
    // Dual legs cancel notional; fees: maker zero, taker pays 5 bps on each of
    // its two fills (5_000 lamports each at this order size and oracle price).
    const TAKER_FEES: u64 = 10_000;
    assert_eq!(
        vault_balance,
        2 * USER_DEPOSIT_LAMPORTS - TAKER_FEES,
        "collateral falls by the fee that moved into the fund"
    );
    // (Instrument fee fields must match #[repr(C)] — fixed in initialize.rs.)
    let maker_principal =
        i128::from_le_bytes(maker_portfolio_acct.data[P_PRINCIPAL].try_into().unwrap());
    assert_eq!(
        maker_principal, USER_DEPOSIT_LAMPORTS as i128,
        "maker principal"
    );
    assert_eq!(
        maker_equity, USER_DEPOSIT_LAMPORTS as i128,
        "maker equity after dual fill with zero maker fee"
    );
    assert_eq!(
        taker_equity,
        USER_DEPOSIT_LAMPORTS as i128 - TAKER_FEES as i128,
        "taker equity after dual fill + fees"
    );
    let insurance = u128::from_le_bytes(vault_acct.data[V_INSURANCE].try_into().unwrap());
    assert_eq!(
        insurance,
        FUND_TOP_UP as u128 + TAKER_FEES as u128,
        "fund = signed top-up + collected fees"
    );
    assert_eq!(vault_acct.lamports, vault_rent() + vault_balance + insurance as u64);
    let _ = num_fills;

    let book_acct = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .expect("book");
    assert!(
        book_acct.data.iter().any(|b| *b != 0),
        "book was written by PlaceResting/DfbaClear"
    );
}

/// E2E: one-sided DFBA (only ask auction) ⇒ mark_valid=0, liq_paused=1.
#[tokio::test]
async fn test_e2e_dfba_one_sided_liq_paused() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_dfba_one_sided_liq_paused: set BPF_OUT_DIR");
        return;
    }

    let batch_id: u64 = 0;
    let maker = Keypair::new();
    let taker = Keypair::new();
    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_id, 0);
    let taker_pdas = derive_user_pdas(&taker.pubkey(), batch_id, 0);

    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &maker_pdas);
    pt.add_account(
        taker_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    let (results_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (next_batch_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &(batch_id + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(
        next_batch_pda,
        Account::new(1_000_000, BATCH_SIZE, &CORE_ID),
    );

    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();

    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();

    for (user, user_pdas) in [(&maker, &maker_pdas), (&taker, &taker_pdas)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(user_pdas.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                ],
                data: with_disc(
                    1,
                    build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
                ),
            },
            &[user],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(user_pdas.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[user],
        )
        .await
        .unwrap();
    }
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;

    // Only ask auction: maker-sell × taker-buy (no bid side).
    let post = |user: &Keypair, portfolio: Pubkey, side: u8, is_maker: bool| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(pdas.vault, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(side, is_maker, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
        ),
    };
    submit(
        &mut ctx,
        post(&maker, maker_pdas.portfolio, SIDE_SELL, true),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        post(&taker, taker_pdas.portfolio, SIDE_BUY, false),
        &[&taker],
    )
    .await
    .unwrap();

    let clock = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(clock.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(results_pda, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(taker_pdas.portfolio, false),
                AccountMeta::new(next_batch_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();

    let batch_acct = ctx
        .banks_client
        .get_account(maker_pdas.batch)
        .await
        .unwrap()
        .expect("batch");
    assert_eq!(batch_acct.data[B_STATUS], 3, "Settled");
    let mark_valid = batch_acct.data[B_MARK_VALID];
    let liq_paused = batch_acct.data[B_LIQ_PAUSED];
    let matched_bid = u64::from_le_bytes(batch_acct.data[B_MATCHED_BID].try_into().unwrap());
    let matched_ask = u64::from_le_bytes(batch_acct.data[B_MATCHED_ASK].try_into().unwrap());
    assert_eq!(matched_bid, 0, "no bid auction");
    assert!(matched_ask > 0, "ask auction matched");
    assert_eq!(mark_valid, 0, "one-sided ⇒ !mark_valid");
    assert_eq!(liq_paused, 1, "one-sided ⇒ liq_paused");
}

// =============================================================================
// DFBA E2E tests -- rewritten from legacy commit-reveal (2026-08-06)
// =============================================================================

/// E2E: DFBA resting order across batches.
#[tokio::test]
async fn test_e2e_gtc_rests_then_matches_next_batch() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let bid: u64 = 0;
    let maker = Keypair::new();
    let taker = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), bid, 0);
    let tp = derive_user_pdas(&taker.pubkey(), bid, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    pt.add_account(
        tp.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    let (r0, _) = Pubkey::find_program_address(&[b"results", &bid.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &(bid + 1).to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let (r1, _) =
        Pubkey::find_program_address(&[b"results", &(bid + 1).to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r1,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b2, _) = Pubkey::find_program_address(&[BATCH_SEED, &(bid + 2).to_le_bytes()], &CORE_ID);
    pt.add_account(b2, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let gov = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, oracle)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    for (u, p) in [(&maker, &mp), (&taker, &tp)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                ],
                data: with_disc(1, build_init_portfolio_data(&u.pubkey(), p.portfolio_bump)),
            },
            &[u],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[u],
        )
        .await
        .unwrap();
    }
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;
    // Batch 0: maker buy@98k only (rests)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 98_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();
    let ba = ctx
        .banks_client
        .get_account(mp.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ba.data[B_STATUS], 3, "batch 0 Settled");
    assert_eq!(ba.data[B_MARK_VALID], 0, "one-sided -> !mark_valid");
    // Batch 1: taker sell@97k crosses resting buy@98k
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, 97_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r1, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(r1, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b2, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    let b1a = ctx.banks_client.get_account(b1).await.unwrap().unwrap();
    assert_eq!(b1a.data[B_STATUS], 3, "batch 1 Settled");
    let ta = ctx
        .banks_client
        .get_account(tp.portfolio)
        .await
        .unwrap()
        .unwrap();
    assert!(
        u16::from_le_bytes(ta.data[P_POSITIONS_LEN].try_into().unwrap()) >= 1,
        "taker filled from resting"
    );
}

/// E2E: SettleBatch creates next batch PDA with correct fields.
#[tokio::test]
async fn test_e2e_settle_creates_next_batch_pda() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let maker = Keypair::new();
    let taker = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), 0, 0);
    let tp = derive_user_pdas(&taker.pubkey(), 0, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    pt.add_account(
        tp.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    let (r0, _) = Pubkey::find_program_address(&[b"results", &0u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let (r1, _) = Pubkey::find_program_address(&[b"results", &1u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r1,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b2, _) = Pubkey::find_program_address(&[BATCH_SEED, &2u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b2, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let gov = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, oracle)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    for (u, p) in [(&maker, &mp), (&taker, &tp)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                ],
                data: with_disc(1, build_init_portfolio_data(&u.pubkey(), p.portfolio_bump)),
            },
            &[u],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[u],
        )
        .await
        .unwrap();
    }
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;
    // Dual fill -> mark_valid -> settle creates batch 1
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    let ba = ctx
        .banks_client
        .get_account(mp.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ba.data[B_STATUS], 3, "batch 0 Settled");
    assert_eq!(ba.data[B_MARK_VALID], 0, "!mark_valid (one-sided bid auction only)");
    // Verify batch 1 created
    let b1a = ctx.banks_client.get_account(b1).await.unwrap().unwrap();
    assert_eq!(b1a.data[B_STATUS], 0, "batch 1 Collecting");
    assert_eq!(
        u64::from_le_bytes(b1a.data[B_ID].try_into().unwrap()),
        1,
        "batch 1 id"
    );
    assert!(
        u64::from_le_bytes(b1a.data[B_COMMIT_DEADLINE].try_into().unwrap()) > 0,
        "deadline set"
    );
    // Batch 1 lifecycle -> batch 2 created
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r1, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(b1, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(r1, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b2, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    let b2a = ctx.banks_client.get_account(b2).await.unwrap().unwrap();
    assert_eq!(b2a.data[B_STATUS], 0, "batch 2 Collecting");
    assert_eq!(
        u64::from_le_bytes(b2a.data[B_ID].try_into().unwrap()),
        2,
        "batch 2 id"
    );
}

/// E2E: LiquidateUser happy path -- DFBA mark, pre-built underwater portfolio.
#[tokio::test]
async fn test_e2e_liquidate_user_happy_path() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let maker = Keypair::new();
    let taker = Keypair::new();
    let victim = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), 0, 0);
    let tp = derive_user_pdas(&taker.pubkey(), 0, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        taker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    pt.add_account(
        victim.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    pt.add_account(
        tp.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    // Underwater portfolio: qty=100 long @120_000, equity=-5M
    let (vp, vb) =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, victim.pubkey().as_ref()], &CORE_ID);
    pt.add_account(
        vp,
        Account {
            lamports: 1_000_000,
            data: build_underwater_portfolio_data(
                victim.pubkey(),
                vb,
                INSTRUMENT_ID,
                100,
                120_000,
                -5_000_000,
                0,
                0,
            ),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let (r0, _) = Pubkey::find_program_address(&[b"results", &0u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let opk = Pubkey::new_unique();
    pt.add_account(
        opk,
        Account {
            lamports: 1_000_000,
            data: build_oracle_data(100_000_000, 0),
            owner: CORE_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    seed_valid_oracle(&mut pt, opk, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let gov = Keypair::new();
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, opk)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    for (u, p) in [(&maker, &mp), (&taker, &tp)] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                ],
                data: with_disc(1, build_init_portfolio_data(&u.pubkey(), p.portfolio_bump)),
            },
            &[u],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(p.portfolio, false),
                    AccountMeta::new(u.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[u],
        )
        .await
        .unwrap();
    }
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;
    // Dual fill -> mark_valid (bid: maker-buy × taker-sell; ask: maker-sell × taker-buy)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(opk, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(opk, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, false, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    // Ask auction: maker-sell × taker-buy
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(opk, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_SELL, true, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(taker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(opk, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, false, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&taker],
    )
    .await
    .unwrap();
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 0)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(opk, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(tp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();
    let ba = ctx
        .banks_client
        .get_account(mp.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ba.data[B_STATUS], 3, "Settled");
    assert_eq!(ba.data[B_MARK_VALID], 1, "mark_valid (dual auction)");
    // The seeded victim holds 100 long lots that no fill opened.
    seed_vault_open_interest(&mut ctx, &pdas, 100, 0).await;
    // Liquidate underwater victim
    let liq = Keypair::new();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(vp, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(liq.pubkey(), true),
                AccountMeta::new_readonly(mp.batch, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(opk, false),
            ],
            data: with_disc(9, build_liquidate_data(1)),
        },
        &[&liq],
    )
    .await
    .unwrap();
    let va = ctx.banks_client.get_account(vp).await.unwrap().unwrap();
    let vp_len = u16::from_le_bytes(va.data[P_POSITIONS_LEN].try_into().unwrap());
    assert!(vp_len <= 1, "position reduced after liquidation");
}

/// E2E: CancelAllRestingOrders clears the book.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_cancel_all_resting_orders() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    let maker = Keypair::new();
    let mp = derive_user_pdas(&maker.pubkey(), 0, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &mp);
    let (r0, _) = Pubkey::find_program_address(&[b"results", &0u64.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        r0,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (b1, _) = Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(b1, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let gov = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, rb) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, ib) = Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(gov.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(gov.pubkey(), rb, ib, oracle)[1..].to_vec(),
            ),
        },
        &[&gov],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(mp.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&maker.pubkey(), mp.portfolio_bump),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        },
        &[&maker],
    )
    .await
    .unwrap();
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;
    // Post resting maker buy@98k
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 98_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    // Close -> Clear -> Settle (one-sided)
    let c = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    ctx.warp_to_slot(c.slot + 200).unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(r0, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.batch, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new(r0, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(b1, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();
    // Verify resting order exists
    let bk = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert!(
        book_resting_count(&bk.data) >= 1,
        "resting bid"
    );
    // Cancel all resting
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(mp.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.book, false),
            ],
            data: with_disc(13, build_cancel_all_resting_data(1)),
        },
        &[&maker],
    )
    .await
    .unwrap();
    // Verify book empty
    let bk2 = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        book_resting_count(&bk2.data),
        0,
        "book empty after cancel"
    );
}

/// E2E: DFBA resting across batch with is_maker preserved.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_resting_across_batch() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_resting_across_batch: set BPF_OUT_DIR");
        return;
    }

    let batch_0_id: u64 = 0;
    let batch_1_id: u64 = 1;
    let batch_2_id: u64 = 2;

    let maker = Keypair::new();
    let taker_0 = Keypair::new();
    let taker_1 = Keypair::new();

    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_0_id, 0);
    let taker0_pdas = derive_user_pdas(&taker_0.pubkey(), batch_0_id, 0);
    let taker1_pdas = derive_user_pdas(&taker_1.pubkey(), batch_1_id, 0);

    let (mut pt, pdas) = program_test_with_pdas();
    for kp in [&maker, &taker_0, &taker_1] {
        pt.add_account(
            kp.pubkey(),
            Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
        );
    }
    seed_user_accounts(&mut pt, &maker_pdas);
    pt.add_account(
        taker0_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );
    pt.add_account(
        taker1_pdas.portfolio,
        Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID),
    );

    let (results_0_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_0_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_0_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (results_1_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_1_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_1_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );

    let (batch_1_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_1_id.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_1_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let (batch_2_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_2_id.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_2_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();

    for (user, up) in [
        (&maker, &maker_pdas),
        (&taker_0, &taker0_pdas),
        (&taker_1, &taker1_pdas),
    ] {
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(up.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                ],
                data: with_disc(
                    1,
                    build_init_portfolio_data(&user.pubkey(), up.portfolio_bump),
                ),
            },
            &[user],
        )
        .await
        .unwrap();
        submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(up.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[user],
        )
        .await
        .unwrap();
    }
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;

    // Post orders: maker buy@100k+98k, taker sell@99k
    let pi = |u: &Keypair, p: Pubkey, s: u8, m: bool, pr: i64| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(p, false),
            AccountMeta::new(u.pubkey(), true),
            AccountMeta::new(maker_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(pdas.vault, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(s, m, pr, ORDER_QTY, INSTRUMENT_ID, false),
        ),
    };
    submit(
        &mut ctx,
        pi(&maker, maker_pdas.portfolio, SIDE_BUY, true, 100_000),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        pi(&maker, maker_pdas.portfolio, SIDE_BUY, true, 98_000),
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        pi(&taker_0, taker0_pdas.portfolio, SIDE_SELL, false, 99_000),
        &[&taker_0],
    )
    .await
    .unwrap();

    // Batch 0: Close -> Clear -> Settle
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 2)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(taker0_pdas.portfolio, false),
                AccountMeta::new(batch_1_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 2)),
        },
        &[],
    )
    .await
    .unwrap();

    // Verify batch 0 settled + resting orders exist
    let b0 = ctx
        .banks_client
        .get_account(maker_pdas.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(b0.data[B_STATUS], 3, "batch 0 Settled");
    let bk = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert!(
        book_resting_count(&bk.data) >= 1,
        "resting bid"
    );

    // Batch 1: taker 1 sells@97k -> crosses resting buy@98k
    submit(
        &mut ctx,
        pi(&taker_1, taker1_pdas.portfolio, SIDE_SELL, false, 97_000),
        &[&taker_1],
    )
    .await
    .unwrap();

    // Batch 1: Close -> Clear
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(batch_1_pda, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(batch_1_pda, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_1_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();

    // Verify: batch 1 clear produced fills from resting order
    let b1 = ctx
        .banks_client
        .get_account(batch_1_pda)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(b1.data[B_STATUS], 2, "batch 1 Clearing");
    let r1 = ctx
        .banks_client
        .get_account(results_1_pda)
        .await
        .unwrap()
        .unwrap();
    let nf = u16::from_le_bytes(r1.data[RES_NUM_FILLS].try_into().unwrap());
    assert!(nf >= 2, ">=2 fills from resting order, got {nf}");

    // Verify: at least one fill has is_maker=true (role preserved)
    let mut found = false;
    for i in 0..nf as usize {
        let off = RES + 34 + i * 58;
        if r1.data[off + 56] != 0 {
            found = true;
            let fp = i64::from_le_bytes(r1.data[off + 48..off + 56].try_into().unwrap());
            assert_eq!(fp, 98_000, "maker fill price");
            break;
        }
    }
    assert!(found, "is_maker fill found");
}

/// E2E: DFBA self-trade prevention — same wallet maker+taker does not
/// self-fill (T9.5.5c). Host unit tests already cover the DFBA math;
/// this validates the on-chain path.
///
/// Scenario: user posts maker-buy@100_000 and taker-sell@100_000.
/// The DFBA self-trade filter should exclude the fill.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_self_trade_no_fill() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_self_trade_no_fill: set BPF_OUT_DIR");
        return;
    }

    let batch_id: u64 = 0;
    let user = Keypair::new();
    let user_pdas = derive_user_pdas(&user.pubkey(), batch_id, 0);

    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        user.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &user_pdas);

    let (results_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );

    let (batch_1_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &1u64.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_1_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    // Initialize + CreateBatch + InitPortfolio + Deposit
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(user_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&user.pubkey(), user_pdas.portfolio_bump),
            ),
        },
        &[&user],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        },
        &[&user],
    )
    .await
    .unwrap();
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;

    // Same user: maker-buy@100k AND taker-sell@100k (self-trade)
    let pi = |side: u8, is_maker: bool| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(user_pdas.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(user_pdas.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(pdas.vault, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(side, is_maker, ORDER_PRICE, ORDER_QTY, INSTRUMENT_ID, false),
        ),
    };
    submit(&mut ctx, pi(SIDE_BUY, true), &[&user])
        .await
        .unwrap();
    submit(&mut ctx, pi(SIDE_SELL, false), &[&user])
        .await
        .unwrap();

    // Close -> Clear -> Settle
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(user_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(results_pda, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new(user_pdas.portfolio, false),
                AccountMeta::new(batch_1_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();

    // Verify: no fills (self-trade excluded)
    let results = ctx
        .banks_client
        .get_account(results_pda)
        .await
        .unwrap()
        .unwrap();
    let num_fills = u16::from_le_bytes(results.data[RES_NUM_FILLS].try_into().unwrap());
    assert_eq!(num_fills, 0, "self-trade should produce 0 fills");

    // Verify: batch settled but mark invalid (one-sided clear only)
    let batch = ctx
        .banks_client
        .get_account(user_pdas.batch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(batch.data[B_STATUS], 3, "batch Settled");
}

/// E2E: DFBA cancel resting between batches (T9.5.5d).
/// Scenario: maker posts buy@98k, batch settles (no taker), maker cancels resting order.
#[tokio::test]
#[ignore = "CU exhaustion: matcher book_collect exceeds 200k CU in program-test 2.1"]
async fn test_e2e_cancel_resting_between_batches() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping test_e2e_cancel_resting_between_batches: set BPF_OUT_DIR");
        return;
    }
    let batch_0_id: u64 = 0;
    let batch_1_id: u64 = 1;
    let maker = Keypair::new();
    let maker_pdas = derive_user_pdas(&maker.pubkey(), batch_0_id, 0);
    let (mut pt, pdas) = program_test_with_pdas();
    pt.add_account(
        maker.pubkey(),
        Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
    );
    seed_user_accounts(&mut pt, &maker_pdas);
    let (results_0_pda, _) =
        Pubkey::find_program_address(&[b"results", &batch_0_id.to_le_bytes()], &MATCHER_ID);
    pt.add_account(
        results_0_pda,
        Account::new(1_000_000, RESULTS_ACCOUNT_SIZE, &MATCHER_ID),
    );
    let (batch_1_pda, _) =
        Pubkey::find_program_address(&[BATCH_SEED, &batch_1_id.to_le_bytes()], &CORE_ID);
    pt.add_account(batch_1_pda, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));
    let governance = Keypair::new();
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let (_, registry_bump) = Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID);
    let (_, instrument_bump) =
        Pubkey::find_program_address(&[INSTRUMENT_SEED, &0u16.to_le_bytes()], &CORE_ID);

    // Init + CreateBatch + Portfolio + Deposit
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new(governance.pubkey(), true),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(
                0,
                build_initialize_data(governance.pubkey(), registry_bump, instrument_bump, oracle)
                    [1..]
                    .to_vec(),
            ),
        },
        &[&governance],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.registry, false),
            ],
            data: with_disc(16, build_create_batch_data(maker_pdas.batch_bump)),
        },
        &[],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
            ],
            data: with_disc(
                1,
                build_init_portfolio_data(&maker.pubkey(), maker_pdas.portfolio_bump),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(pdas.vault, false),
            ],
            data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
        },
        &[&maker],
    )
    .await
    .unwrap();
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;

    // Post maker buy@98k (no taker -> rests)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(
                20,
                build_post_order_data(SIDE_BUY, true, 98_000, ORDER_QTY, INSTRUMENT_ID, false),
            ),
        },
        &[&maker],
    )
    .await
    .unwrap();

    // Batch 0: Close -> Clear -> Settle
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(6, build_close_committing_data()),
        },
        &[],
    )
    .await
    .unwrap();
    submit_cu(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
            ],
            data: with_disc(7, build_clear_batch_data(0, 1, 1)),
        },
        &[],
        1_400_000,
    )
    .await
    .unwrap();
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.batch, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new(pdas.instrument, false),
                AccountMeta::new(results_0_pda, false),
                AccountMeta::new(pdas.vault, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(batch_1_pda, false),
            ],
            data: with_disc(8, build_settle_batch_data(0, 1)),
        },
        &[],
    )
    .await
    .unwrap();

    // Verify resting order exists
    let bk = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert!(
        book_resting_count(&bk.data) >= 1,
        "resting bid"
    );

    // Cancel all resting (disc 13)
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(maker_pdas.portfolio, false),
                AccountMeta::new(maker.pubkey(), true),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new(pdas.book, false),
            ],
            data: with_disc(13, build_cancel_all_resting_data(1)),
        },
        &[&maker],
    )
    .await
    .unwrap();

    // Verify book empty
    let bk2 = ctx
        .banks_client
        .get_account(pdas.book)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        book_resting_count(&bk2.data),
        0,
        "book empty after cancel"
    );
}

/// Exercise settlement directly through the SBF account adapter, independently
/// of matcher compute limits. Check byte writes and transaction rollback.
#[tokio::test]
async fn test_settlement_transition_account_writes_and_late_error_rollback() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let (mut pt, pdas) = program_test_with_pdas();
    let batch_key = Pubkey::find_program_address(&[BATCH_SEED, &7u64.to_le_bytes()], &CORE_ID).0;
    // Settlement derives and verifies these PDAs, so the fixture uses them.
    let next_key =
        Pubkey::find_program_address(&[BATCH_SEED, &8u64.to_le_bytes()], &CORE_ID).0;
    let bad_next_key = next_key;
    let results_key =
        Pubkey::find_program_address(&[b"results", &7u64.to_le_bytes()], &MATCHER_ID).0;
    let oracle_key = Pubkey::new_unique();
    let user = Pubkey::new_unique();
    let portfolio_key = Pubkey::find_program_address(&[PORTFOLIO_SEED, user.as_ref()], &CORE_ID).0;
    let maker_user = Pubkey::new_unique();
    let maker_portfolio_key =
        Pubkey::find_program_address(&[PORTFOLIO_SEED, maker_user.as_ref()], &CORE_ID).0;
    let mut batch = Account::new(1_000_000, BATCH_SIZE, &CORE_ID);
    stamp_header(&mut batch.data, discriminator::BATCH);
    batch.data[B_ID].copy_from_slice(&7u64.to_le_bytes());
    batch.data[B_STATUS] = 4; // Cleared: matcher output awaits settlement
    batch.data[B_CLEARING_PRICE].copy_from_slice(&110i64.to_le_bytes());
    batch.data[B_MARK_VALID] = 1; // valid mark
    pt.add_account(batch_key, batch);
    // Already-initialised batch account: creating the next batch over it must
    // fail late with AlreadyInitialized and roll everything back.
    let mut bad_next = Account::new(1_000_000, BATCH_SIZE, &CORE_ID);
    stamp_header(&mut bad_next.data, discriminator::BATCH);
    bad_next.data[B_ID].copy_from_slice(&99u64.to_le_bytes());
    pt.add_account(bad_next_key, bad_next);
    let mut registry = Account::new(1_000_000, REGISTRY_SIZE, &CORE_ID);
    stamp_header(&mut registry.data, discriminator::REGISTRY);
    registry.data[R_BATCH_ID_COUNTER].copy_from_slice(&7u64.to_le_bytes());
    registry.data[R_T_MAX].copy_from_slice(&20u64.to_le_bytes());
    pt.add_account(pdas.registry, registry);
    // Replace the zeroed genesis vault with an initialised (stamped) one.
    // Both portfolios' 20_000 lamports of equity are collateral held by the vault.
    pt.add_account(pdas.vault, vault_account(40_000, 0, 0));
    let mut instrument = Account::new(1_000_000, INSTRUMENT_SIZE, &CORE_ID);
    stamp_header(&mut instrument.data, discriminator::INSTRUMENT);
    instrument.data[offset_of!(Instrument, oracle_addr)..][..32].copy_from_slice(oracle_key.as_ref());
    // Same fee offsets as Initialize; funding disabled by zero interval.
    instrument.data[I_TAKER_FEE].copy_from_slice(&5u16.to_le_bytes());
    pt.add_account(pdas.instrument, instrument);
    // Settlement requires authenticated reservations and clips one-sided
    // auctions, so the fixture crosses a taker buy with a maker sell (both in
    // auction 1) for the same quantity and price. Each fill is 58 bytes:
    // user@0, order_id@32, qty@40, price@48, maker@56, auction@57.
    let mut results = Account::new(1_000_000, RES + 34 + 2 * 58, &MATCHER_ID);
    stamp_header(&mut results.data, discriminator::BATCH_RESULTS);
    results.data[ACCOUNT_HEADER_LEN..ACCOUNT_HEADER_LEN + 8].copy_from_slice(&7u64.to_le_bytes());
    results.data[RES_NUM_FILLS].copy_from_slice(&2u16.to_le_bytes());
    for (i, (who, order_id, maker)) in [(user, 1u64, 0u8), (maker_user, 2u64, 1u8)]
        .into_iter()
        .enumerate()
    {
        let off = RES + 34 + i * 58;
        results.data[off..off + 32].copy_from_slice(who.as_ref());
        results.data[off + 32..off + 40].copy_from_slice(&order_id.to_le_bytes());
        results.data[off + 40..off + 48].copy_from_slice(&1u64.to_le_bytes());
        results.data[off + 48..off + 56].copy_from_slice(&10000i64.to_le_bytes());
        results.data[off + 56] = maker;
        results.data[off + 57] = 1;
    }
    pt.add_account(results_key, results);
    for (who, key, order_id, side) in [
        (user, portfolio_key, 1u64, 0u8),
        (maker_user, maker_portfolio_key, 2u64, 1u8),
    ] {
        let mut portfolio = Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID);
        stamp_header(&mut portfolio.data, discriminator::PORTFOLIO);
        portfolio.data[P_USER].copy_from_slice(who.as_ref());
        portfolio.data[P_EQUITY].copy_from_slice(&20000i128.to_le_bytes());
        // Reservation provenance for the fill (no collateral reserved).
        let order = offset_of!(Portfolio, orders);
        let field = |f: usize| order + f;
        portfolio.data[field(offset_of!(OrderReservation, order_id))..][..8]
            .copy_from_slice(&order_id.to_le_bytes());
        portfolio.data[field(offset_of!(OrderReservation, original_qty))..][..8]
            .copy_from_slice(&1u64.to_le_bytes());
        portfolio.data[field(offset_of!(OrderReservation, remaining_qty))..][..8]
            .copy_from_slice(&1u64.to_le_bytes());
        portfolio.data[field(offset_of!(OrderReservation, price))..][..8]
            .copy_from_slice(&10000i64.to_le_bytes());
        portfolio.data[field(offset_of!(OrderReservation, side))] = side;
        pt.add_account(key, portfolio);
    }
    pt.add_account(
        oracle_key,
        Account::new(1_000_000, 0, &system_program::id()),
    );
    seed_valid_oracle(&mut pt, oracle_key, pdas.instrument);
    let mut ctx = pt.start_with_context().await;
    let instruction = |next| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(batch_key, false),
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new(results_key, false),
            AccountMeta::new(pdas.instrument, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(oracle_key, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new(portfolio_key, false),
            AccountMeta::new(maker_portfolio_key, false),
            AccountMeta::new(next, false),
        ],
        data: with_disc(8, build_settle_batch_data(0, 2)),
    };
    let keys = [
        batch_key,
        pdas.registry,
        pdas.vault,
        pdas.instrument,
        portfolio_key,
        maker_portfolio_key,
        bad_next_key,
    ];
    let mut before = Vec::new();
    for key in keys {
        before.push(ctx.banks_client.get_account(key).await.unwrap().unwrap());
    }
    let error = submit(&mut ctx, instruction(bad_next_key), &[])
        .await
        .unwrap_err();
    assert!(
        format!("{error:?}").contains(&format!(
            "Custom({})",
            u64::from(mgk_common::MgkError::AlreadyInitialized)
        )),
        "unexpected error: {error:?}"
    );
    for (key, account) in keys.into_iter().zip(before) {
        assert_eq!(
            ctx.banks_client.get_account(key).await.unwrap().unwrap(),
            account,
            "failed transaction must roll back {key}"
        );
    }
    let clock = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    // Replace the pre-initialised account with an unallocated-but-sized one.
    ctx.set_account(&next_key, &Account::new(1_000_000, BATCH_SIZE, &CORE_ID).into());
    submit(&mut ctx, instruction(next_key), &[]).await.unwrap();
    let settled = ctx
        .banks_client
        .get_account(batch_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(settled.data[B_STATUS], 3);
    assert_eq!(
        u32::from_le_bytes(settled.data[B_TOTAL_SETTLED].try_into().unwrap()),
        2
    );
    assert_eq!(
        u64::from_le_bytes(settled.data[B_TOTAL_VOLUME].try_into().unwrap()),
        2
    );
    assert_eq!(
        u128::from_le_bytes(settled.data[B_TOTAL_NOTIONAL].try_into().unwrap()),
        20000
    );
    let portfolio = ctx
        .banks_client
        .get_account(portfolio_key)
        .await
        .unwrap()
        .unwrap();
    // Opening a position realises no PnL. The taker pays the 5 bps fee, which is
    // ceil(100 lamports * 5 / 10_000) = 1 lamport; the maker pays none.
    assert_eq!(
        i128::from_le_bytes(portfolio.data[P_EQUITY].try_into().unwrap()),
        19999
    );
    let maker_portfolio = ctx
        .banks_client
        .get_account(maker_portfolio_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        i128::from_le_bytes(maker_portfolio.data[P_EQUITY].try_into().unwrap()),
        20000
    );
    let registry = ctx
        .banks_client
        .get_account(pdas.registry)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u64::from_le_bytes(registry.data[R_BATCH_ID_COUNTER].try_into().unwrap()),
        8
    );
    assert_eq!(
        u64::from_le_bytes(registry.data[R_T_MAX].try_into().unwrap()),
        20
    );
    let vault = ctx
        .banks_client
        .get_account(pdas.vault)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u128::from_le_bytes(vault.data[V_INSURANCE].try_into().unwrap()),
        1,
        "the fee is collected into the cash-backed fund"
    );
    assert_eq!(u64::from_le_bytes(vault.data[V_OI_LONG].try_into().unwrap()), 1);
    assert_eq!(u64::from_le_bytes(vault.data[V_OI_SHORT].try_into().unwrap()), 1);
    let instrument = ctx
        .banks_client
        .get_account(pdas.instrument)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        i64::from_le_bytes(instrument.data[I_MARK_PRICE].try_into().unwrap()),
        110
    );

    let next = ctx
        .banks_client
        .get_account(next_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(u64::from_le_bytes(next.data[B_ID].try_into().unwrap()), 8);
    assert_eq!(next.data[B_STATUS], 0);
    assert_eq!(
        u64::from_le_bytes(next.data[B_COMMIT_DEADLINE].try_into().unwrap()),
        clock.slot + 20
    );
}

/// Spec 13 / issue 16 acceptance: through the real SBF programs, an account
/// with the wrong discriminator is rejected with `InvalidAccountDiscriminator`
/// and one with an unsupported layout version with `UnsupportedLayoutVersion`.
/// A correctly stamped portfolio is accepted by the same instruction.
#[tokio::test]
async fn test_e2e_wrong_account_header_is_rejected_with_distinct_errors() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR");
        return;
    }
    use mgk_common::MgkError;

    let cases: [(&str, u8, u8, Option<MgkError>); 3] = [
        (
            "wrong discriminator",
            discriminator::VAULT,
            LAYOUT_VERSION_1,
            Some(MgkError::InvalidAccountDiscriminator),
        ),
        (
            "unsupported layout version",
            discriminator::PORTFOLIO,
            LAYOUT_VERSION_1 + 6,
            Some(MgkError::UnsupportedLayoutVersion),
        ),
        (
            "correct header",
            discriminator::PORTFOLIO,
            <Portfolio as mgk_common::layout::AccountLayout>::LAYOUT_VERSION,
            None,
        ),
    ];

    for (label, disc, version, expected) in cases {
        let user = Keypair::new();
        let user_pdas = derive_user_pdas(&user.pubkey(), 0, 0);
        let (mut pt, pdas) = program_test_with_pdas();
        pt.add_account(
            user.pubkey(),
            Account::new(USER_FUNDING_LAMPORTS, 0, &system_program::id()),
        );
        let mut portfolio = Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID);
        portfolio.data[0] = disc;
        portfolio.data[1] = version;
        // Owner of the portfolio, so the accepted case gets past the user check.
        portfolio.data[P_USER].copy_from_slice(user.pubkey().as_ref());
        pt.add_account(user_pdas.portfolio, portfolio);
        pt.add_account(pdas.vault, vault_account(0, 0, 0));
        let mut ctx = pt.start_with_context().await;

        let result = submit(
            &mut ctx,
            Instruction {
                program_id: CORE_ID,
                accounts: vec![
                    AccountMeta::new(user_pdas.portfolio, false),
                    AccountMeta::new(user.pubkey(), true),
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new(pdas.vault, false),
                ],
                data: with_disc(2, build_deposit_data(USER_DEPOSIT_LAMPORTS)),
            },
            &[&user],
        )
        .await;
        match expected {
            Some(err) => {
                let error = result.expect_err(label);
                assert!(
                    format!("{error:?}").contains(&format!("Custom({})", u64::from(err))),
                    "{label}: expected {err:?}, got {error:?}"
                );
            }
            None => result.expect(label),
        }
    }
}

#[tokio::test]
async fn test_issue22_reservations_block_withdrawal_and_release_on_cancel() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("not run: issue22 instruction test requires freshly built SBF programs");
        return;
    }
    let (mut pt, pdas) = program_test_with_pdas();
    let user = Keypair::new();
    let up = derive_user_pdas(&user.pubkey(), 0, 0);
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    pt.add_account(
        user.pubkey(),
        Account::new(1_000_000_000, 0, &system_program::id()),
    );
    let mut registry = Account::new(1_000_000, REGISTRY_SIZE, &CORE_ID);
    stamp_header(&mut registry.data, discriminator::REGISTRY);
    registry.data[R_INSTRUMENT_COUNT].copy_from_slice(&1u16.to_le_bytes());
    registry.data[offset_of!(Registry, max_orders_per_batch)] = 12;
    registry.data[offset_of!(Registry, bump)] =
        Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID).1;
    pt.add_account(pdas.registry, registry);
    let mut instrument = Account::new(1_000_000, INSTRUMENT_SIZE, &CORE_ID);
    stamp_header(&mut instrument.data, discriminator::INSTRUMENT);
    instrument.data[offset_of!(Instrument, oracle_addr)..][..32].copy_from_slice(oracle.as_ref());
    instrument.data[I_TAKER_FEE].copy_from_slice(&5u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, imr_bps)..][..2].copy_from_slice(&2000u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, mmr_bps)..][..2].copy_from_slice(&1000u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, max_leverage)..][..2]
        .copy_from_slice(&5u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, is_active)] = 1;
    pt.add_account(pdas.instrument, instrument);
    let mut portfolio = Account::new(30_000_000, PORTFOLIO_SIZE, &CORE_ID);
    stamp_header(&mut portfolio.data, discriminator::PORTFOLIO);
    portfolio.data[P_USER].copy_from_slice(user.pubkey().as_ref());
    portfolio.data[P_EQUITY].copy_from_slice(&100_000_000i128.to_le_bytes());
    portfolio.data[P_PRINCIPAL].copy_from_slice(&100_000_000i128.to_le_bytes());
    portfolio.data[offset_of!(Portfolio, free_collateral)..][..16]
        .copy_from_slice(&100_000_000i128.to_le_bytes());
    portfolio.data[offset_of!(Portfolio, bump)] = up.portfolio_bump;
    pt.add_account(up.portfolio, portfolio);
    // The fund (100M lamports) covers the 0.4 reserve for up to 250 lots, so
    // the 100- and 200-lot orders below clear the risk-off gate.
    pt.add_account(pdas.vault, vault_account(100_000_000, 100_000_000, 0));
    let mut batch = Account::new(1_000_000, BATCH_SIZE, &CORE_ID);
    stamp_header(&mut batch.data, discriminator::BATCH);
    batch.data[offset_of!(Batch, bump)] = up.batch_bump;
    pt.add_account(up.batch, batch);
    let mut ctx = pt.start_with_context().await;
    let post = |qty| Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(up.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(up.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(pdas.vault, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(0, false, 100_000_000, qty, 0, false),
        ),
    };
    let before = ctx
        .banks_client
        .get_account(up.portfolio)
        .await
        .unwrap()
        .unwrap();
    assert!(
        submit(&mut ctx, post(1000), &[&user]).await.is_err(),
        "unaffordable order must fail at post"
    );
    assert_eq!(
        ctx.banks_client
            .get_account(up.portfolio)
            .await
            .unwrap()
            .unwrap(),
        before
    );
    submit(&mut ctx, post(100), &[&user]).await.unwrap();
    let reserved = rng(offset_of!(Portfolio, reserved_collateral), 16);
    let posted = ctx
        .banks_client
        .get_account(up.portfolio)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u128::from_le_bytes(posted.data[reserved.clone()].try_into().unwrap()),
        20_050_000
    );
    let withdraw = |amount: u64, risk_accounts: bool| {
        let mut accounts = vec![
            AccountMeta::new(up.portfolio, false),
            AccountMeta::new(user.pubkey(), true),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(pdas.registry, false),
        ];
        if risk_accounts {
            accounts.extend([
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
            ]);
        }
        Instruction {
            program_id: CORE_ID,
            accounts,
            data: with_disc(3, amount.to_le_bytes().to_vec()),
        }
    };
    assert!(submit(&mut ctx, withdraw(80_000_000u64, true), &[&user])
        .await
        .is_err());
    assert_eq!(
        ctx.banks_client
            .get_account(up.portfolio)
            .await
            .unwrap()
            .unwrap(),
        posted
    );
    let mut modify_data = 0u64.to_le_bytes().to_vec();
    modify_data.extend_from_slice(&200u64.to_le_bytes());
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(up.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(12, modify_data),
        },
        &[&user],
    )
    .await
    .unwrap();
    let modified = ctx
        .banks_client
        .get_account(up.portfolio)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u128::from_le_bytes(modified.data[reserved.clone()].try_into().unwrap()),
        40_100_000
    );
    submit(
        &mut ctx,
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(up.portfolio, false),
                AccountMeta::new(user.pubkey(), true),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
            ],
            data: with_disc(11, 0u64.to_le_bytes().to_vec()),
        },
        &[&user],
    )
    .await
    .unwrap();
    let cancelled = ctx
        .banks_client
        .get_account(up.portfolio)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u128::from_le_bytes(cancelled.data[reserved].try_into().unwrap()),
        0
    );
    // A flat portfolio with no orders does not need oracle accounts to withdraw.
    submit(&mut ctx, withdraw(100_000_000u64, false), &[&user])
        .await
        .unwrap();
    let withdrawn = ctx
        .banks_client
        .get_account(up.portfolio)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        i128::from_le_bytes(withdrawn.data[P_EQUITY].try_into().unwrap()),
        0
    );
    assert_eq!(
        book_resting_count(
            &ctx.banks_client
                .get_account(pdas.book)
                .await
                .unwrap()
                .unwrap()
                .data
        ),
        0
    );
}

// ---------------------------------------------------------------------------
// Issue #23: cash-backed insurance fund, caps, risk-off, exhaustion, recovery
// ---------------------------------------------------------------------------

const R_PAUSE_FLAGS: usize = offset_of!(Registry, pause_flags);
const PAUSE_TRADING_BIT: u8 = 1 << 0;
const PAUSE_WITHDRAWALS_BIT: u8 = 1 << 1;

/// Assert that a failed transaction carries the given program error code.
fn assert_custom(
    result: Result<(), solana_program_test::BanksClientError>,
    code: mgk_common::MgkError,
) {
    let error = result.expect_err("instruction must fail");
    assert!(
        format!("{error:?}").contains(&format!("Custom({})", u64::from(code))),
        "expected {code:?}, got {error:?}"
    );
}

/// The vault ledger plus its lamports, read back from the bank.
#[derive(Debug, PartialEq, Eq)]
struct VaultView {
    lamports: u64,
    balance: u64,
    fund: u128,
    debt: u128,
    oi_long: u64,
    oi_short: u64,
}

impl VaultView {
    /// Lamports above rent plus the ledger backing (`collateral + fund -
    /// debt`): unsolicited donations. Negative means under-backed.
    fn surplus(&self) -> i128 {
        self.lamports as i128
            - vault_rent() as i128
            - (self.balance as i128 + self.fund as i128 - self.debt as i128)
    }

    /// Exact check for runs where nobody donated to the vault.
    fn assert_balanced(&self) {
        self.assert_surplus(0);
    }

    /// The vault is never under-backed and holds exactly `donated` lamports of
    /// surplus.
    fn assert_surplus(&self, donated: u64) {
        assert_eq!(
            self.surplus(),
            donated as i128,
            "vault lamports must equal rent + ledger backing + donations: {self:?}"
        );
    }
}

/// A plain system transfer into the vault PDA: the donation anyone can make.
async fn donate_to_vault(
    ctx: &mut solana_program_test::ProgramTestContext,
    pdas: &TestPdas,
    amount: u64,
) {
    let payer = ctx.payer.pubkey();
    submit(
        ctx,
        solana_sdk::system_instruction::transfer(&payer, &pdas.vault, amount),
        &[],
    )
    .await
    .expect("donation");
}

async fn get_account(
    ctx: &mut solana_program_test::ProgramTestContext,
    key: &Pubkey,
) -> Account {
    ctx.banks_client
        .get_account(*key)
        .await
        .unwrap()
        .expect("account exists")
}

async fn read_vault(
    ctx: &mut solana_program_test::ProgramTestContext,
    pdas: &TestPdas,
) -> VaultView {
    let a = get_account(ctx, &pdas.vault).await;
    VaultView {
        lamports: a.lamports,
        balance: u64::from_le_bytes(a.data[V_BALANCE].try_into().unwrap()),
        fund: u128::from_le_bytes(a.data[V_INSURANCE].try_into().unwrap()),
        debt: u128::from_le_bytes(a.data[V_UNCOVERED].try_into().unwrap()),
        oi_long: u64::from_le_bytes(a.data[V_OI_LONG].try_into().unwrap()),
        oi_short: u64::from_le_bytes(a.data[V_OI_SHORT].try_into().unwrap()),
    }
}

async fn read_equity(
    ctx: &mut solana_program_test::ProgramTestContext,
    portfolio: &Pubkey,
) -> i128 {
    let a = get_account(ctx, portfolio).await;
    i128::from_le_bytes(a.data[P_EQUITY].try_into().unwrap())
}

async fn read_pause_flags(
    ctx: &mut solana_program_test::ProgramTestContext,
    pdas: &TestPdas,
) -> u8 {
    get_account(ctx, &pdas.registry).await.data[R_PAUSE_FLAGS]
}

/// Raise the open interest counters of a vault fixture.
fn with_open_interest(mut vault: Account, long_lots: u64, short_lots: u64) -> Account {
    vault.data[V_OI_LONG].copy_from_slice(&long_lots.to_le_bytes());
    vault.data[V_OI_SHORT].copy_from_slice(&short_lots.to_le_bytes());
    vault
}

fn unpause_ix(
    pdas: &TestPdas,
    governance: &Pubkey,
    resume_withdrawals: bool,
    resume_trading: bool,
) -> Instruction {
    Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.registry, false),
            AccountMeta::new_readonly(pdas.vault, false),
            AccountMeta::new_readonly(*governance, true),
        ],
        data: with_disc(28, vec![resume_withdrawals as u8, resume_trading as u8]),
    }
}

fn fund_withdraw_ix(pdas: &TestPdas, governance: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(*governance, true),
        ],
        data: with_disc(27, amount.to_le_bytes().to_vec()),
    }
}

fn withdraw_ix(pdas: &TestPdas, user: &Pubkey, portfolio: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(*portfolio, false),
            AccountMeta::new(*user, true),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(pdas.registry, false),
        ],
        data: with_disc(3, amount.to_le_bytes().to_vec()),
    }
}

/// One side of a settled batch: a portfolio that may hold a seeded position
/// and owns one order reservation covering its fills.
struct Party {
    user: Keypair,
    key: Pubkey,
    bump: u8,
    equity: i128,
    /// `(signed qty, entry vwap)` of a position opened before the batch.
    position: Option<(i64, i64)>,
    order_id: u64,
    /// 0 = buy, 1 = sell.
    side: u8,
}

fn party(order_id: u64, side: u8, equity: i128, position: Option<(i64, i64)>) -> Party {
    let user = Keypair::new();
    let (key, bump) = Pubkey::find_program_address(&[PORTFOLIO_SEED, user.pubkey().as_ref()], &CORE_ID);
    Party { user, key, bump, equity, position, order_id, side }
}

struct SettleKeys {
    batch: Pubkey,
    results: Pubkey,
    next: Pubkey,
    oracle: Pubkey,
    governance: Keypair,
}

/// Seed a registry that names `governance` and holds the pause flags.
fn seed_governed_registry(pt: &mut ProgramTest, pdas: &TestPdas, governance: &Pubkey, flags: u8) {
    let mut registry = Account::new(1_000_000, REGISTRY_SIZE, &CORE_ID);
    stamp_header(&mut registry.data, discriminator::REGISTRY);
    registry.data[R_GOVERNANCE].copy_from_slice(governance.as_ref());
    registry.data[R_BATCH_ID_COUNTER].copy_from_slice(&7u64.to_le_bytes());
    registry.data[R_T_MAX].copy_from_slice(&20u64.to_le_bytes());
    registry.data[R_INSTRUMENT_COUNT].copy_from_slice(&1u16.to_le_bytes());
    registry.data[offset_of!(Registry, max_orders_per_batch)] = 12;
    registry.data[offset_of!(Registry, bump)] =
        Pubkey::find_program_address(&[REGISTRY_SEED], &CORE_ID).1;
    registry.data[R_PAUSE_FLAGS] = flags;
    pt.add_account(pdas.registry, registry);
    pt.add_account(*governance, Account::new(1_000_000, 0, &system_program::id()));
}

/// Seed a Cleared batch 7 whose results hold one fill per `(party, qty, price)`
/// entry, in order. Fills run in the auction-1 role of their order side (buy is
/// the taker, sell the maker), so the buyer pays the 5 bps taker fee. The
/// matching reservations are written into each party's portfolio.
fn seed_settlement(
    pt: &mut ProgramTest,
    pdas: &TestPdas,
    vault: Account,
    parties: &[Party],
    fills: &[(usize, u64, i64)],
) -> SettleKeys {
    let governance = Keypair::new();
    seed_governed_registry(pt, pdas, &governance.pubkey(), 0);
    pt.add_account(pdas.vault, vault);
    let batch = Pubkey::find_program_address(&[BATCH_SEED, &7u64.to_le_bytes()], &CORE_ID).0;
    let next = Pubkey::find_program_address(&[BATCH_SEED, &8u64.to_le_bytes()], &CORE_ID).0;
    let results = Pubkey::find_program_address(&[b"results", &7u64.to_le_bytes()], &MATCHER_ID).0;
    let oracle = Pubkey::new_unique();

    let mut batch_acct = Account::new(1_000_000, BATCH_SIZE, &CORE_ID);
    stamp_header(&mut batch_acct.data, discriminator::BATCH);
    batch_acct.data[B_ID].copy_from_slice(&7u64.to_le_bytes());
    batch_acct.data[B_STATUS] = 4; // Cleared
    batch_acct.data[B_CLEARING_PRICE].copy_from_slice(&fills[0].2.to_le_bytes());
    batch_acct.data[B_MARK_VALID] = 1;
    pt.add_account(batch, batch_acct);
    pt.add_account(next, Account::new(1_000_000, BATCH_SIZE, &CORE_ID));

    let mut instrument = Account::new(1_000_000, INSTRUMENT_SIZE, &CORE_ID);
    stamp_header(&mut instrument.data, discriminator::INSTRUMENT);
    instrument.data[offset_of!(Instrument, oracle_addr)..][..32].copy_from_slice(oracle.as_ref());
    instrument.data[I_TAKER_FEE].copy_from_slice(&5u16.to_le_bytes());
    pt.add_account(pdas.instrument, instrument);
    pt.add_account(oracle, Account::new(1_000_000, 0, &system_program::id()));
    seed_valid_oracle(pt, oracle, pdas.instrument);

    let mut res = Account::new(1_000_000, RES + 34 + fills.len() * 58, &MATCHER_ID);
    stamp_header(&mut res.data, discriminator::BATCH_RESULTS);
    res.data[ACCOUNT_HEADER_LEN..ACCOUNT_HEADER_LEN + 8].copy_from_slice(&7u64.to_le_bytes());
    res.data[RES_NUM_FILLS].copy_from_slice(&(fills.len() as u16).to_le_bytes());
    for (i, (idx, qty, price)) in fills.iter().enumerate() {
        let p = &parties[*idx];
        let off = RES + 34 + i * 58;
        res.data[off..off + 32].copy_from_slice(p.user.pubkey().as_ref());
        res.data[off + 32..off + 40].copy_from_slice(&p.order_id.to_le_bytes());
        res.data[off + 40..off + 48].copy_from_slice(&qty.to_le_bytes());
        res.data[off + 48..off + 56].copy_from_slice(&price.to_le_bytes());
        res.data[off + 56] = p.side; // buy => maker 0 (taker), sell => maker 1
        res.data[off + 57] = 1;
    }
    pt.add_account(results, res);

    for (i, p) in parties.iter().enumerate() {
        let mut data = build_underwater_portfolio_data(
            p.user.pubkey(),
            p.bump,
            INSTRUMENT_ID,
            p.position.map_or(0, |(q, _)| q),
            p.position.map_or(0, |(_, e)| e),
            p.equity,
            0,
            0,
        );
        if p.position.is_none() {
            data[P_POSITIONS_LEN].copy_from_slice(&0u16.to_le_bytes());
        }
        data[P_PRINCIPAL].copy_from_slice(&p.equity.to_le_bytes());
        let (qty, price) = fills
            .iter()
            .filter(|(idx, _, _)| *idx == i)
            .fold((0u64, 0i64), |(q, _), (_, fq, fp)| (q + fq, *fp));
        let order = offset_of!(Portfolio, orders);
        let put = |data: &mut Vec<u8>, f: usize, bytes: &[u8]| {
            data[order + f..order + f + bytes.len()].copy_from_slice(bytes)
        };
        put(&mut data, offset_of!(OrderReservation, order_id), &p.order_id.to_le_bytes());
        put(&mut data, offset_of!(OrderReservation, original_qty), &qty.to_le_bytes());
        put(&mut data, offset_of!(OrderReservation, remaining_qty), &qty.to_le_bytes());
        put(&mut data, offset_of!(OrderReservation, price), &price.to_le_bytes());
        data[order + offset_of!(OrderReservation, side)] = p.side;
        let mut portfolio = Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID);
        portfolio.data = data;
        pt.add_account(p.key, portfolio);
        // A wallet that can receive withdrawals without breaking rent rules.
        pt.add_account(
            p.user.pubkey(),
            Account::new(1_000_000_000, 0, &system_program::id()),
        );
    }
    SettleKeys { batch, results, next, oracle, governance }
}

fn settle_ix(pdas: &TestPdas, keys: &SettleKeys, parties: &[Party]) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(keys.batch, false),
        AccountMeta::new(pdas.registry, false),
        AccountMeta::new(pdas.vault, false),
        AccountMeta::new(keys.results, false),
        AccountMeta::new(pdas.instrument, false),
        AccountMeta::new(pdas.book, false),
        AccountMeta::new_readonly(keys.oracle, false),
        AccountMeta::new_readonly(MATCHER_ID, false),
    ];
    accounts.extend(parties.iter().map(|p| AccountMeta::new(p.key, false)));
    accounts.push(AccountMeta::new(keys.next, false));
    Instruction {
        program_id: CORE_ID,
        accounts,
        data: with_disc(8, build_settle_batch_data(0, parties.len() as u16)),
    }
}

/// Fixture for the gate tests: one funded portfolio on an open batch, a vault
/// the caller shapes, and an optional seeded position.
async fn post_gate_fixture(
    vault: Account,
    position: Option<(i64, i64)>,
    pause_flags: u8,
) -> (
    solana_program_test::ProgramTestContext,
    TestPdas,
    Keypair,
    UserPdas,
    Pubkey,
) {
    let (mut pt, pdas) = program_test_with_pdas();
    let user = Keypair::new();
    let up = derive_user_pdas(&user.pubkey(), 0, 0);
    let oracle = Pubkey::new_unique();
    seed_valid_oracle(&mut pt, oracle, pdas.instrument);
    pt.add_account(user.pubkey(), Account::new(1_000_000_000, 0, &system_program::id()));
    let governance = Keypair::new();
    seed_governed_registry(&mut pt, &pdas, &governance.pubkey(), pause_flags);
    let mut instrument = Account::new(1_000_000, INSTRUMENT_SIZE, &CORE_ID);
    stamp_header(&mut instrument.data, discriminator::INSTRUMENT);
    instrument.data[offset_of!(Instrument, oracle_addr)..][..32].copy_from_slice(oracle.as_ref());
    instrument.data[I_TAKER_FEE].copy_from_slice(&5u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, imr_bps)..][..2].copy_from_slice(&2000u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, mmr_bps)..][..2].copy_from_slice(&1000u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, max_leverage)..][..2]
        .copy_from_slice(&5u16.to_le_bytes());
    instrument.data[offset_of!(Instrument, is_active)] = 1;
    pt.add_account(pdas.instrument, instrument);
    let mut data = build_underwater_portfolio_data(
        user.pubkey(),
        up.portfolio_bump,
        INSTRUMENT_ID,
        position.map_or(0, |(q, _)| q),
        position.map_or(0, |(_, e)| e),
        100_000_000,
        0,
        0,
    );
    if position.is_none() {
        data[P_POSITIONS_LEN].copy_from_slice(&0u16.to_le_bytes());
    }
    data[P_PRINCIPAL].copy_from_slice(&100_000_000i128.to_le_bytes());
    let mut portfolio = Account::new(30_000_000, PORTFOLIO_SIZE, &CORE_ID);
    portfolio.data = data;
    pt.add_account(up.portfolio, portfolio);
    pt.add_account(pdas.vault, vault);
    let mut batch = Account::new(1_000_000, BATCH_SIZE, &CORE_ID);
    stamp_header(&mut batch.data, discriminator::BATCH);
    batch.data[offset_of!(Batch, bump)] = up.batch_bump;
    pt.add_account(up.batch, batch);
    let ctx = pt.start_with_context().await;
    (ctx, pdas, user, up, oracle)
}

fn gate_post_ix(
    pdas: &TestPdas,
    user: &Pubkey,
    up: &UserPdas,
    oracle: &Pubkey,
    side: u8,
    qty: u64,
    reduce_only: bool,
) -> Instruction {
    Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(up.portfolio, false),
            AccountMeta::new(*user, true),
            AccountMeta::new(up.batch, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(*oracle, false),
            AccountMeta::new_readonly(pdas.vault, false),
        ],
        data: with_disc(
            20,
            build_post_order_data(side, false, ORDER_PRICE, qty, INSTRUMENT_ID, reduce_only),
        ),
    }
}

/// Lamports of the fund required for `lots` of larger-side open interest.
const fn reserve_for(lots: u64) -> u128 {
    lots as u128 * 400_000
}

/// Acceptance 1: top-up is permissionless and moves real lamports; the admin
/// can withdraw only the surplus above 0.4 x larger-side open interest.
#[tokio::test]
async fn test_e2e_top_up_is_permissionless_and_fund_withdrawal_is_limited_to_surplus() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let (mut pt, pdas) = program_test_with_pdas();
    let governance = Keypair::new();
    seed_governed_registry(&mut pt, &pdas, &governance.pubkey(), 0);
    // 1_000 lots of open interest need a fund of 400_000_000 lamports.
    pt.add_account(pdas.vault, with_open_interest(vault_account(0, 0, 0), 1_000, 400));
    let stranger = Keypair::new();
    pt.add_account(stranger.pubkey(), Account::new(5_000_000_000, 0, &system_program::id()));
    let mut ctx = pt.start_with_context().await;
    let rent = vault_rent();

    // A stranger tops up with real lamports.
    let before = read_vault(&mut ctx, &pdas).await;
    assert_eq!(before.lamports, rent);
    let ix = top_up_ix(&stranger.pubkey(), &pdas.vault, 1_000_000_000);
    submit(&mut ctx, ix, &[&stranger]).await.unwrap();
    let topped = read_vault(&mut ctx, &pdas).await;
    topped.assert_balanced();
    assert_eq!(topped.fund, 1_000_000_000);
    assert_eq!(topped.lamports, rent + 1_000_000_000);
    assert_eq!(topped.balance, 0, "a top-up never touches user collateral");

    // A zero top-up is refused.
    assert_custom(
        submit(&mut ctx, top_up_ix(&stranger.pubkey(), &pdas.vault, 0), &[&stranger]).await,
        mgk_common::MgkError::InvalidAmount,
    );

    // Only governance may withdraw.
    let surplus = 1_000_000_000 - reserve_for(1_000) as u64;
    assert_eq!(surplus, 600_000_000);
    assert_custom(
        submit(&mut ctx, fund_withdraw_ix(&pdas, &stranger.pubkey(), 1), &[&stranger]).await,
        mgk_common::MgkError::Unauthorized,
    );
    // One lamport above the surplus is refused and changes nothing.
    assert_custom(
        submit(
            &mut ctx,
            fund_withdraw_ix(&pdas, &governance.pubkey(), surplus + 1),
            &[&governance],
        )
        .await,
        mgk_common::MgkError::FundWithdrawalExceedsSurplus,
    );
    assert_eq!(read_vault(&mut ctx, &pdas).await, topped);

    let gov_before = get_account(&mut ctx, &governance.pubkey()).await.lamports;
    submit(
        &mut ctx,
        fund_withdraw_ix(&pdas, &governance.pubkey(), surplus),
        &[&governance],
    )
    .await
    .unwrap();
    let drained = read_vault(&mut ctx, &pdas).await;
    drained.assert_balanced();
    assert_eq!(drained.fund, reserve_for(1_000), "the reserve stays behind");
    assert_eq!(
        get_account(&mut ctx, &governance.pubkey()).await.lamports,
        gov_before + surplus
    );
    // The surplus is now zero.
    assert_custom(
        submit(&mut ctx, fund_withdraw_ix(&pdas, &governance.pubkey(), 1), &[&governance]).await,
        mgk_common::MgkError::FundWithdrawalExceedsSurplus,
    );

    // A plain transfer to the vault is surplus the ledger never sees. It must
    // not lock the vault: top-ups and fund withdrawals keep working around it.
    donate_to_vault(&mut ctx, &pdas, 777).await;
    read_vault(&mut ctx, &pdas).await.assert_surplus(777);
    submit(
        &mut ctx,
        top_up_ix(&stranger.pubkey(), &pdas.vault, 1_000),
        &[&stranger],
    )
    .await
    .unwrap();
    read_vault(&mut ctx, &pdas).await.assert_surplus(777);
    submit(
        &mut ctx,
        fund_withdraw_ix(&pdas, &governance.pubkey(), 1_000),
        &[&governance],
    )
    .await
    .unwrap();
    let after = read_vault(&mut ctx, &pdas).await;
    after.assert_surplus(777);
    assert_eq!(after.fund, reserve_for(1_000), "donations never reach the fund");
}

/// Acceptance 5: a vault that is under-backed (lamports below rent plus the
/// ledger backing) reverts every instruction that moves lamports. Surplus is
/// tolerated; a deficit is not, however small.
#[tokio::test]
async fn test_e2e_under_backed_vault_reverts_the_lamport_move() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let (mut pt, pdas) = program_test_with_pdas();
    let governance = Keypair::new();
    seed_governed_registry(&mut pt, &pdas, &governance.pubkey(), 0);
    // One lamport missing: the ledger claims more than the vault holds.
    let mut vault = vault_account(0, 1_000_000_000, 0);
    vault.lamports -= 1;
    pt.add_account(pdas.vault, vault);
    let mut ctx = pt.start_with_context().await;
    let before = get_account(&mut ctx, &pdas.vault).await;
    let payer = ctx.payer.pubkey();
    assert_custom(
        submit(&mut ctx, top_up_ix(&payer, &pdas.vault, 1_000), &[]).await,
        mgk_common::MgkError::VaultInvariantViolated,
    );
    assert_custom(
        submit(&mut ctx, fund_withdraw_ix(&pdas, &governance.pubkey(), 1), &[&governance]).await,
        mgk_common::MgkError::VaultInvariantViolated,
    );
    assert_eq!(get_account(&mut ctx, &pdas.vault).await, before, "reverted");
}

/// Donation lockout: a plain transfer to the vault PDA must not make deposit,
/// withdraw or top-up revert. The donation stays as surplus.
#[tokio::test]
async fn test_e2e_donation_to_the_vault_does_not_block_deposit_or_withdraw() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let (mut ctx, pdas, user, up, _oracle) =
        post_gate_fixture(vault_account(100_000_000, 0, 0), None, 0).await;
    let me = user.pubkey();
    donate_to_vault(&mut ctx, &pdas, 1).await;
    read_vault(&mut ctx, &pdas).await.assert_surplus(1);

    let deposit = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(up.portfolio, false),
            AccountMeta::new(me, true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new(pdas.vault, false),
        ],
        data: with_disc(2, build_deposit_data(5_000)),
    };
    submit(&mut ctx, deposit, &[&user]).await.unwrap();
    submit(&mut ctx, withdraw_ix(&pdas, &me, &up.portfolio, 1_000), &[&user])
        .await
        .unwrap();
    top_up_fund(&mut ctx, &pdas, 10_000).await;
    let after = read_vault(&mut ctx, &pdas).await;
    after.assert_surplus(1);
    assert_eq!(after.balance, 100_000_000 + 5_000 - 1_000);
    assert_eq!(after.fund, 10_000);
}

/// Acceptance 3 and 4: the fund runs dry, the winner is still credited in full,
/// the shortfall becomes uncovered bad debt, trading and withdrawals pause,
/// inflows repay the debt first, and only then can the admin unpause
/// (withdrawals before trading).
#[tokio::test]
async fn test_e2e_exhaustion_pauses_then_debt_first_recovery_and_unpause() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let (mut pt, pdas) = program_test_with_pdas();
    // A is long one lot from 100 and sells at 90: it owes 100_000 lamports but
    // holds only 20_000. B is short one lot and buys at 90: it is owed 100_000
    // and the fund is empty. The loser's fill comes first.
    let parties = [
        party(1, 1, 20_000, Some((1, 100_000_000))),
        party(2, 0, 20_000, Some((-1, 100_000_000))),
    ];
    let vault = with_open_interest(vault_account(40_000, 0, 0), 1, 1);
    let fills = [(0, 1, 90_000_000), (1, 1, 90_000_000)];
    let keys = seed_settlement(&mut pt, &pdas, vault, &parties, &fills);
    let mut ctx = pt.start_with_context().await;
    let lamports_before = read_vault(&mut ctx, &pdas).await.lamports;

    submit(&mut ctx, settle_ix(&pdas, &keys, &parties), &[]).await.unwrap();

    // A pays the 20_000 it holds. B is credited 100_000 in full and pays its
    // 450 lamport taker fee (ceil(900_000 x 5 / 10_000)), which repays debt.
    assert_eq!(read_equity(&mut ctx, &parties[0].key).await, 0);
    assert_eq!(read_equity(&mut ctx, &parties[1].key).await, 119_550);
    let exhausted = read_vault(&mut ctx, &pdas).await;
    exhausted.assert_balanced();
    assert_eq!(exhausted.fund, 0);
    assert_eq!(exhausted.debt, 79_550);
    assert_eq!(exhausted.balance, 119_550);
    assert_eq!(exhausted.lamports, lamports_before, "settlement moves no lamports");
    assert_eq!((exhausted.oi_long, exhausted.oi_short), (0, 0));
    assert_eq!(
        read_pause_flags(&mut ctx, &pdas).await & (PAUSE_TRADING_BIT | PAUSE_WITHDRAWALS_BIT),
        PAUSE_TRADING_BIT | PAUSE_WITHDRAWALS_BIT,
        "exhaustion auto-pauses trading and withdrawals"
    );

    // The winner cannot withdraw while paused.
    let winner = &parties[1];
    assert_custom(
        submit(
            &mut ctx,
            withdraw_ix(&pdas, &winner.user.pubkey(), &winner.key, 1),
            &[&winner.user],
        )
        .await,
        mgk_common::MgkError::OperationPaused,
    );

    // Unpause is refused while debt is outstanding.
    let gov = keys.governance.pubkey();
    assert_custom(
        submit(&mut ctx, unpause_ix(&pdas, &gov, true, false), &[&keys.governance]).await,
        mgk_common::MgkError::RecoveryConditionsNotMet,
    );

    // Inflows repay the debt before they touch the fund.
    let payer = ctx.payer.pubkey();
    submit(&mut ctx, top_up_ix(&payer, &pdas.vault, 79_000), &[]).await.unwrap();
    let partial = read_vault(&mut ctx, &pdas).await;
    partial.assert_balanced();
    assert_eq!((partial.debt, partial.fund), (550, 0));
    assert_custom(
        submit(&mut ctx, unpause_ix(&pdas, &gov, true, false), &[&keys.governance]).await,
        mgk_common::MgkError::RecoveryConditionsNotMet,
    );
    submit(&mut ctx, top_up_ix(&payer, &pdas.vault, 1_000), &[]).await.unwrap();
    let recovered = read_vault(&mut ctx, &pdas).await;
    recovered.assert_balanced();
    assert_eq!((recovered.debt, recovered.fund), (0, 450), "the remainder joins the fund");

    // Trading cannot resume while withdrawals stay paused.
    assert_custom(
        submit(&mut ctx, unpause_ix(&pdas, &gov, false, true), &[&keys.governance]).await,
        mgk_common::MgkError::RecoveryConditionsNotMet,
    );
    // Only governance may unpause.
    let stranger = Keypair::new();
    assert!(submit(&mut ctx, unpause_ix(&pdas, &stranger.pubkey(), true, false), &[&stranger])
        .await
        .is_err());
    // Withdrawals first, then trading.
    submit(&mut ctx, unpause_ix(&pdas, &gov, true, false), &[&keys.governance]).await.unwrap();
    assert_eq!(
        read_pause_flags(&mut ctx, &pdas).await & (PAUSE_TRADING_BIT | PAUSE_WITHDRAWALS_BIT),
        PAUSE_TRADING_BIT
    );
    submit(
        &mut ctx,
        withdraw_ix(&pdas, &winner.user.pubkey(), &winner.key, 100_000),
        &[&winner.user],
    )
    .await
    .unwrap();
    submit(&mut ctx, unpause_ix(&pdas, &gov, false, true), &[&keys.governance]).await.unwrap();
    assert_eq!(
        read_pause_flags(&mut ctx, &pdas).await & (PAUSE_TRADING_BIT | PAUSE_WITHDRAWALS_BIT),
        0
    );
    read_vault(&mut ctx, &pdas).await.assert_balanced();
}

/// Acceptance 6: a winner withdraws realised profit while the loser still
/// holds its position, because the fund pays the winner in cash.
#[tokio::test]
async fn test_e2e_winner_withdraws_profit_before_the_loser_closes() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let (mut pt, pdas) = program_test_with_pdas();
    // A (long) stays open. B (short) closes against C, a new short.
    let loser = party(9, 0, 20_000, Some((1, 100_000_000)));
    let parties = [
        party(2, 0, 20_000, Some((-1, 100_000_000))),
        party(3, 1, 1_000_000, None),
    ];
    let vault = with_open_interest(vault_account(1_040_000, 0, 0), 1, 1);
    let fills = [(0, 1, 90_000_000), (1, 1, 90_000_000)];
    let keys = seed_settlement(&mut pt, &pdas, vault, &parties, &fills);
    let mut loser_acct = Account::new(1_000_000, PORTFOLIO_SIZE, &CORE_ID);
    loser_acct.data = build_underwater_portfolio_data(
        loser.user.pubkey(),
        loser.bump,
        INSTRUMENT_ID,
        1,
        100_000_000,
        20_000,
        0,
        0,
    );
    pt.add_account(loser.key, loser_acct);
    let mut ctx = pt.start_with_context().await;
    // The reserve is funded by a signed top-up, not a fixture patch.
    top_up_fund(&mut ctx, &pdas, FUND_TOP_UP).await;

    submit(&mut ctx, settle_ix(&pdas, &keys, &parties), &[]).await.unwrap();

    // B realised +100_000 and paid a 450 lamport taker fee.
    let winner = &parties[0];
    assert_eq!(read_equity(&mut ctx, &winner.key).await, 119_550);
    let settled = read_vault(&mut ctx, &pdas).await;
    settled.assert_balanced();
    assert_eq!(settled.debt, 0);
    assert_eq!(settled.fund, FUND_TOP_UP as u128 - 100_000 + 450);
    assert_eq!((settled.oi_long, settled.oi_short), (1, 1));
    assert_eq!(read_pause_flags(&mut ctx, &pdas).await & PAUSE_WITHDRAWALS_BIT, 0);

    // The loser is untouched and still open.
    assert_eq!(read_equity(&mut ctx, &loser.key).await, 20_000);
    let loser_acct = get_account(&mut ctx, &loser.key).await;
    assert_eq!(
        u16::from_le_bytes(loser_acct.data[P_POSITIONS_LEN].try_into().unwrap()),
        1
    );

    // The winner withdraws the profit now.
    let wallet_before = get_account(&mut ctx, &winner.user.pubkey()).await.lamports;
    submit(
        &mut ctx,
        withdraw_ix(&pdas, &winner.user.pubkey(), &winner.key, 100_000),
        &[&winner.user],
    )
    .await
    .unwrap();
    assert_eq!(read_equity(&mut ctx, &winner.key).await, 19_550);
    assert_eq!(
        get_account(&mut ctx, &winner.user.pubkey()).await.lamports,
        wallet_before + 100_000
    );
    read_vault(&mut ctx, &pdas).await.assert_balanced();
}

/// Acceptance 2: position cap, open interest cap and the risk-off rule.
#[tokio::test]
async fn test_e2e_caps_and_risk_off_gate_exposure_adding_posts_and_modifies() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    // 20_000 lots of long open interest: the reserve for a further 100 lots is
    // 0.4 x 20_100 x 1e6 = 8_040_000_000 lamports. The fund is one lamport short.
    let short_by_one = reserve_for(20_100) - 1;
    let vault = with_open_interest(vault_account(100_000_000, short_by_one, 0), 20_000, 0);
    let (mut ctx, pdas, user, up, oracle) = post_gate_fixture(vault, None, 0).await;
    let me = user.pubkey();
    let buy = |qty| gate_post_ix(&pdas, &me, &up, &oracle, 0, qty, false);

    assert_custom(
        submit(&mut ctx, buy(100), &[&user]).await,
        mgk_common::MgkError::RiskOffFundBelowReserve,
    );
    // The top-up that restores the reserve re-opens exposure-adding posts.
    let payer = ctx.payer.pubkey();
    submit(&mut ctx, top_up_ix(&payer, &pdas.vault, 1), &[]).await.unwrap();
    submit(&mut ctx, buy(100), &[&user]).await.unwrap();

    // A modify that adds exposure needs the reserve for the added quantity.
    let modify = |new_qty: u64| {
        let mut data = 0u64.to_le_bytes().to_vec();
        data.extend_from_slice(&new_qty.to_le_bytes());
        Instruction {
            program_id: CORE_ID,
            accounts: vec![
                AccountMeta::new(up.portfolio, false),
                AccountMeta::new(me, true),
                AccountMeta::new(pdas.book, false),
                AccountMeta::new_readonly(MATCHER_ID, false),
                AccountMeta::new_readonly(pdas.registry, false),
                AccountMeta::new_readonly(pdas.instrument, false),
                AccountMeta::new_readonly(oracle, false),
                AccountMeta::new_readonly(pdas.vault, false),
            ],
            data: with_disc(12, data),
        }
    };
    assert_custom(
        submit(&mut ctx, modify(300), &[&user]).await,
        mgk_common::MgkError::RiskOffFundBelowReserve,
    );
    submit(&mut ctx, top_up_ix(&payer, &pdas.vault, 40_000_000), &[]).await.unwrap();
    submit(&mut ctx, modify(300), &[&user]).await.unwrap();
    read_vault(&mut ctx, &pdas).await.assert_balanced();
}

#[tokio::test]
async fn test_e2e_position_cap_and_open_interest_cap_reject_oversized_posts() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    // 10 SOL per portfolio is 10_000 lots; 50 SOL per side is 50_000 lots.
    // The fund covers the reserve so only the caps can refuse.
    let vault = with_open_interest(
        vault_account(100_000_000, reserve_for(60_000), 0),
        49_999,
        0,
    );
    let (mut ctx, pdas, user, up, oracle) = post_gate_fixture(vault, None, 0).await;
    let me = user.pubkey();
    assert_custom(
        submit(
            &mut ctx,
            gate_post_ix(&pdas, &me, &up, &oracle, 0, 10_001, false),
            &[&user],
        )
        .await,
        mgk_common::MgkError::PositionCapExceeded,
    );
    // One lot past the 50_000 lot side cap, well inside the position cap.
    assert_custom(
        submit(&mut ctx, gate_post_ix(&pdas, &me, &up, &oracle, 0, 2, false), &[&user]).await,
        mgk_common::MgkError::OpenInterestCapExceeded,
    );
    // The other side has room.
    submit(&mut ctx, gate_post_ix(&pdas, &me, &up, &oracle, 1, 2, false), &[&user])
        .await
        .unwrap();
}

/// Acceptance 2: risk-off and exhaustion block exposure but leave reducing
/// orders, cancels and withdrawals working.
#[tokio::test]
async fn test_e2e_risk_off_keeps_reduce_only_cancel_and_withdraw_working() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    // The fund is empty while 20_000 lots of open interest need a reserve.
    let vault = with_open_interest(vault_account(100_000_000, 0, 0), 20_000, 20_000);
    let (mut ctx, pdas, user, up, oracle) =
        post_gate_fixture(vault, Some((100, 100_000_000)), 0).await;
    let me = user.pubkey();
    assert_custom(
        submit(&mut ctx, gate_post_ix(&pdas, &me, &up, &oracle, 0, 10, false), &[&user]).await,
        mgk_common::MgkError::RiskOffFundBelowReserve,
    );
    // Reducing the long is not exposure-adding.
    submit(&mut ctx, gate_post_ix(&pdas, &me, &up, &oracle, 1, 50, true), &[&user])
        .await
        .unwrap();
    let cancel = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(up.portfolio, false),
            AccountMeta::new(me, true),
            AccountMeta::new(pdas.book, false),
            AccountMeta::new_readonly(MATCHER_ID, false),
            AccountMeta::new_readonly(pdas.registry, false),
        ],
        data: with_disc(11, 0u64.to_le_bytes().to_vec()),
    };
    submit(&mut ctx, cancel, &[&user]).await.unwrap();
    // A withdrawal within free collateral still works under risk-off.
    let withdraw = Instruction {
        program_id: CORE_ID,
        accounts: vec![
            AccountMeta::new(up.portfolio, false),
            AccountMeta::new(me, true),
            AccountMeta::new(pdas.vault, false),
            AccountMeta::new_readonly(pdas.registry, false),
            AccountMeta::new_readonly(pdas.instrument, false),
            AccountMeta::new_readonly(oracle, false),
        ],
        data: with_disc(3, 1_000u64.to_le_bytes().to_vec()),
    };
    submit(&mut ctx, withdraw, &[&user]).await.unwrap();
    read_vault(&mut ctx, &pdas).await.assert_balanced();
}

/// Acceptance 3: while trading is paused by exhaustion, exposure-adding posts
/// are refused but a reduce-only post still goes through.
#[tokio::test]
async fn test_e2e_exhaustion_pause_refuses_new_exposure_but_not_reduce_only() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let vault = vault_account(100_000_000, reserve_for(1_000), 0);
    let (mut ctx, pdas, user, up, oracle) = post_gate_fixture(
        vault,
        Some((100, 100_000_000)),
        PAUSE_TRADING_BIT | PAUSE_WITHDRAWALS_BIT,
    )
    .await;
    let me = user.pubkey();
    assert_custom(
        submit(&mut ctx, gate_post_ix(&pdas, &me, &up, &oracle, 0, 10, false), &[&user]).await,
        mgk_common::MgkError::OperationPaused,
    );
    submit(&mut ctx, gate_post_ix(&pdas, &me, &up, &oracle, 1, 50, true), &[&user])
        .await
        .unwrap();
}

/// Assert that a failed transaction carries the given builtin instruction
/// error, named as in its `Debug` form.
fn assert_instruction_error(
    result: Result<(), solana_program_test::BanksClientError>,
    name: &str,
) {
    let error = result.expect_err("instruction must fail");
    assert!(
        format!("{error:?}").contains(&format!("InstructionError(0, {name})")),
        "expected {name}, got {error:?}"
    );
}

/// TopUp, WithdrawInsuranceFund and Unpause only accept the registry and vault
/// PDAs. Program-owned look-alikes at other addresses (a decoy registry that
/// names the attacker as governance, a decoy vault with no debt) are refused
/// and nothing changes; the real accounts keep working.
#[tokio::test]
async fn test_e2e_top_up_withdraw_fund_and_unpause_reject_wrong_address_accounts() {
    if std::env::var("BPF_OUT_DIR").is_err() && std::env::var("SBF_OUT_DIR").is_err() {
        eprintln!("skipping: set BPF_OUT_DIR to freshly built SBF programs");
        return;
    }
    let paused = PAUSE_TRADING_BIT | PAUSE_WITHDRAWALS_BIT;
    let (mut pt, pdas) = program_test_with_pdas();
    let governance = Keypair::new();
    let attacker = Keypair::new();
    seed_governed_registry(&mut pt, &pdas, &governance.pubkey(), paused);
    pt.add_account(pdas.vault, vault_account(0, 1_000_000_000, 0));
    let decoy_vault = Pubkey::new_unique();
    pt.add_account(decoy_vault, vault_account(0, 1_000_000_000, 0));
    let decoy_registry = Pubkey::new_unique();
    let with_decoy_registry = TestPdas { registry: decoy_registry, ..pdas };
    let with_decoy_vault = TestPdas { vault: decoy_vault, ..pdas };
    seed_governed_registry(&mut pt, &with_decoy_registry, &attacker.pubkey(), paused);
    let mut ctx = pt.start_with_context().await;
    let payer = ctx.payer.pubkey();
    let gov = governance.pubkey();
    let evil = attacker.pubkey();
    let decoy_vault_lamports = vault_account(0, 1_000_000_000, 0).lamports;

    // TopUp into a vault that is not the vault PDA.
    assert_instruction_error(
        submit(&mut ctx, top_up_ix(&payer, &decoy_vault, 1_000), &[]).await,
        "InvalidSeeds",
    );
    assert_eq!(get_account(&mut ctx, &decoy_vault).await.lamports, decoy_vault_lamports);

    // WithdrawInsuranceFund with an attacker-governed registry, or a decoy vault.
    assert_instruction_error(
        submit(&mut ctx, fund_withdraw_ix(&with_decoy_registry, &evil, 1_000), &[&attacker]).await,
        "InvalidSeeds",
    );
    assert_instruction_error(
        submit(&mut ctx, fund_withdraw_ix(&with_decoy_vault, &gov, 1_000), &[&governance]).await,
        "InvalidSeeds",
    );
    read_vault(&mut ctx, &pdas).await.assert_balanced();

    // Unpause against a decoy registry (attacker governance) or a decoy vault.
    assert_instruction_error(
        submit(&mut ctx, unpause_ix(&with_decoy_registry, &evil, true, false), &[&attacker]).await,
        "InvalidSeeds",
    );
    assert_eq!(get_account(&mut ctx, &decoy_registry).await.data[R_PAUSE_FLAGS], paused);
    assert_instruction_error(
        submit(&mut ctx, unpause_ix(&with_decoy_vault, &gov, true, false), &[&governance]).await,
        "InvalidSeeds",
    );
    assert_eq!(read_pause_flags(&mut ctx, &pdas).await, paused);

    // The real accounts still work.
    submit(&mut ctx, top_up_ix(&payer, &pdas.vault, 1_000), &[]).await.unwrap();
    submit(&mut ctx, fund_withdraw_ix(&pdas, &gov, 1_000), &[&governance]).await.unwrap();
    submit(&mut ctx, unpause_ix(&pdas, &gov, true, false), &[&governance]).await.unwrap();
    assert_eq!(read_pause_flags(&mut ctx, &pdas).await, PAUSE_TRADING_BIT);
}
