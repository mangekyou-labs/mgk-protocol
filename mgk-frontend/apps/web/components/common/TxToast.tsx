'use client';

import type { CSSProperties } from 'react';
import { Toaster, toast } from 'sonner';

import { describeTxError, explorerTxUrl } from '@/lib/txErrors';

const THEME = {
  '--normal-bg': 'var(--color-surface-2)',
  '--normal-border': 'var(--color-border-strong)',
  '--normal-text': 'var(--color-text)',
} as CSSProperties;

/** One toaster for the app; sits above the status bar so it never covers it. */
export function TxToaster() {
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      offset={{ bottom: 40, right: 16 }}
      closeButton
      style={THEME}
      toastOptions={{
        classNames: {
          toast: 'font-sans',
          description: '!text-text-muted',
          success: '[&_[data-icon]]:text-bull',
          error: '[&_[data-icon]]:text-bear',
        },
      }}
    />
  );
}

export function notifyTxConfirmed(title: string, signature: string) {
  toast.success(title, {
    testId: 'tx-toast',
    duration: 6_000,
    description: (
      <a
        href={explorerTxUrl(signature)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="tx-toast-explorer"
        className="text-text underline underline-offset-2 hover:text-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-text"
      >
        View on Solana Explorer
      </a>
    ),
  });
}

export function notifyTxFailed(title: string, error: string) {
  toast.error(title, { testId: 'tx-toast', description: describeTxError(error), duration: 8_000 });
}
