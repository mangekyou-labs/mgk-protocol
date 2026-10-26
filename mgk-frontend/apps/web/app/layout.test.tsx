import { renderToStaticMarkup } from 'react-dom/server';
import { within } from '@testing-library/react';

import RootLayout from './layout';

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: 'font-inter' }),
  JetBrains_Mono: () => ({ variable: 'font-mono' }),
}));

describe('maintenance layout', () => {
  it('explains the rebuild and the devnet balance reset before hydration', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<RootLayout>Trade screen</RootLayout>);

    expect(within(container).getByRole('status')).toHaveTextContent(
      'The demo is being rebuilt.',
    );
    expect(container).toHaveTextContent(
      'Earlier devnet balances were not carried over.',
    );
  });

  it('disables every offered action with an accessible maintenance reason', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<RootLayout>Trade screen</RootLayout>);

    for (const name of ['Place order', 'Cancel order', 'Deposit', 'Withdraw']) {
      const button = within(container).getByRole('button', { name });
      expect(button).toBeDisabled();
      const reason = container.querySelector(`#${button.getAttribute('aria-describedby')}`);
      expect(reason).toHaveTextContent('disabled while we rebuild the demo');
    }
  });

  it('never renders a live route that could request a wallet signature', () => {
    function LiveRoute(): React.ReactNode {
      throw new Error('A live route capable of requesting signatures was rendered');
    }

    expect(() => renderToStaticMarkup(
      <RootLayout><LiveRoute /></RootLayout>,
    )).not.toThrow();
  });
});
