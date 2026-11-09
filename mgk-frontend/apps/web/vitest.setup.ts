import '@testing-library/jest-dom/vitest';

// jsdom installs its own-realm Uint8Array, so Node Buffers (which web3.js passes
// to @noble/hashes) fail its `instanceof Uint8Array` check and every PDA
// derivation throws. Restore Node's Uint8Array, the one Buffer extends.
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;

// jsdom has no PointerEvent, so fireEvent.pointer* would drop clientY and
// pointerId. A MouseEvent subclass carrying pointerId is enough for our handlers.
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent =
    PointerEventPolyfill;
}
