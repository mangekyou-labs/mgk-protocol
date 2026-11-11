import { render, screen } from '@testing-library/react';

import { PageFrame } from './PageFrame';

describe('PageFrame', () => {
  it('renders its children', () => {
    render(
      <PageFrame>
        <span data-testid="child">child</span>
      </PageFrame>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('uses the full width on large screens', () => {
    render(<PageFrame>content</PageFrame>);
    const frame = screen.getByTestId('page-frame');
    expect(frame.className).not.toMatch(/max-w-/);
  });

  it('uses the bg-surface background token (dark surface)', () => {
    render(<PageFrame>content</PageFrame>);
    const frame = screen.getByTestId('page-frame');
    expect(frame.className).toMatch(/bg-bg|bg-surface/);
  });

  it('locks the page to the viewport; panels scroll on their own', () => {
    render(<PageFrame>content</PageFrame>);
    const frame = screen.getByTestId('page-frame');
    expect(frame).toHaveAttribute('data-viewport-lock');
    expect(frame.className).toMatch(/overflow-hidden/);
  });
});
