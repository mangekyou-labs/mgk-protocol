import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DemoNotice } from './DemoNotice';

it('shows a short demo badge and states the balance reset and limits once, on demand', () => {
  render(<DemoNotice />);
  const summary = screen.getByText('Restricted demo');
  expect(screen.getAllByText(/not carried over/i)).toHaveLength(1);
  expect(screen.getByText(/not carried over/i)).not.toBeVisible();
  expect(screen.getByText(/no ADL or socialized loss/i)).not.toBeVisible();
  fireEvent.click(summary);
  expect(screen.getByText(/not carried over/i)).toBeVisible();
  expect(screen.getByText(/no ADL or socialized loss/i)).toBeVisible();
  expect(screen.getByText(/Funding: off/i)).toBeVisible();
});

it('closes on Escape and on a click outside', () => {
  render(<DemoNotice />);
  const notice = screen.getByTestId('demo-notice') as HTMLDetailsElement;
  fireEvent.click(screen.getByText('Restricted demo'));
  expect(notice.open).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(notice.open).toBe(false);
  fireEvent.click(screen.getByText('Restricted demo'));
  fireEvent.pointerDown(document.body);
  expect(notice.open).toBe(false);
});
