import '@testing-library/jest-dom/vitest';

// jsdom installs its own-realm Uint8Array, so Node Buffers (which web3.js passes
// to @noble/hashes) fail its `instanceof Uint8Array` check and every PDA
// derivation throws. Restore Node's Uint8Array, the one Buffer extends.
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;
