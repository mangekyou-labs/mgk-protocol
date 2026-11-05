'use client';

import { useRef, useState } from 'react';

import type * as sdk from '@mgk/sdk';
import { AccountActions } from '@/components/orderform/AccountActions';
import type { MarketExposure, OracleReading } from '@/lib/marketBar';
import { lifecycleLabel, type OrderLifecycle } from '@/lib/orderLifecycle';
import { abs, LOTS_PER_SOL } from '@/lib/protocol';
import { formatSol } from '@/lib/solAmount';
import {
  orderBlockReason,
  parseLots,
  parsePriceMicro,
  reservation,
  type TicketSide,
} from '@/lib/orderTicket';

type PortfolioState = sdk.state.PortfolioState;

export type OrderSide = TicketSide;

export interface OrderFormParams {
  side: OrderSide;
  /** Limit price, micro-USD. */
  price: bigint;
  /** Size in lots of 0.001 SOL. */
  qty: bigint;
  reduceOnly: boolean;
}

export interface OrderFormProps {
  oracle: OracleReading;
  /** null = pause flags unknown. */
  newExposurePaused: boolean | null;
  /** Withdrawable collateral in lamports; null = unknown. */
  withdrawableCollateral: bigint | null;
  /** Vault open interest and insurance fund; null = unknown. */
  market: MarketExposure | null;
  /** Signed position in lots; null = unknown. */
  positionLots: bigint | null;
  /**
   * Posts the order. Call `onSigned` once the wallet has signed and `onStage`
   * while waiting for a batch window or for wallet approval; resolve only when
   * the program accepted the order, reject otherwise.
   */
  onSubmit?: (
    params: OrderFormParams,
    onSigned: () => void,
    onStage?: (stage: SubmitStage) => void,
  ) => Promise<void>;
  /** Lifecycle of the last accepted order. */
  lifecycle?: OrderLifecycle | null;
  /** Price picked on the book; a new nonce re-applies the same price. */
  priceOverride?: { price: bigint; nonce: number } | null;
  portfolio: PortfolioState | null;
  portfolioLoading: boolean;
  className?: string;
}

export type SubmitStage = 'waiting' | 'approve';

type Phase = 'idle' | SubmitStage | 'confirming';

const PHASE_LABELS: Record<Exclude<Phase, 'idle'>, string> = {
  waiting: 'Waiting for next batch…',
  approve: 'Approve in wallet…',
  confirming: 'Confirming…',
};

function formatLots(lots: bigint): string {
  const whole = lots / LOTS_PER_SOL;
  const fraction = (lots % LOTS_PER_SOL).toString().padStart(3, '0');
  return `${whole}.${fraction}`;
}

function formatPriceInput(micro: bigint): string {
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${micro / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

function formatUsd(micro: bigint): string {
  const cents = (micro + 5_000n) / 10_000n;
  const whole = (cents / 100n).toLocaleString('en-US');
  return `$${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

const sideButton =
  'cta rounded px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const inputClass =
  'w-full rounded border border-border bg-surface-2 px-2 py-2 font-mono text-sm tabular-nums text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

export function OrderForm({
  oracle,
  newExposurePaused,
  withdrawableCollateral,
  market,
  positionLots,
  onSubmit,
  lifecycle = null,
  priceOverride = null,
  portfolio,
  portfolioLoading,
  className,
}: OrderFormProps) {
  const [side, setSide] = useState<OrderSide>('buy');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const pending = useRef(false);

  // A book click sends a new nonce; copy its price into the field once per click.
  const [appliedNonce, setAppliedNonce] = useState<number | null>(null);
  if (priceOverride && priceOverride.nonce !== appliedNonce) {
    setAppliedNonce(priceOverride.nonce);
    setPrice(formatPriceInput(priceOverride.price));
  }

  const lots = parseLots(size).lots;
  const priceMicro = parsePriceMicro(price);
  const reason = orderBlockReason({
    side,
    price,
    size,
    reduceOnly,
    oracle,
    newExposurePaused,
    withdrawableCollateral,
    positionLots,
    market,
  });
  const costs =
    lots != null && priceMicro != null && oracle.price != null
      ? reservation({ lots, price: priceMicro, oraclePrice: oracle.price, reduceOnly })
      : null;
  const orderValue = lots != null && priceMicro != null ? (lots * priceMicro) / LOTS_PER_SOL : null;

  const busy = phase !== 'idle';
  function idleLabel(): string {
    if (reason) return reason;
    if (!onSubmit) return 'Connect a wallet to trade.';
    return `${side === 'buy' ? 'Buy' : 'Sell'} ${lots != null ? formatLots(lots) : ''} SOL`;
  }
  const label = phase === 'idle' ? idleLabel() : PHASE_LABELS[phase];
  const disabled = busy || reason != null || !onSubmit;

  async function submit() {
    if (disabled || pending.current || !onSubmit || lots == null || priceMicro == null) return;
    pending.current = true;
    setPhase('approve');
    try {
      await onSubmit({ side, price: priceMicro, qty: lots, reduceOnly }, () => setPhase('confirming'), setPhase);
    } catch {
      // The page reports the failure; the form only returns to idle.
    } finally {
      pending.current = false;
      setPhase('idle');
    }
  }

  function prepareClose() {
    if (positionLots == null || positionLots === 0n) return;
    setSide(positionLots > 0n ? 'sell' : 'buy');
    setReduceOnly(true);
    setSize(formatLots(abs(positionLots)));
  }

  const openPosition = positionLots != null && positionLots !== 0n ? positionLots : null;

  return (
    <section
      data-testid="order-form"
      aria-label="Order form"
      className={`flex flex-col gap-3 p-3 text-sm ${className ?? ''}`}
    >
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-pressed={side === 'buy'}
          onClick={() => setSide('buy')}
          className={`${sideButton} ${side === 'buy' ? 'bg-bull text-bg' : 'bg-surface-2 text-text-muted'}`}
        >
          Buy / Long
        </button>
        <button
          type="button"
          aria-pressed={side === 'sell'}
          onClick={() => setSide('sell')}
          className={`${sideButton} ${side === 'sell' ? 'bg-bear text-text' : 'bg-surface-2 text-text-muted'}`}
        >
          Sell / Short
        </button>
      </div>

      <p className="text-xs text-text-muted">Limit · good-till-cancelled</p>

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        <span>Price (USD)</span>
        <input
          aria-label="Price (USD)"
          inputMode="decimal"
          autoComplete="off"
          value={price}
          onChange={e => setPrice(e.target.value)}
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        <span>
          Size (SOL) <span className="text-text-muted">· lots of 0.001</span>
        </span>
        <input
          aria-label="Size (SOL)"
          inputMode="decimal"
          autoComplete="off"
          value={size}
          onChange={e => setSize(e.target.value)}
          className={inputClass}
        />
      </label>

      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" checked={reduceOnly} onChange={e => setReduceOnly(e.target.checked)} />
          Reduce only
        </label>
        {openPosition != null && (
          <button
            type="button"
            onClick={prepareClose}
            className="cta rounded border border-border px-2 py-1 text-xs text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {`Close ${openPosition > 0n ? 'long' : 'short'} ${formatLots(abs(openPosition))} SOL`}
          </button>
        )}
      </div>

      <dl data-testid="order-form-summary" className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-xs">
        <dt className="text-text-muted">Order value</dt>
        <dd className="text-right font-mono tabular-nums text-text">{orderValue != null ? formatUsd(orderValue) : '--'}</dd>
        <dt className="text-text-muted">Initial margin</dt>
        <dd className="text-right font-mono tabular-nums text-text">{costs ? `${formatSol(costs.initialMargin)} SOL` : '--'}</dd>
        <dt className="text-text-muted">Withdrawable collateral</dt>
        <dd className="text-right font-mono tabular-nums text-text">{withdrawableCollateral != null ? `${formatSol(withdrawableCollateral)} SOL` : '--'}</dd>
        <dt className="text-text-muted">Fee</dt>
        <dd className="text-right font-mono tabular-nums text-text">{`≤ 5 bps · ${costs ? `${formatSol(costs.fee)} SOL` : '--'}`}</dd>
      </dl>

      <button
        type="button"
        data-testid="order-form-submit"
        disabled={disabled}
        aria-busy={busy}
        onClick={submit}
        className={`cta rounded px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed ${
          disabled ? 'bg-surface-2 text-text-muted' : side === 'buy' ? 'bg-bull text-bg' : 'bg-bear text-text'
        }`}
      >
        {label}
      </button>

      {/* Reserved height: the label changes every batch and must not shift the panel. */}
      <p data-testid="order-lifecycle" role="status" className="min-h-8 text-xs leading-4 text-text">
        {lifecycle ? lifecycleLabel(lifecycle) : null}
      </p>

      <AccountActions
        portfolio={portfolio}
        portfolioLoading={portfolioLoading}
      />
    </section>
  );
}
