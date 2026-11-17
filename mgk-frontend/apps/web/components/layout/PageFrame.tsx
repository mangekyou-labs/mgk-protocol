import type { ReactNode } from 'react';

export interface PageFrameProps {
  children: ReactNode;
  className?: string;
}

export function PageFrame({ children, className }: PageFrameProps) {
  return (
    // `data-viewport-lock` makes the root layout's body exactly one viewport
    // tall, so this frame fills it and panels scroll inside, never the page.
    <main
      data-testid="page-frame"
      data-viewport-lock
      className={[
        'flex w-full flex-1 min-h-0 flex-col overflow-hidden bg-bg',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </main>
  );
}
