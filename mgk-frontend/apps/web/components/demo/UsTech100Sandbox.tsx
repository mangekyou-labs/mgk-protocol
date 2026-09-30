'use client';

import { FormEvent, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

import {
  DEMO_DISCLOSURES,
  IFC_SOURCE_LINKS,
  createSandboxReceipt,
  getNextBatchState,
  validateSandboxOrder,
  type BatchState,
  type SandboxOrder,
  type SandboxOrderErrors,
} from '@/lib/demo/usTech100';

import styles from './UsTech100Sandbox.module.css';

const PREVIEW_ORDER: SandboxOrder = {
  eligible: true,
  role: 'taker',
  side: 'buy',
  limitPrice: '21482.50',
  quantity: '12',
};

const EMPTY_ORDER: SandboxOrder = {
  eligible: false,
  role: 'taker',
  side: 'buy',
  limitPrice: '',
  quantity: '',
};

const PRICE_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const QUANTITY_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
});

const STEPS: Array<{ state: BatchState; label: string }> = [
  { state: 'collecting', label: 'Collecting' },
  { state: 'clearing', label: 'Clearing' },
  { state: 'settled', label: 'Settled' },
];

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p className={styles.fieldError} id={id}>{message}</p> : null;
}

function Choice({
  name,
  value,
  checked,
  label,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className={styles.choice}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
      />
      <span>{label}</span>
    </label>
  );
}

function Lifecycle({ state }: { state: BatchState }) {
  return (
    <ol className={styles.lifecycle} aria-label="Batch lifecycle">
      {STEPS.map((step, index) => {
        const activeIndex = state === 'ready' ? -1 : STEPS.findIndex((item) => item.state === state);
        const current = step.state === state;
        const complete = index < activeIndex;
        return (
          <li className={styles.lifecycleItem} key={step.state}>
            <span className={styles.lifecycleMarker} data-complete={complete || current} aria-hidden="true">
              {complete ? '✓' : index + 1}
            </span>
            <span aria-current={current ? 'step' : undefined}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function UsTech100Sandbox({ previewSettled }: { previewSettled: boolean }) {
  const [order, setOrder] = useState<SandboxOrder>(previewSettled ? PREVIEW_ORDER : EMPTY_ORDER);
  const [errors, setErrors] = useState<SandboxOrderErrors>({});
  const [batchState, setBatchState] = useState<BatchState>(previewSettled ? 'settled' : 'ready');
  const firstInvalidRef = useRef<HTMLInputElement>(null);
  const receipt = useMemo(() => createSandboxReceipt(order), [order]);

  function updateOrder(patch: Partial<SandboxOrder>) {
    setOrder((current) => ({ ...current, ...patch }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateSandboxOrder(order);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      firstInvalidRef.current?.focus();
      return;
    }
    setBatchState('collecting');
  }

  function advanceBatch() {
    setBatchState((current) => getNextBatchState(current));
  }

  function reset() {
    setOrder(EMPTY_ORDER);
    setErrors({});
    setBatchState('ready');
  }

  const isOrderEntry = batchState === 'ready';
  const isSettled = batchState === 'settled';

  return (
    <main className={styles.sandbox}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="MGK home">MGK<span>↗</span></Link>
        <div className={styles.environment}><span aria-hidden="true" />Partner sandbox · local state</div>
        <p>Execution demonstrator · not a live market</p>
      </header>

      <section className={styles.intro} aria-labelledby="sandbox-title">
        <div>
          <p className={styles.eyebrow}>Licensed-member product workshop / 01</p>
          <h1 id="sandbox-title">US Tech 100 Sandbox</h1>
          <p className={styles.lede}>Trace one simulated order through MGK’s dual-flow batch auction—from declared intent to uniform-price receipt.</p>
        </div>
        <aside className={styles.disclosure} aria-label="Sandbox disclosure">
          <strong>Simulated partner sandbox</strong>
          <p>No wallet, backend, live market data, or onchain write. Every balance, price, order, and fill shown here is simulated.</p>
        </aside>
      </section>

      <section className={styles.workspace}>
        <div className={styles.orderPanel}>
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Order intent</p>
              <h2>{isOrderEntry ? 'Configure the simulation' : 'Batch in progress'}</h2>
            </div>
            <span className={styles.simulatedTag}>SIMULATED</span>
          </div>

          {isOrderEntry ? (
            <form className={styles.orderForm} onSubmit={handleSubmit} noValidate>
              <label className={styles.eligibility}>
                <input
                  ref={firstInvalidRef}
                  type="checkbox"
                  checked={order.eligible}
                  onChange={(event) => updateOrder({ eligible: event.target.checked })}
                  aria-invalid={errors.eligible ? 'true' : undefined}
                  aria-describedby={errors.eligible ? 'eligibility-error' : 'eligibility-hint'}
                />
                <span>
                  <strong>Licensed IFC partner workflow</strong>
                  <small id="eligibility-hint">I am reviewing infrastructure for an eligible institutional product—not placing a retail trade.</small>
                </span>
              </label>
              <FieldError id="eligibility-error" message={errors.eligible} />

              <div className={styles.twoColumn}>
                <fieldset>
                  <legend>Flow intent</legend>
                  <div className={styles.choiceRow}>
                    <Choice name="role" value="maker" label="Maker" checked={order.role === 'maker'} onChange={() => updateOrder({ role: 'maker' })} />
                    <Choice name="role" value="taker" label="Taker" checked={order.role === 'taker'} onChange={() => updateOrder({ role: 'taker' })} />
                  </div>
                  <FieldError id="role-error" message={errors.role} />
                </fieldset>
                <fieldset>
                  <legend>Side</legend>
                  <div className={styles.choiceRow}>
                    <Choice name="side" value="buy" label="Buy" checked={order.side === 'buy'} onChange={() => updateOrder({ side: 'buy' })} />
                    <Choice name="side" value="sell" label="Sell" checked={order.side === 'sell'} onChange={() => updateOrder({ side: 'sell' })} />
                  </div>
                  <FieldError id="side-error" message={errors.side} />
                </fieldset>
              </div>

              <div className={styles.twoColumn}>
                <label className={styles.field} htmlFor="limit-price">
                  <span>Limit price</span>
                  <span className={styles.inputShell}><b>USD</b><input aria-label="Limit price" id="limit-price" type="text" inputMode="decimal" autoComplete="off" value={order.limitPrice} onChange={(event) => updateOrder({ limitPrice: event.target.value })} aria-invalid={errors.limitPrice ? 'true' : undefined} aria-describedby={errors.limitPrice ? 'limit-error' : undefined} placeholder="21,482.50" /></span>
                  <FieldError id="limit-error" message={errors.limitPrice} />
                </label>
                <label className={styles.field} htmlFor="quantity">
                  <span>Quantity</span>
                  <span className={styles.inputShell}><b>UNITS</b><input aria-label="Quantity" id="quantity" type="text" inputMode="decimal" autoComplete="off" value={order.quantity} onChange={(event) => updateOrder({ quantity: event.target.value })} aria-invalid={errors.quantity ? 'true' : undefined} aria-describedby={errors.quantity ? 'quantity-error' : undefined} placeholder="12" /></span>
                  <FieldError id="quantity-error" message={errors.quantity} />
                </label>
              </div>

              <button className={styles.primaryButton} type="submit">Submit simulated order <span aria-hidden="true">→</span></button>
            </form>
          ) : (
            <div className={styles.progressPanel} aria-live="polite">
              <Lifecycle state={batchState} />
              <div className={styles.orderSummary}>
                <div><span>Intent</span><strong>{receipt.role} · {receipt.side}</strong></div>
                <div><span>Limit</span><strong>{PRICE_FORMATTER.format(receipt.limitPrice)}</strong></div>
                <div><span>Quantity</span><strong>{QUANTITY_FORMATTER.format(receipt.requestedQuantity)}</strong></div>
              </div>
              {batchState === 'collecting' ? <p>Order intent is committed to batch <code>{receipt.batchId}</code>. Arrival time does not determine allocation within the batch.</p> : null}
              {batchState === 'clearing' ? <p>Two auction legs clear independently at volume-maximizing uniform prices.</p> : null}
              {!isSettled ? (
                <button className={styles.primaryButton} type="button" onClick={advanceBatch}>{batchState === 'collecting' ? 'Advance to clearing' : 'Settle batch'} <span aria-hidden="true">→</span></button>
              ) : null}
            </div>
          )}
        </div>

        <div className={styles.evidencePanel}>
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>Execution evidence</p>
              <h2>{isSettled ? 'Deterministic receipt' : 'Receipt appears at settlement'}</h2>
            </div>
            <span className={styles.batchId}>{receipt.batchId}</span>
          </div>

          {isSettled ? (
            <article className={styles.receipt} aria-label="Simulated deterministic receipt">
              <div className={styles.receiptHero}>
                <div><span>Uniform price</span><strong>{PRICE_FORMATTER.format(receipt.uniformPrice)}</strong></div>
                <div><span>Filled quantity</span><strong>{QUANTITY_FORMATTER.format(receipt.filledQuantity)}</strong></div>
              </div>
              <dl className={styles.receiptGrid}>
                <div><dt>Auction leg</dt><dd>{receipt.auctionLeg}</dd></div>
                <div><dt>Allocation</dt><dd>{receipt.allocationRule}</dd></div>
                <div><dt>Receipt ID</dt><dd>{receipt.receiptId}</dd></div>
                <div><dt>Evidence root</dt><dd>{receipt.evidenceRoot}</dd></div>
                <div><dt>Matcher build</dt><dd>{receipt.matcherBuild}</dd></div>
                <div><dt>Execution status</dt><dd><span className={styles.statusDot} aria-hidden="true" />Settled · simulated</dd></div>
              </dl>
              <button className={styles.secondaryButton} type="button" onClick={reset}>Start another simulation</button>
            </article>
          ) : (
            <div className={styles.emptyEvidence}>
              <div className={styles.auctionDiagram} aria-label="Two independent auction legs">
                <div><span>MAKER BUY</span><b>×</b><span>TAKER SELL</span></div>
                <p>Bid auction</p>
                <div><span>MAKER SELL</span><b>×</b><span>TAKER BUY</span></div>
                <p>Ask auction</p>
              </div>
              <p>One leg, one uniform price. Better-priced orders fill first; quantity at the marginal price is allocated pro rata.</p>
            </div>
          )}
        </div>
      </section>

      <footer className={styles.footer}>
        <p><strong>Boundary:</strong> partner-owned eligibility, KYC/AML, approval, custody, settlement, market data, and index rights.</p>
        <p>{DEMO_DISCLOSURES[0]}</p>
        <nav className={styles.sourceLinks} aria-label="Research sources">
          <strong>Sources</strong>
          {IFC_SOURCE_LINKS.map((source) => (
            <a href={source.href} key={source.href}>{source.label}</a>
          ))}
        </nav>
      </footer>
    </main>
  );
}
