'use client';

import { create } from 'zustand';

import type { TicketSide } from '@/lib/orderTicket';

/**
 * What the user has typed into the order form, kept outside the component.
 *
 * The trade page unmounts the form whenever readiness drops (a failed portfolio
 * or RPC poll), and mounts it again on the next good poll. Component state would
 * reset the typed price on every such blip, so the draft lives here instead.
 * In memory only: a reload starts from an empty ticket.
 */
export interface OrderTicketDraft {
  side: TicketSide;
  price: string;
  size: string;
  reduceOnly: boolean;
  /** Nonce of the last book click copied into `price`; a click applies once. */
  appliedPriceNonce: number | null;
  /** Nonce of the last Buy/Sell bar pick copied into `side`; a pick applies once. */
  appliedSideNonce: number | null;
}

interface OrderTicketStore extends OrderTicketDraft {
  update: (patch: Partial<OrderTicketDraft>) => void;
  reset: () => void;
}

const EMPTY: OrderTicketDraft = {
  side: 'buy',
  price: '',
  size: '',
  reduceOnly: false,
  appliedPriceNonce: null,
  appliedSideNonce: null,
};

export const useOrderTicketStore = create<OrderTicketStore>((set) => ({
  ...EMPTY,
  update: (patch) => set(patch),
  reset: () => set(EMPTY),
}));
