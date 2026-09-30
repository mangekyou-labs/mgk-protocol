'use strict';

/**
 * Inject a live-signing Phantom-compatible wallet into a playwright-cli page.
 *
 * Usage (never put a secret on the CLI):
 *   playwright-cli -s=maker run-code "async page => require('/ABS/tools/cli-inject-live-wallet.cjs')(page, 'maker')"
 *
 * The keypair is loaded from disk inside this process. The page only sees
 * the pubkey and signed tx bytes via exposeFunction.
 */

const { Connection } = require('@solana/web3.js');
const { loadWebEnv } = require('./lib/loadWebEnv.cjs');
const {
  resolvePersonaKeypairPath,
  loadPersonaKeypair,
  publicKeyBytesFromKeypair,
  signSerialized,
  signAndSendSerialized,
  buildLiveWalletInitScript,
  resolveRpcUrl,
  redactRpcUrl,
} = require('./lib/liveSigning.cjs');

async function injectLiveWallet(page, role) {
  if (role !== 'maker' && role !== 'taker') {
    throw new Error(`injectLiveWallet: role must be maker|taker, got ${role}`);
  }
  loadWebEnv();
  const keypairPath = resolvePersonaKeypairPath(role);
  const keypair = loadPersonaKeypair(keypairPath);
  const rpc = resolveRpcUrl();
  const connection = new Connection(rpc, 'confirmed');
  const publicKeyBytes = publicKeyBytesFromKeypair(keypair);
  const publicKeyBase58 = keypair.publicKey.toBase58();

  await page.exposeFunction('__mgkSignTransaction', async (serializedBase64) => {
    return signSerialized({
      serializedBase64,
      secretKey: keypair.secretKey,
    });
  });
  await page.exposeFunction('__mgkSignAndSend', async (serializedBase64) => {
    const { signature } = await signAndSendSerialized({
      serializedBase64,
      secretKey: keypair.secretKey,
      connection,
    });
    return signature;
  });

  await page.addInitScript(buildLiveWalletInitScript({ publicKeyBytes }));
  await page.evaluate((pk) => {
    window.__mgkPersonaPublicKey = pk;
  }, publicKeyBase58);

  // Init scripts run on next navigation; reload so Phantom is visible to the adapter.
  await page.reload({ waitUntil: 'domcontentloaded' });

  return {
    role,
    publicKey: publicKeyBase58,
    rpc: redactRpcUrl(rpc),
  };
}

module.exports = injectLiveWallet;
module.exports.injectLiveWallet = injectLiveWallet;
