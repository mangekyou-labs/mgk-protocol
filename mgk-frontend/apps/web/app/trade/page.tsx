'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

import { PriceChart } from '@/components/chart/PriceChart';
import { TxToast } from '@/components/common/TxToast';
import { PageFrame } from '@/components/layout/PageFrame';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { BottomTabs } from '@/components/trade/BottomTabs';
import { MarketHeader } from '@/components/trade/MarketHeader';
import { BOOK_LEVELS_PER_SIDE, OrderBook } from '@/components/trade/OrderBook';
import { ReadinessChecklist } from '@/components/trade/ReadinessChecklist';
import { OrderForm, type OrderFormParams } from '@/components/trade/OrderForm';
import { useMarketBar } from '@/lib/hooks/useMarketBar';
import { decodeProgramError, usePostOrder } from '@/lib/hooks/useOrderSubmission';
import { useOrderFormWalletGuard } from '@/lib/hooks/useOrderFormWalletGuard';
import { bookStatus } from '@/lib/marketBar';
import { orderLifecycle } from '@/lib/orderLifecycle';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useBookStore, useBookTopN } from '@/lib/stores/useBookStore';
import { useMyFills } from '@/lib/stores/useMyFillsStore';
import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';
import { usePortfolioPolling } from '@/lib/stores/usePortfolioStore';

const INSTRUMENT_ID = 0; // SOL-PERP only in v1
const BOOK_INTERVAL_MS = 5000;

/** Re-renders once a second so the book's lag stays current between reads. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);
  return now;
}

export default function TradePage() {
  const { connected } = useAutoConnect();
  const { publicKey } = useWallet();
  const market = useMarketBar(3000);
  const { bids, asks, data: bookData, error: bookError } = useBookTopN(
    INSTRUMENT_ID,
    BOOK_LEVELS_PER_SIDE,
    BOOK_INTERVAL_MS,
  );
  const bookOrders = useBookStore((s) => s.orders);
  const bookFetchedAt = useBookStore((s) => s.lastFetchedAt);
  const { data: batch, currentBatchId } = useBatchPolling(3000);
  const { data: portfolio, loading: portfolioLoading, error: portfolioError } = usePortfolioPolling(3000);
  const { fills } = useMyFills(INSTRUMENT_ID);
  const { post } = usePostOrder();
  const nowMs = useNowMs();

  // Clear stale in-flight state when the wallet disconnects or switches.
  useOrderFormWalletGuard();

  // Dev/E2E affordance: `?set=failed` etc. jumps order form status on mount.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get('set');
    if (target === 'failed' || target === 'submitting' || target === 'idle') {
      useOrderFormStore.setState({ status: target });
    }
  }, []);

  const [toast, setToast] = useState<{ sig: string; error: string | null } | null>(null);
  const [accepted, setAccepted] = useState<{ wallet: string | null; batchId: bigint } | null>(null);
  const [priceOverride, setPriceOverride] = useState<{ price: bigint; nonce: number } | null>(null);

  // The last order's lifecycle belongs to the wallet that placed it.
  const walletKey = publicKey?.toBase58() ?? null;
  const acceptedBatchId = accepted?.wallet === walletKey ? accepted.batchId : null;

  const book = bookStatus({
    hasData: bookData != null,
    error: bookError,
    lastFetchedAt: bookFetchedAt,
    nowMs,
    intervalMs: BOOK_INTERVAL_MS,
  });

  const ownPrices = useMemo(() => {
    if (!publicKey) return undefined;
    const mine = bookOrders.filter(
      (o) => o.instrumentId === INSTRUMENT_ID && o.user.equals(publicKey),
    );
    return {
      bids: mine.filter((o) => Number(o.side) === 0).map((o) => o.price),
      asks: mine.filter((o) => Number(o.side) === 1).map((o) => o.price),
    };
  }, [bookOrders, publicKey]);

  const handleSelectPrice = useCallback((price: bigint) => {
    setPriceOverride((prev) => ({ price, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const position = portfolio?.positions.find((p) => p.instrumentId === INSTRUMENT_ID);

  const handleSubmit = useCallback(
    async (params: OrderFormParams, onSigned: () => void) => {
      try {
        const result = await post({ instrumentId: INSTRUMENT_ID, ...params }, { onSigned });
        setAccepted({ wallet: walletKey, batchId: result.batchId });
        setToast({ sig: result.sig, error: null });
      } catch (err) {
        setToast({ sig: '', error: `Order not placed: ${decodeProgramError(err).message}` });
        throw err;
      }
    },
    [post, walletKey],
  );

  const lifecycle =
    acceptedBatchId == null
      ? null
      : orderLifecycle({
          acceptedBatchId,
          currentBatchId,
          currentStatus: batch?.status ?? null,
          filled: fills.some((f) => BigInt(f.batch_id) === acceptedBatchId),
        });

  const handleAccountSuccess = useCallback((sig: string) => {
    setToast({ sig, error: null });
  }, []);

  const handleAccountError = useCallback((error: string) => {
    setToast({ sig: '', error });
  }, []);

  return (
    <PageFrame>
      <MarketHeader
        oracle={market.oracle}
        mark={market.lastClear}
        collectingBatchId={market.collectingBatchId}
      />
      <div data-testid="trade-body" className="flex flex-1 min-h-0">
        <div
          data-testid="chart-section"
          className="flex-[5] min-w-0 flex flex-col border-r border-border"
        >
          <PriceChart instrumentId={INSTRUMENT_ID} className="flex-1 min-h-0" />
        </div>

        <div
          data-testid="orderbook-section"
          className="flex-[2] min-w-0 flex flex-col border-r border-border"
        >
          <OrderBook
            status={book.status}
            ageSeconds={book.ageSeconds}
            bids={bids}
            asks={asks}
            lastClear={market.lastClear}
            ownPrices={ownPrices}
            onSelectPrice={handleSelectPrice}
            className="flex-1 min-h-0"
          />
        </div>

        <div data-testid="orderform-section" className="flex-[2] min-w-0 flex flex-col p-2">
          <ReadinessChecklist
            portfolio={portfolio}
            loading={portfolioLoading}
            error={portfolioError}
            onTxSuccess={handleAccountSuccess}
            onTxError={handleAccountError}
          >
            <OrderForm
              oracle={market.oracle}
              newExposurePaused={market.newExposurePaused}
              unsettledBatchId={market.batchUnsettled ? currentBatchId : null}
              freeCollateral={portfolio?.freeCollateral ?? null}
              positionLots={portfolio ? (position?.qty ?? 0n) : null}
              onSubmit={connected ? handleSubmit : undefined}
              lifecycle={lifecycle}
              priceOverride={priceOverride}
              portfolio={portfolio}
              portfolioLoading={portfolioLoading}
              onTxSuccess={handleAccountSuccess}
              onTxError={handleAccountError}
              className="flex-1"
            />
          </ReadinessChecklist>
        </div>
      </div>
      <BottomTabs />
      {toast && (
        <TxToast
          signature={toast.sig}
          error={toast.error}
          onDismiss={() => setToast(null)}
        />
      )}
    </PageFrame>
  );
}
