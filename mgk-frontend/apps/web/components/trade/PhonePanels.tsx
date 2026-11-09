'use client';

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { moveTabFocus } from './tabKeys';

const PANELS = [
  { id: 'book', label: 'Book' },
  { id: 'trades', label: 'Trades' },
  { id: 'positions', label: 'Positions' },
] as const;
type PanelId = (typeof PANELS)[number]['id'];

export interface PhonePanelsProps {
  book: ReactNode;
  trades: ReactNode;
  positions: ReactNode;
}

/** Phone only: tabs under the chart. Only the active panel is mounted, so hidden Fills and Open orders stop polling. */
export function PhonePanels({ book, trades, positions }: PhonePanelsProps) {
  const [active, setActive] = useState<PanelId>('book');
  const content = { book, trades, positions }[active];

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = moveTabFocus(event, index, PANELS.length);
    if (next !== null) setActive(PANELS[next].id);
  }

  return (
    <div className="flex flex-col">
      <div
        role="tablist"
        aria-label="Market panels"
        className="sticky top-0 z-10 flex shrink-0 border-b border-border bg-surface-1"
      >
        {PANELS.map((panel, index) => (
          <button
            key={panel.id}
            id={`phone-tab-${panel.id}`}
            role="tab"
            aria-selected={active === panel.id}
            aria-controls={`phone-panel-${panel.id}`}
            tabIndex={active === panel.id ? 0 : -1}
            onClick={() => setActive(panel.id)}
            onKeyDown={(e) => navigate(e, index)}
            className={`flex-1 border-b-2 px-3 py-2 text-xs ${active === panel.id ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'}`}
          >
            {panel.label}
          </button>
        ))}
      </div>
      <div
        id={`phone-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`phone-tab-${active}`}
      >
        {content}
      </div>
    </div>
  );
}
