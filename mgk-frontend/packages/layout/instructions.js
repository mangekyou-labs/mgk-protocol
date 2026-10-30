"use strict";
// Single-byte discriminators and packed LE bodies. Account layouts are NOT instruction layouts.
const fields = (text) =>
  text ? text.split(" ").map((pair) => pair.split(":")) : [];
const table = (rows) =>
  Object.fromEntries(
    rows.map(([name, disc, body, enabled = true]) => [
      name,
      { disc, fields: fields(body), enabled },
    ]),
  );
const instructions = {
  core: table([
    [
      "Initialize",
      0,
      "governance:pubkey instrumentCount:u16 volatilityMultiplier:u16 batchIdCounter:u64 baseDeposit:u64 nMin:u32 tMinSlots:u64 tMaxSlots:u64 tRevealSlots:u64 instrumentId:u16 tickSize:u64 lotSize:u64 imrBps:u16 mmrBps:u16 takerFeeBps:u16 makerFeeBps:i16 oracleAddr:pubkey registryBump:u8 instrumentBump:u8 vaultBump:u8?",
    ],
    ["InitPortfolio", 1, "user:pubkey bump:u8"],
    ["Deposit", 2, "amount:u64"],
    ["Withdraw", 3, "amount:u64"],
    [
      "CommitOrder",
      4,
      "orderType:u8 instrumentId:u16 reduceOnly:bool side:u8 price:i64 qty:u64 salt:u64 batchId:u64 commitmentBump:u8",
      false,
    ],
    [
      "RevealOrder",
      5,
      "orderType:u8 instrumentId:u16 reduceOnly:bool side:u8 price:i64 qty:u64 salt:u64 batchId:u64",
      false,
    ],
    ["CloseCommitting", 6, ""],
    [
      "ClearBatch",
      7,
      "numCommitments:u16 numInstruments:u16 numPortfolios:u16",
    ],
    [
      "SettleBatch",
      8,
      "numCommitments:u16 numPortfolios:u16 nextBatchBump:u8?",
    ],
    ["LiquidateUser", 9, "numInstruments:u16"],
    [
      "AddInstrument",
      10,
      "instrumentId:u16 tickSize:u64 lotSize:u64 imrBps:u16 mmrBps:u16 takerFeeBps:u16 makerFeeBps:i16 oracleAddr:pubkey bump:u8",
    ],
    ["CancelRestingOrder", 11, "orderId:u64"],
    ["ModifyRestingOrder", 12, "orderId:u64 newQty:u64"],
    ["CancelAllRestingOrders", 13, "numBooks:u16"],
    ["SetPauseFlags", 14, "flags:u8"],
    ["InitVault", 15, "bump:u8"],
    ["CreateBatch", 16, "bump:u8"],
    ["SetBatchCounter", 17, ""],
    ["CreatePortfolio", 18, "bump:u8"],
    ["InitPortfolioForUser", 19, "user:pubkey"],
    [
      "PostOrder",
      20,
      "side:u8 isMaker:bool price:i64 qty:u64 instrumentId:u16 reduceOnly:bool",
    ],
    [
      "SetBatchParams",
      21,
      "maxOrdersPerBatch:u8 marginalSizeCap:u8 tMinSlots:u64 tMaxSlots:u64 nMin:u32",
    ],
    ["SetInstrumentFees", 22, "takerFeeBps:u16 makerFeeBps:i16"],
    ["SetInstrumentOracle", 23, ""],
    [
      "SetFundingParams",
      24,
      "coefficientBps:i64 maxRateBps:i64 intervalSlots:u64",
    ],
    ["InitializeBook", 25, "instrumentId:u16"],
    ["TopUp", 26, "amount:u64"],
    ["WithdrawInsuranceFund", 27, "amount:u64"],
    ["Unpause", 28, "resumeWithdrawals:bool resumeTrading:bool"],
  ]),
  matcher: table([
    ["ComputeClearing", 0, "", false],
    ["CancelResting", 1, "user:pubkey orderId:u64"],
    ["ModifyResting", 2, "user:pubkey orderId:u64 newQty:u64"],
    ["ClearAndMatch", 3, "", false],
    ["CancelAll", 4, "user:pubkey"],
    ["DfbaClear", 5, "marginalSizeCap:u64 numOrders:u16 batchId:u64"],
    [
      "PlaceResting",
      6,
      "user:pubkey side:u8 isMaker:bool price:i64 qty:u64 instrumentId:u16 reduceOnly:bool",
    ],
    ["InitializeBook", 7, "instrumentId:u16 bump:u8"],
    ["ConsumeResults", 8, "batchId:u64"],
    ["CancelSettledOrders", 9, "orderIds:ids"],
  ]),
  oracle: table([
    ["Initialize", 0, "initialPrice:i64 bump:u8"],
    ["UpdatePrice", 1, "price:i64 confidence:i64"],
    ["SetAuthority", 2, "authority:pubkey"],
    ["Activate", 3, ""],
    ["Deactivate", 4, ""],
  ]),
};
const width = (type, value) =>
  type === "pubkey"
    ? 32
    : type === "bool"
      ? 1
      : type === "ids"
        ? 1 + value.length * 8
        : Number(type.slice(1)) / 8;
function encodeInstruction(program, name, params = {}) {
  const spec = instructions[program]?.[name];
  if (!spec) throw new Error("Unknown instruction");
  const values = spec.fields
    .filter(([key, type]) => !type.endsWith("?") || params[key] !== undefined)
    .map(([key, type]) => [
      key,
      type.replace("?", ""),
      params[key] ?? (type === "bool" ? false : undefined),
    ]);
  const data = new Uint8Array(
    1 + values.reduce((n, [, type, value]) => n + width(type, value), 0),
  );
  data[0] = spec.disc;
  const v = new DataView(data.buffer);
  let offset = 1;
  for (const [key, type, value] of values) {
    if (value === undefined)
      throw new Error(`Missing instruction field ${key}`);
    if (type === "pubkey") {
      if (value.length !== 32) throw new Error(`Invalid ${key}`);
      data.set(value, offset);
    } else if (type === "bool") {
      if (typeof value !== "boolean") throw new Error(`Invalid ${key}`);
      data[offset] = value ? 1 : 0;
    } else if (type === "ids") {
      if (value.length > 12) throw new Error("Too many order IDs");
      data[offset] = value.length;
      value.forEach((id, i) => v.setBigUint64(offset + 1 + i * 8, id, true));
    } else {
      const bits = Number(type.slice(1));
      const signed = type[0] === "i";
      const n = BigInt(value);
      const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
      const max = (1n << BigInt(bits - (signed ? 1 : 0))) - 1n;
      if (n < min || n > max) throw new Error(`Out of range ${key}`);
      v[`set${bits === 64 ? "Big" : ""}${signed ? "Int" : "Uint"}${bits}`](
        offset,
        bits === 64 ? n : Number(n),
        true,
      );
    }
    offset += width(type, value);
  }
  return data;
}
module.exports = { instructions, encodeInstruction };
