import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrderDrawer } from './OrderDrawer';

function renderDrawer() {
  return render(
    <OrderDrawer>
      {(preset) => (
        <label>
          Size for {preset?.side ?? 'none'}
          <input />
        </label>
      )}
    </OrderDrawer>,
  );
}

const dialog = () => screen.queryByRole('dialog', { name: 'Order form' });

describe('phone order drawer', () => {
  it('stays closed until Buy or Sell is pressed', () => {
    renderDrawer();
    expect(dialog()).toBeNull();
    expect(screen.getByRole('button', { name: 'Buy' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sell' })).toBeVisible();
  });

  it.each(['buy', 'sell'] as const)('%s opens it with that side preselected', (side) => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: side === 'buy' ? 'Buy' : 'Sell' }));
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByLabelText(`Size for ${side}`)).toBeInTheDocument();
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })],
    ['the backdrop', () => fireEvent.click(screen.getByTestId('order-drawer-backdrop'))],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close order form' }))],
  ])('closes on %s', (_, close) => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    close();
    expect(dialog()).toBeNull();
  });

  it('keeps typed input when closed and reopened', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    fireEvent.change(screen.getByLabelText('Size for buy'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close order form' }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(screen.getByLabelText('Size for buy')).toHaveValue('1.5');
  });

  it('moves focus into the sheet on open and back to the trigger on close', () => {
    renderDrawer();
    const sell = screen.getByRole('button', { name: 'Sell' });
    sell.focus();
    fireEvent.click(sell);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(sell).toHaveFocus();
  });

  it('keeps Tab focus inside the open sheet', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    const close = screen.getByRole('button', { name: 'Close order form' });
    const input = screen.getByLabelText('Size for buy');
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(input).toHaveFocus();
  });
});
