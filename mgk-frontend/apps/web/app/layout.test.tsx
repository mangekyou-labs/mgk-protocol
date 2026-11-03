import { renderToStaticMarkup } from 'react-dom/server';
import { within } from '@testing-library/react';

import RootLayout from './layout';

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: 'font-inter' }),
  JetBrains_Mono: () => ({ variable: 'font-mono' }),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/providers/SolanaProvider', () => ({
  SolanaProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/providers/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
describe('live layout', () => {
  it('mounts route content instead of the maintenance screen', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<RootLayout>Trade screen</RootLayout>);

    expect(within(container).getByText('Trade screen')).toBeTruthy();
    expect(container).not.toHaveTextContent('The demo is being rebuilt.');
  });
});
