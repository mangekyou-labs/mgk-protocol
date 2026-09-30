import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { UsTech100Sandbox } from './UsTech100Sandbox';

describe('UsTech100Sandbox', () => {
  it('shows the eligibility gate and local-only disclosure', () => {
    render(<UsTech100Sandbox previewSettled={false} />);

    expect(screen.getByRole('heading', { name: 'US Tech 100 Sandbox' })).toBeInTheDocument();
    expect(screen.getByText(/No wallet, backend, live market data, or onchain write/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /licensed IFC partner workflow/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'DFBA mechanism' })).toHaveAttribute(
      'href',
      'https://jumpcrypto.com/resources/dual-flow-batch-auction',
    );
    expect(screen.getByRole('link', { name: 'Nasdaq index licensing' })).toBeInTheDocument();
  });

  it('reports inline errors while preserving the submitted order', async () => {
    const user = userEvent.setup();
    render(<UsTech100Sandbox previewSettled={false} />);

    await user.click(screen.getByRole('button', { name: 'Submit simulated order' }));

    expect(screen.getByText('Confirm partner eligibility to continue.')).toBeInTheDocument();
    expect(screen.getByText('Enter a limit price greater than zero.')).toBeInTheDocument();
    expect(screen.getByLabelText('Limit price')).toHaveValue('');
  });

  it('advances from collecting to clearing to a deterministic receipt', async () => {
    const user = userEvent.setup();
    render(<UsTech100Sandbox previewSettled={false} />);

    await user.click(screen.getByRole('checkbox', { name: /licensed IFC partner workflow/i }));
    await user.click(screen.getByRole('radio', { name: 'Taker' }));
    await user.click(screen.getByRole('radio', { name: 'Buy' }));
    await user.type(screen.getByLabelText('Limit price'), '21482.50');
    await user.type(screen.getByLabelText('Quantity'), '12');
    await user.click(screen.getByRole('button', { name: 'Submit simulated order' }));

    expect(screen.getByText('Collecting')).toHaveAttribute('aria-current', 'step');
    await user.click(screen.getByRole('button', { name: 'Advance to clearing' }));
    expect(screen.getByText('Clearing')).toHaveAttribute('aria-current', 'step');
    await user.click(screen.getByRole('button', { name: 'Settle batch' }));

    expect(screen.getByRole('heading', { name: 'Deterministic receipt' })).toBeInTheDocument();
    expect(screen.getByText('$21,478.25')).toBeInTheDocument();
    expect(screen.getByText('MGK-US100-84A7C2')).toBeInTheDocument();
  });

  it('renders the deterministic settled preview without timers or network activity', () => {
    render(<UsTech100Sandbox previewSettled />);

    expect(screen.getByRole('heading', { name: 'Deterministic receipt' })).toBeInTheDocument();
    expect(screen.getByText('Settled')).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'Start another simulation' }));
    expect(screen.getByRole('button', { name: 'Submit simulated order' })).toBeInTheDocument();
  });
});
