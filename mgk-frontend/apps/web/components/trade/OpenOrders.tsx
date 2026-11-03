'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Transaction, TransactionInstruction, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { useSafeTransaction } from '@/lib/hooks/useSafeTransaction';
import { config } from '@/lib/config';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { Pill } from '@/components/common/Pill';

type RestingOrder = sdk.state.RestingOrder;

interface OrderRowProps {
  order: RestingOrder;
  busy: boolean;
  onCancel: (orderId: bigint) => void;
}

function formatSide(side: number): { label: string; tone: 'bull' | 'bear' } {
  return side === sdk.Side.Buy ? { label: 'Long', tone: 'bull' } : { label: 'Short', tone: 'bear' };
}

export interface OpenOrdersProps {
  instrumentId: number;
  className?: string;
  onCountChange?: (count: number) => void;
}

const CU_LIMIT = 200_000;

/** CancelResting takes [portfolio, user, book, matcher, registry]. */
function buildCancelIx(
  ixData: Uint8Array,
  publicKey: PublicKey,
  instrumentId: number,
): TransactionInstruction {
  const [portfolioPda] = sdk.derivePortfolioPda(publicKey, config.coreProgramId, config.marketContext);
  const bookPda =
    config.bookAddress ?? sdk.deriveBookPda(instrumentId, config.matcherProgramId, config.marketContext)[0];

  return new TransactionInstruction({
    keys: [
      { pubkey: portfolioPda, isSigner: false, isWritable: true },
      { pubkey: publicKey, isSigner: true, isWritable: true },
      { pubkey: bookPda, isSigner: false, isWritable: true },
      { pubkey: config.matcherProgramId, isSigner: false, isWritable: false },
      { pubkey: config.registryAddress ?? sdk.deriveRegistryPda(config.coreProgramId, config.marketContext)[0], isSigner: false, isWritable: false },
    ],
    programId: config.coreProgramId,
    data: Buffer.from(config.marketSeed ? sdk.wrapInstruction('core',ixData,config.marketSeed) : ixData),
  });
}

export function OpenOrders({ instrumentId, className, onCountChange }: OpenOrdersProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const safeSend = useSafeTransaction();
  const [orders, setOrders] = useState<RestingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<bigint | null>(null);

  const fetchOrders = useCallback(async () => {
    if (!publicKey) {
      setOrders([]);
      onCountChange?.(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const bookPda =
        config.bookAddress ?? sdk.deriveBookPda(instrumentId, config.matcherProgramId, config.marketContext)[0];
      const accounts = await connection.getMultipleAccountsInfo([bookPda]);
      const acc = accounts[0];
      if (!acc) {
        setOrders([]);
        onCountChange?.(0);
        setLoading(false);
        return;
      }
      const allOrders = sdk.state.decodeRestingOrders(new Uint8Array(acc.data));
      const mine = allOrders.filter(
        (o) => o.user.toBase58() === publicKey.toBase58(),
      );
      setOrders(mine);
      onCountChange?.(mine.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [publicKey, connection, instrumentId, onCountChange]);

  useEffect(() => {
    const t = setTimeout(() => { void fetchOrders(); }, 0);
    const interval = setInterval(() => { void fetchOrders(); }, 5000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [fetchOrders]);

  const handleCancel = useCallback(
    async (orderId: bigint) => {
      if (!publicKey || !sendTransaction) return;
      setBusyOrderId(orderId);
      try {
        const ixData = sdk.programs.encodeCancelRestingOrder(orderId);
        const ix = buildCancelIx(ixData, publicKey, instrumentId);
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
          ix,
        );
        const sig = await safeSend(tx);
        await sdk.confirmSignature(connection, sig);
        await fetchOrders();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyOrderId(null);
      }
    },
    [publicKey, sendTransaction, safeSend, connection, fetchOrders, instrumentId],
  );

  const isEmpty = orders.length === 0 && !loading;

  if (isEmpty && !error) {
    return (
      <div
        data-testid="open-orders-empty"
        className={`text-text-faint px-4 py-8 text-center font-mono text-xs ${className ?? ''}`}
      >
        You have no open orders.
      </div>
    );
  }

  return (
    <div
      data-testid="open-orders"
      className={`flex flex-col ${className ?? ''}`}
    >
      {error && (
        <div
          data-testid="open-orders-error"
          className="text-warn px-3 py-2 text-xs font-mono"
        >
          {error}
        </div>
      )}
      <div className="flex flex-col font-mono text-xs">
        {orders.map((order) => (
          <OrderRow
            key={order.orderId.toString()}
            order={order}
            busy={busyOrderId === order.orderId}
            onCancel={handleCancel}
          />
        ))}
      </div>
    </div>
  );
}

function OrderRow({ order, busy, onCancel }: OrderRowProps) {
  const { label, tone } = formatSide(order.side);
  const remaining = order.qty - order.filledQty;

  return (
    <div
      data-testid="open-order-row"
      data-order-id={order.orderId.toString()}
      className="fade-in flex items-center gap-2 px-2 py-1 border-b border-border hover:bg-surface-2"
    >
      <Pill tone={tone}>{label}</Pill>
      <span data-testid="open-order-price" className="text-text min-w-[60px] text-right">
        <NumberDisplay value={order.price} kind="scaled-usd" />
      </span>
      <span data-testid="open-order-qty" className="text-text min-w-[60px] text-right">
        <NumberDisplay value={remaining} kind="lots" />
      </span>
      <span className="flex-1" />
      <button
        data-testid="open-order-cancel"
        onClick={() => onCancel(order.orderId)}
        disabled={busy}
        className="text-bear text-[10px] uppercase tracking-wider hover:underline disabled:opacity-40"
      >
        Cancel
      </button>
    </div>
  );
}
