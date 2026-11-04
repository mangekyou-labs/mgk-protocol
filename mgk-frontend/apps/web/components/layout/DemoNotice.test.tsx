import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DemoNotice } from './DemoNotice';

it('states the restricted demo and the balance reset once, with limits behind an expander', () => {
  render(<DemoNotice />);
  const summary = screen.getByText(/Restricted demo/);
  expect(summary).toHaveTextContent('Earlier devnet balances were not carried over.');
  expect(screen.getAllByText(/not carried over/i)).toHaveLength(1);
  expect(screen.getByText(/no ADL or socialized loss/i)).not.toBeVisible();
  fireEvent.click(summary);
  expect(screen.getByText(/no ADL or socialized loss/i)).toBeVisible();
  expect(screen.getByText(/Funding: off/i)).toBeVisible();
});
