export type SandboxRole = 'maker' | 'taker';
export type SandboxSide = 'buy' | 'sell';
export type BatchState = 'ready' | 'collecting' | 'clearing' | 'settled';

export interface SandboxOrder {
  eligible: boolean;
  role: SandboxRole;
  side: SandboxSide;
  limitPrice: string;
  quantity: string;
}

export interface SandboxReceipt {
  receiptId: string;
  batchId: string;
  instrument: string;
  role: 'Maker' | 'Taker';
  side: 'Buy' | 'Sell';
  auctionLeg: string;
  limitPrice: number;
  uniformPrice: number;
  requestedQuantity: number;
  filledQuantity: number;
  allocationRule: string;
  evidenceRoot: string;
  matcherBuild: string;
  simulated: true;
}

export type SandboxOrderErrors = Partial<Record<keyof SandboxOrder, string>>;

export const DEMO_DISCLOSURES = [
  'All balances, prices, orders, fills, and evidence are simulated.',
  'This local demo makes no wallet request, no backend call, no live market-data request, and no onchain write.',
  'A licensed partner owns eligibility, KYC/AML, approvals, custody, settlement, market data, and index rights.',
] as const;

export const IFC_SOURCE_LINKS = [
  { label: 'Vietnam IFC debut', href: 'https://en.baochinhphu.vn/international-financial-center-makes-debut-in-hcmc-111260211112728619.htm' },
  { label: 'DFBA mechanism', href: 'https://jumpcrypto.com/resources/dual-flow-batch-auction' },
  { label: 'Nasdaq index licensing', href: 'https://www.nasdaq.com/products/global-indexes/licensing-and-etps' },
  { label: 'Nasdaq–CME license', href: 'https://ir.nasdaq.com/news-releases/news-release-details/cme-group-and-nasdaq-extend-exclusive-nasdaq-100-futures-license' },
  { label: 'Outward portfolio investment', href: 'https://vanban.chinhphu.vn/default.aspx?docid=182926&pageid=27160' },
  { label: 'SSC investor warning', href: 'https://ssc.gov.vn/webcenter/portal/ubck/pages_r/l/chitit?dDocName=APPSSCGOVVN162147174' },
  { label: 'IFC legislation', href: 'https://vifcdanang.vn/legislation.htm' },
  { label: 'Crypto-asset pilot', href: 'https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-quyet-so-5-2025-nq-cp-ve-trien-khai-thi-diem-thi-truong-tai-san-ma-hoa-tai-viet-nam-119250909184045221.htm' },
] as const;

export function validateSandboxOrder(order: SandboxOrder): SandboxOrderErrors {
  const errors: SandboxOrderErrors = {};
  if (!order.eligible) errors.eligible = 'Confirm partner eligibility to continue.';
  if (order.role !== 'maker' && order.role !== 'taker') errors.role = 'Choose maker or taker intent.';
  if (order.side !== 'buy' && order.side !== 'sell') errors.side = 'Choose buy or sell.';
  if (!Number.isFinite(Number(order.limitPrice)) || Number(order.limitPrice) <= 0) {
    errors.limitPrice = 'Enter a limit price greater than zero.';
  }
  if (!Number.isFinite(Number(order.quantity)) || Number(order.quantity) <= 0) {
    errors.quantity = 'Enter a quantity greater than zero.';
  }
  return errors;
}

export function getNextBatchState(state: BatchState): BatchState {
  if (state === 'ready') return 'collecting';
  if (state === 'collecting') return 'clearing';
  if (state === 'clearing') return 'settled';
  return 'settled';
}

export function createSandboxReceipt(order: SandboxOrder): SandboxReceipt {
  const requestedQuantity = Number(order.quantity);
  const isAskAuction =
    (order.role === 'taker' && order.side === 'buy') ||
    (order.role === 'maker' && order.side === 'sell');

  return {
    receiptId: 'MGK-US100-84A7C2',
    batchId: 'IFC-SBX-000184',
    instrument: 'US Tech 100 Sandbox',
    role: order.role === 'maker' ? 'Maker' : 'Taker',
    side: order.side === 'buy' ? 'Buy' : 'Sell',
    auctionLeg: isAskAuction
      ? 'Ask auction · maker sells × taker buys'
      : 'Bid auction · maker buys × taker sells',
    limitPrice: Number(order.limitPrice),
    uniformPrice: isAskAuction ? 21478.25 : 21475.75,
    requestedQuantity,
    filledQuantity: Math.min(requestedQuantity, isAskAuction ? 12 : 16),
    allocationRule: 'Price priority; pro-rata at the marginal price',
    evidenceRoot: '7a4f…c219',
    matcherBuild: 'mgk-dfba-demo@84a7c2',
    simulated: true,
  };
}
