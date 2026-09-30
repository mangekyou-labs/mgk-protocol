'use strict';

/**
 * Node-side live-signing helpers for playwright-cli personas.
 * Secret keys stay in this process; the page only receives pubkeys and
 * signed transaction bytes via exposeFunction.
 */

const { readFileSync, existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { Keypair, PublicKey, Transaction, VersionedTransaction } = require('@solana/web3.js');

const ENV_BY_ROLE = {
  maker: 'MGK_MAKER_KEYPAIR',
  taker: 'MGK_TAKER_KEYPAIR',
};

function resolvePersonaKeypairPath(role, env = process.env, home = homedir()) {
  if (role !== 'maker' && role !== 'taker') {
    throw new Error(`Unknown persona role: ${role}`);
  }
  const fromEnv = env[ENV_BY_ROLE[role]];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return join(home, '.config', 'solana', `mgk-trader-${role}.json`);
}

function loadPersonaKeypair(keypairPath) {
  if (!existsSync(keypairPath)) {
    throw new Error(`Persona keypair not found: ${keypairPath}`);
  }
  const parsed = JSON.parse(readFileSync(keypairPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`Persona keypair is not a JSON byte array: ${keypairPath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function publicKeyBytesFromKeypair(keypair) {
  return Array.from(keypair.publicKey.toBytes());
}

function decodeUnsignedTx(serializedBase64) {
  const buf = Buffer.from(serializedBase64, 'base64');
  try {
    return { kind: 'legacy', tx: Transaction.from(buf) };
  } catch {
    return { kind: 'versioned', tx: VersionedTransaction.deserialize(buf) };
  }
}

function signLegacyOrVersioned(decoded, keypair) {
  if (decoded.kind === 'legacy') {
    decoded.tx.partialSign(keypair);
    return decoded.tx.serialize();
  }
  decoded.tx.sign([keypair]);
  return Buffer.from(decoded.tx.serialize());
}

function signSerialized({ serializedBase64, secretKey }) {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const decoded = decodeUnsignedTx(serializedBase64);
  return Buffer.from(signLegacyOrVersioned(decoded, keypair)).toString('base64');
}

async function signAndSendSerialized({
  serializedBase64,
  secretKey,
  connection,
  logger = console,
}) {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const decoded = decodeUnsignedTx(serializedBase64);
  const raw = signLegacyOrVersioned(decoded, keypair);
  logger.log?.('[live-sign] sending signed tx', {
    publicKey: keypair.publicKey.toBase58(),
    bytes: raw.length,
  });
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
  if (typeof connection.confirmTransaction === 'function') {
    await connection.confirmTransaction(signature, 'confirmed');
  }
  return { signature };
}

function artifactContainsSecret(artifact, secretKey) {
  if (artifact == null) return false;
  const text = String(artifact);
  const bytes = Array.from(Uint8Array.from(secretKey));
  if (text.includes(JSON.stringify(bytes))) return true;
  if (text.includes(bytes.join(','))) return true;
  const b64 = Buffer.from(bytes).toString('base64');
  if (b64 && text.includes(b64)) return true;
  const hex = Buffer.from(bytes).toString('hex');
  if (hex.length >= 16 && text.toLowerCase().includes(hex.toLowerCase())) return true;
  return false;
}

function redactRpcUrl(url) {
  if (!url) return '(unset)';
  if (/helius/i.test(url)) return 'helius-devnet (redacted)';
  if (/quiknode/i.test(url)) return 'quicknode-devnet (redacted)';
  if (/infura/i.test(url)) return 'infura-devnet (redacted)';
  try {
    const parsed = new URL(url);
    if (
      parsed.searchParams.has('api-key') ||
      parsed.searchParams.has('apiKey') ||
      /api-key/i.test(parsed.pathname)
    ) {
      return `${parsed.origin}/***`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(rpc)';
  }
}

function resolveRpcUrl(env = process.env) {
  return (
    env.RPC_URL ||
    env.NEXT_PUBLIC_RPC_URL ||
    'https://api.devnet.solana.com'
  );
}

/**
 * Browser init script. Signing is delegated to window.__mgkSignAndSend /
 * window.__mgkSignTransaction which must be page.exposeFunction'd from Node.
 */
function buildLiveWalletInitScript({ publicKeyBytes, publicKeyBase58 }) {
  const encoded =
    publicKeyBase58 ||
    new PublicKey(Uint8Array.from(publicKeyBytes)).toBase58();
  const fn = function liveWalletInit({ publicKeyBytes, publicKeyBase58 }) {
    const listeners = new Map();
    const emit = (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    };

    const serializeTx = (transaction) => {
      if (!transaction) throw new Error('No transaction to sign');
      if (typeof transaction.serialize === 'function') {
        const raw = transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      }
      throw new Error('Unsupported transaction type');
    };

    const hydrateSigned = (transaction, signedB64) => {
      const binary = atob(signedB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (transaction && typeof transaction.serialize === 'function' && transaction.signatures) {
        // Legacy web3.js Transaction — replace in place when possible.
        if (typeof transaction.constructor?.from === 'function') {
          return transaction.constructor.from(bytes);
        }
      }
      return bytes;
    };

    const publicKey = {
      toBytes: () => new Uint8Array(publicKeyBytes),
      toBase58: () => publicKeyBase58,
      toString: () => publicKeyBase58,
    };

    const wallet = {
      isPhantom: true,
      isConnected: false,
      publicKey,
      on(event, listener) {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      },
      off(event, listener) {
        listeners.get(event)?.delete(listener);
      },
      async connect() {
        wallet.isConnected = true;
        emit('connect', publicKey);
        return { publicKey };
      },
      async disconnect() {
        wallet.isConnected = false;
        emit('disconnect');
      },
      async signTransaction(transaction) {
        const b64 = serializeTx(transaction);
        const signedB64 = await window.__mgkSignTransaction(b64);
        return hydrateSigned(transaction, signedB64);
      },
      async signAllTransactions(transactions) {
        const out = [];
        for (const transaction of transactions) {
          out.push(await wallet.signTransaction(transaction));
        }
        return out;
      },
      async signAndSendTransaction(transaction) {
        const b64 = serializeTx(transaction);
        const signature = await window.__mgkSignAndSend(b64);
        return { signature };
      },
      async signMessage() {
        throw new Error('signMessage is not supported in the live persona wallet');
      },
    };

    Object.defineProperty(window, 'isPhantomInstalled', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'phantom', {
      configurable: true,
      value: { solana: wallet },
    });
    Object.defineProperty(window, 'solana', {
      configurable: true,
      value: wallet,
    });
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
  };

  return `(${fn.toString()})(${JSON.stringify({ publicKeyBytes, publicKeyBase58: encoded })});`;
}

module.exports = {
  resolvePersonaKeypairPath,
  loadPersonaKeypair,
  publicKeyBytesFromKeypair,
  signSerialized,
  signAndSendSerialized,
  artifactContainsSecret,
  redactRpcUrl,
  resolveRpcUrl,
  buildLiveWalletInitScript,
};
