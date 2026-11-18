'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import * as sdk from '@mgk/sdk';

import { PriceChart } from '@/components/chart/PriceChart';
import { notifyTxConfirmed, notifyTxFailed } from '@/components/common/TxToast';
import { PageFrame } from '@/components/layout/PageFrame';
import { useAutoConnect } from '@/components/wallet/useAutoConnect';
import { indexerState, useProtocolStatus } from '@/lib/hooks/useProtocolStatus';
import { useLayoutMode } from '@/lib/hooks/useLayoutMode';
import { SystemStatus } from '@/components/trade/SystemStatus';
import { DemoNotice } from '@/components/layout/DemoNotice';
import { StatusBar } from '@/components/trade/StatusBar';
import { BottomPanel } from '@/components/trade/BottomPanel';
import { BottomTabs } from '@/components/trade/BottomTabs';
import { OrderDrawer } from '@/components/trade/OrderDrawer';
import { PhonePanels } from '@/components/trade/PhonePanels';
import { TradeHistory } from '@/components/trade/history/TradeHistory';
import { MarketHeader } from '@/components/trade/MarketHeader';
import { BOOK_LEVELS_PER_SIDE, OrderBook } from '@/components/trade/OrderBook';
import { ReadinessChecklist } from '@/components/trade/ReadinessChecklist';
import { OrderForm, type OrderFormParams, type SidePreset, type SubmitStage } from '@/components/trade/OrderForm';
import { useBatchStatus } from '@/lib/hooks/useBatchStatus';
import { useMarketBar } from '@/lib/hooks/useMarketBar';
import { decodeProgramError, usePostOrder } from '@/lib/hooks/useOrderSubmission';
import { useOrderFormWalletGuard } from '@/lib/hooks/useOrderFormWalletGuard';
import { bookStatus } from '@/lib/marketBar';
import {
  acceptedOrderOnBook,
  fillBatchIdsSince,
  orderLifecycle,
  type AcceptedOrderRef,
} from '@/lib/orderLifecycle';
import { TRADE_POLL_INTERVAL_MS } from '@/lib/protocol';
import { useBookStore, useBookTopN } from '@/lib/stores/useBookStore';
import { useMyFills } from '@/lib/stores/useMyFillsStore';
import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';
import { usePortfolioPolling } from '@/lib/stores/usePortfolioStore';

const INSTRUMENT_ID = 0; // SOL-PERP only in v1
const BOOK_INTERVAL_MS = 5000;
const FILLS_INTERVAL_MS = 5000;

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
  const systemStatus = useProtocolStatus();
  const market = useMarketBar(TRADE_POLL_INTERVAL_MS);
  const { bids, asks, data: bookData, error: bookError } = useBookTopN(
    INSTRUMENT_ID,
    BOOK_LEVELS_PER_SIDE,
    BOOK_INTERVAL_MS,
  );
  const bookOrders = useBookStore((s) => s.orders);
  const bookFetchedAt = useBookStore((s) => s.lastFetchedAt);
  const { data: portfolio, loading: portfolioLoading, error: portfolioError } =
    usePortfolioPolling(TRADE_POLL_INTERVAL_MS);
  const myFills = useMyFills(INSTRUMENT_ID, FILLS_INTERVAL_MS);
  const { post } = usePostOrder();
  const nowMs = useNowMs();
  const layout = useLayoutMode();
  const [tabletView, setTabletView] = useState<'chart' | 'book'>('chart');

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

  const [accepted, setAccepted] = useState<AcceptedOrderRef | null>(null);
  const [priceOverride, setPriceOverride] = useState<{ price: bigint; nonce: number } | null>(null);

  // The last order's lifecycle belongs to the wallet that placed it.
  const acceptedOrder = accepted && publicKey && accepted.user.equals(publicKey) ? accepted : null;
  const acceptedBatchStatus = useBatchStatus(acceptedOrder?.batchId ?? null);

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
      bids: mine.filter((o) => o.side === sdk.Side.Buy).map((o) => o.price),
      asks: mine.filter((o) => o.side === sdk.Side.Sell).map((o) => o.price),
    };
  }, [bookOrders, publicKey]);

  const handleSelectPrice = useCallback((price: bigint) => {
    setPriceOverride((prev) => ({ price, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const position = portfolio?.positions.find((p) => p.instrumentId === INSTRUMENT_ID);

  const handleSubmit = useCallback(
    async (params: OrderFormParams, onSigned: () => void, onStage?: (stage: SubmitStage) => void) => {
      try {
        const result = await post(
          { instrumentId: INSTRUMENT_ID, ...params },
          { onSigned, onWaiting: () => onStage?.('waiting'), onReady: () => onStage?.('approve') },
        );
        if (publicKey) {
          setAccepted({
            user: publicKey,
            batchId: result.batchId,
            side: params.side,
            price: params.price,
            qty: params.qty,
          });
        }
        notifyTxConfirmed('Order placed', result.sig);
      } catch (err) {
        notifyTxFailed('Order not placed', decodeProgramError(err).message);
        throw err;
      }
    },
    [post, publicKey],
  );

  const lifecycle =
    acceptedOrder == null
      ? null
      : orderLifecycle({
          acceptedBatchId: acceptedOrder.batchId,
          acceptedBatchStatus,
          currentBatch: market.currentBatch,
          order: acceptedOrderOnBook(
            bookOrders.filter((o) => o.instrumentId === INSTRUMENT_ID),
            acceptedOrder,
            book.status,
          ),
          fillBatchIds: fillBatchIdsSince(
            myFills.fills,
            acceptedOrder.batchId,
            myFills,
            nowMs,
            2 * FILLS_INTERVAL_MS,
          ),
        });

  const chartPanel = (
    <PriceChart instrumentId={INSTRUMENT_ID} className="min-h-0 flex-1" />
  );
  const orderBook = (
    <OrderBook
      status={book.status}
      ageSeconds={book.ageSeconds}
      bids={bids}
      asks={asks}
      lastClear={market.lastClear}
      ownPrices={ownPrices}
      onSelectPrice={handleSelectPrice}
      className="min-h-0 flex-1"
    />
  );
  const renderOrderForm = (sideOverride: SidePreset | null = null) => (
    <ReadinessChecklist
      portfolio={portfolio}
      loading={portfolioLoading}
      error={portfolioError}
    >
      <OrderForm
        oracle={market.oracle}
        newExposurePaused={market.newExposurePaused}
        withdrawableCollateral={portfolio?.freeCollateral ?? null}
        market={market.market}
        positionLots={portfolio ? (position?.qty ?? 0n) : null}
        onSubmit={connected ? handleSubmit : undefined}
        lifecycle={lifecycle}
        priceOverride={priceOverride}
        sideOverride={sideOverride}
        portfolio={portfolio}
        portfolioLoading={portfolioLoading}
        className="flex-1"
      />
    </ReadinessChecklist>
  );
  const bottomTabsProps = {
    status: systemStatus,
    mark: market.lastClear,
    oracle: market.oracle,
  };

  return (
    <PageFrame>
      <MarketHeader
        oracle={market.oracle}
        mark={market.lastClear}
        collectingBatchId={market.collectingBatchId}
      />
      {layout === null ? (
        // Until the viewport is known; see useLayoutMode.
        <div className="min-h-0 flex-1" />
      ) : layout === 'phone' ? (
        <>
          <div
            data-testid="trade-body"
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <div
              data-testid="chart-section"
              className="flex h-[50dvh] shrink-0 flex-col border-b border-border"
            >
              {chartPanel}
            </div>
            <PhonePanels
              book={
                <div data-testid="orderbook-section" className="flex flex-col">
                  {orderBook}
                </div>
              }
              trades={
                <div data-testid="phone-trades" className="text-xs text-text-muted">
                  <TradeHistory
                    instrumentId={INSTRUMENT_ID}
                    indexerState={indexerState(systemStatus)}
                  />
                </div>
              }
              positions={<BottomTabs {...bottomTabsProps} />}
            />
          </div>
          <OrderDrawer>
            {(preset) => (
              <div data-testid="orderform-section" className="flex flex-col">
                {renderOrderForm(preset)}
              </div>
            )}
          </OrderDrawer>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div data-testid="trade-body" className="flex min-h-0 flex-1">
            {layout === 'tablet' ? (
              <div className="flex min-w-0 flex-1 flex-col border-r border-border">
                <div
                  role="group"
                  aria-label="Chart or book"
                  className="flex shrink-0 gap-1 border-b border-border bg-surface-1 p-1"
                >
                  {(['chart', 'book'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      aria-pressed={tabletView === view}
                      onClick={() => setTabletView(view)}
                      className={`rounded px-3 py-1 text-xs ${tabletView === view ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text'}`}
                    >
                      {view === 'chart' ? 'Chart' : 'Book'}
                    </button>
                  ))}
                </div>
                {/* Both stay mounted so switching never reloads the chart. */}
                <div
                  data-testid="chart-section"
                  hidden={tabletView !== 'chart'}
                  className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex"
                >
                  {chartPanel}
                </div>
                <div
                  data-testid="orderbook-section"
                  hidden={tabletView !== 'book'}
                  className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex"
                >
                  {orderBook}
                </div>
              </div>
            ) : (
              <>
                <div
                  data-testid="chart-section"
                  className="flex min-w-0 flex-1 flex-col border-r border-border"
                >
                  {chartPanel}
                </div>
                <div
                  data-testid="orderbook-section"
                  className="flex w-[280px] shrink-0 flex-col border-r border-border"
                >
                  {orderBook}
                </div>
              </>
            )}
            <div
              data-testid="orderform-section"
              className="flex w-[320px] shrink-0 flex-col overflow-y-auto p-2"
            >
              {renderOrderForm()}
            </div>
          </div>
          <BottomPanel {...bottomTabsProps} />
        </div>
      )}
      <StatusBar status={systemStatus}>
        <SystemStatus status={systemStatus} />
        <DemoNotice />
      </StatusBar>
    </PageFrame>
  );
}
