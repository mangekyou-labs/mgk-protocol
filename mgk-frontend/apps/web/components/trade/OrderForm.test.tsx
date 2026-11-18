vi.mock('@/lib/hooks/useReadiness', () => ({ useReadiness: () => ({ walletLamports: 1000000000n, signingBlockedReason: null, error: null, refresh: vi.fn(), getDevnetSol: vi.fn() }) }));
vi.mock('@/lib/hooks/useAccountActions', () => ({ useAccountActions: () => ({ deposit: vi.fn(), withdraw: vi.fn() }) }));
vi.mock('@/components/wallet/useAutoConnect', () => ({
  useAutoConnect: () => ({ connected: true }),
}));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OrderForm, type OrderFormProps } from './OrderForm';

const SOL = 1_000_000_000n;

function setup(over: Partial<OrderFormProps> = {}) {
  const onSubmit = over.onSubmit ?? vi.fn(async () => {});
  const props: OrderFormProps = {
    oracle: { state: 'valid', price: 150_000_000n, ageSeconds: 2 },
    newExposurePaused: false,
    withdrawableCollateral: 10n * SOL,
    market: { openInterestLong: 0n, openInterestShort: 0n, insuranceFund: 100n * SOL },
    positionLots: 0n,
    portfolio: null,
    portfolioLoading: false,
    ...over,
    onSubmit,
  };
  const utils = render(<OrderForm {...props} />);
  return { ...utils, onSubmit, props };
}

const price = () => screen.getByLabelText('Price (USD)');
const size = () => screen.getByLabelText(/Size \(SOL\)/);
const submit = () => screen.getByTestId('order-form-submit');

function fill(p: string, s: string) {
  fireEvent.change(price(), { target: { value: p } });
  fireEvent.change(size(), { target: { value: s } });
}

describe('<OrderForm />', () => {
  it('offers only Buy/Sell limit good-till-cancelled orders', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Buy / Long' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sell / Short' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('order-form')).toHaveTextContent('Limit · good-till-cancelled');
    const form = screen.getByTestId('order-form');
    const controls = [...form.querySelectorAll('button, input, [role="tab"], [role="slider"]')]
      .map(el => el.getAttribute('aria-label') ?? el.textContent ?? '')
      .join(' | ');
    expect(controls).not.toMatch(/market|IOC|TP\/SL|take profit|stop loss|maker|cross|isolated|commit|reveal/i);
    expect(form.querySelector('input[type="range"]')).toBeNull();
  });

  it('sizes in 0.001-SOL lots and offers reduce-only', () => {
    setup();
    expect(screen.getByTestId('order-form')).toHaveTextContent('lots of 0.001');
    expect(screen.getByLabelText('Reduce only')).not.toBeChecked();
  });

  it('submits the order in lots and micro-USD', async () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Sell / Short' }));
    fill('150.25', '1.25');
    await act(async () => { fireEvent.click(submit()); });
    expect(onSubmit).toHaveBeenCalledWith(
      { side: 'sell', price: 150_250_000n, qty: 1_250n, reduceOnly: false },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('labels the button with the order it will place', () => {
    setup();
    fill('150', '1.25');
    expect(submit()).toHaveTextContent('Buy 1.250 SOL');
    expect(submit()).toBeEnabled();
  });

  it('shows order value, initial margin, withdrawable collateral and fee', () => {
    setup({ withdrawableCollateral: 3n * SOL });
    fill('150', '1');
    const summary = screen.getByTestId('order-form-summary');
    expect(summary).toHaveTextContent('Order value$150.00');
    expect(summary).toHaveTextContent('Initial margin0.2 SOL');
    expect(summary).toHaveTextContent('Withdrawable collateral3 SOL');
    expect(summary).not.toHaveTextContent('Available');
    expect(summary).toHaveTextContent('Fee≤ 5 bps · 0.0005 SOL');
  });

  it('renders unknown summary values as "--", never 0', () => {
    setup({ withdrawableCollateral: null });
    const summary = screen.getByTestId('order-form-summary');
    expect(summary).toHaveTextContent('Order value--');
    expect(summary).toHaveTextContent('Initial margin--');
    expect(summary).toHaveTextContent('Withdrawable collateral--');
    expect(summary).not.toHaveTextContent(/\b0(\.00)? /);
  });

  describe('disabled button states its reason', () => {
    const cases: [string, Partial<OrderFormProps>, [string, string], string][] = [
      ['pause', { newExposurePaused: true }, ['150', '1'], 'New exposure paused'],
      ['oracle', { oracle: { state: 'stale', price: 150_000_000n, ageSeconds: 74 } }, ['150', '1'], 'Oracle stale (74 s > 60 s)'],
      ['price', {}, ['', '1'], 'Enter a price.'],
      ['lot', {}, ['150', '0.0005'], 'Size must be a multiple of 0.001 SOL.'],
      ['portfolio exposure limit', {}, ['150', '11'], 'Portfolio exposure limit is 10 SOL.'],
      [
        'market exposure limit',
        { market: { openInterestLong: 49_500n, openInterestShort: 0n, insuranceFund: 100n * SOL } },
        ['150', '1'],
        'Market exposure limit: long open interest 49.5 of 50 SOL.',
      ],
      [
        'insurance fund floor',
        { market: { openInterestLong: 1_000n, openInterestShort: 0n, insuranceFund: SOL / 10n } },
        ['150', '1'],
        'Risk-off: insurance fund below reserve.',
      ],
      ['margin', { withdrawableCollateral: SOL / 10n }, ['150', '1'], 'Needs 0.2005 SOL margin, 0.1 SOL withdrawable.'],
    ];

    it('names an unknown position for reduce-only', () => {
      setup({ positionLots: null });
      fireEvent.click(screen.getByLabelText('Reduce only'));
      fill('150', '1');
      expect(submit()).toBeDisabled();
      expect(submit()).toHaveTextContent('Position unknown.');
    });
    it.each(cases)('%s', async (_name, props, [p, s], reason) => {
      const { onSubmit } = setup(props);
      fill(p, s);
      expect(submit()).toBeDisabled();
      expect(submit()).toHaveTextContent(reason);
      await act(async () => { fireEvent.click(submit()); });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('asks to connect a wallet when there is nowhere to submit', () => {
      render(
        <OrderForm
          oracle={{ state: 'valid', price: 150_000_000n, ageSeconds: 1 }}
          newExposurePaused={false}
          withdrawableCollateral={SOL}
          market={{ openInterestLong: 0n, openInterestShort: 0n, insuranceFund: 100n * SOL }}
          positionLots={0n}
          portfolio={null}
          portfolioLoading={false}
        />,
      );
      fill('150', '1');
      expect(submit()).toBeDisabled();
      expect(submit()).toHaveTextContent('Connect a wallet');
    });
  });

  it('lets reduce-only close a long while new exposure is paused', () => {
    setup({ newExposurePaused: true, positionLots: 2_000n });
    fireEvent.click(screen.getByRole('button', { name: 'Sell / Short' }));
    fireEvent.click(screen.getByLabelText('Reduce only'));
    fill('150', '2');
    expect(submit()).toBeEnabled();
    expect(screen.getByTestId('order-form-summary')).toHaveTextContent('Initial margin0 SOL');
  });

  it('lets reduce-only close a long at the market exposure limit and insurance fund floor', () => {
    setup({ positionLots: 2_000n, market: { openInterestLong: 50_000n, openInterestShort: 50_000n, insuranceFund: 0n } });
    fireEvent.click(screen.getByRole('button', { name: 'Sell / Short' }));
    fireEvent.click(screen.getByLabelText('Reduce only'));
    fill('150', '2');
    expect(submit()).toBeEnabled();
  });

  it('blocks reduce-only when its fee exceeds withdrawable collateral', () => {
    setup({ positionLots: 2_000n, withdrawableCollateral: 0n });
    fireEvent.click(screen.getByRole('button', { name: 'Sell / Short' }));
    fireEvent.click(screen.getByLabelText('Reduce only'));
    fill('150', '2');
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveTextContent('Needs 0.001 SOL fee, 0 SOL withdrawable.');
  });

  describe('lifecycle', () => {
    it('shows approve then confirming, and submits once on double-click', async () => {
      let markSigned: () => void = () => {};
      let finish: () => void = () => {};
      const onSubmit = vi.fn((_params, onSigned: () => void) => {
        markSigned = onSigned;
        return new Promise<void>((resolve) => { finish = resolve; });
      });
      setup({ onSubmit });
      fill('150', '1');
      fireEvent.click(submit());
      fireEvent.click(submit());
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(submit()).toBeDisabled();
      expect(submit()).toHaveTextContent('Approve in wallet…');

      act(() => markSigned());
      expect(submit()).toHaveTextContent('Confirming…');

      await act(async () => finish());
      expect(submit()).toHaveTextContent('Buy 1.000 SOL');
    });

    it('shows the batch wait before asking for approval', async () => {
      let stage: (s: 'waiting' | 'approve') => void = () => {};
      let finish: () => void = () => {};
      const onSubmit = vi.fn((_params, _onSigned, onStage) => {
        stage = onStage;
        return new Promise<void>((resolve) => { finish = resolve; });
      });
      setup({ onSubmit });
      fill('150', '1');
      fireEvent.click(submit());

      act(() => stage('waiting'));
      expect(submit()).toHaveTextContent('Waiting for next batch…');
      act(() => stage('approve'));
      expect(submit()).toHaveTextContent('Approve in wallet…');

      await act(async () => finish());
      expect(submit()).toHaveTextContent('Buy 1.000 SOL');
    });

    it('returns to a submittable state after a failure, without claiming success', async () => {
      const onSubmit = vi.fn(async () => { throw new Error('rejected'); });
      setup({ onSubmit, lifecycle: null });
      fill('150', '1');
      await act(async () => { fireEvent.click(submit()); });
      expect(submit()).toBeEnabled();
      expect(screen.getByTestId('order-lifecycle')).toBeEmptyDOMElement();
    });

    it('renders the lifecycle state it is given', () => {
      setup({ lifecycle: { kind: 'accepted', batchId: 42n } });
      expect(screen.getByTestId('order-lifecycle')).toHaveTextContent('Accepted · on the book in batch 42');
    });

    it('shows a partial fill with the remainder on the book', () => {
      setup({ lifecycle: { kind: 'partiallyFilled', filledLots: 400n, remainingLots: 600n, awaitingSettlement: false } });
      expect(screen.getByTestId('order-lifecycle')).toHaveTextContent('Partially filled · 0.4 SOL filled, 0.6 SOL on the book');
    });
  });

  it('takes a price clicked on the book', () => {
    const { rerender, props } = setup();
    rerender(<OrderForm {...props} priceOverride={{ price: 149_900_000n, nonce: 1 }} />);
    expect(price()).toHaveValue('149.9');
    fireEvent.change(price(), { target: { value: '150' } });
    rerender(<OrderForm {...props} priceOverride={{ price: 149_900_000n, nonce: 2 }} />);
    expect(price()).toHaveValue('149.9');
  });

  it('takes the side picked on the phone Buy/Sell bar', () => {
    const { rerender, props } = setup();
    rerender(<OrderForm {...props} sideOverride={{ side: 'sell', nonce: 1 }} />);
    expect(screen.getByRole('button', { name: 'Sell / Short' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Buy / Long' }));
    rerender(<OrderForm {...props} sideOverride={{ side: 'sell', nonce: 2 }} />);
    expect(screen.getByRole('button', { name: 'Sell / Short' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('prepares a reduce-only close of an open short', () => {
    setup({ positionLots: -1_500n });
    fireEvent.click(screen.getByRole('button', { name: 'Close short 1.500 SOL' }));
    expect(screen.getByRole('button', { name: 'Buy / Long' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Reduce only')).toBeChecked();
    expect(size()).toHaveValue('1.500');
  });

  it('keeps the account actions footer', () => {
    setup();
    expect(screen.getByTestId('order-form-account-actions')).toBeInTheDocument();
  });

  it('uses the press-feedback class on the submit button', () => {
    setup();
    expect(submit()).toHaveClass('cta');
  });
});
