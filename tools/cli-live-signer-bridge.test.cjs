'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemProgram } = require('@solana/web3.js');

const { startSignerBridge } = require('./cli-live-signer-bridge.cjs');

function unsignedTransfer(payer) {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: tx.feePayer,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

test('CLI signer bridge exposes public metadata and signs through the injected connection', async () => {
  const keypair = Keypair.generate();
  const calls = [];
  const connection = {
    async sendRawTransaction(bytes) {
      calls.push(Buffer.from(bytes));
      return 'bridge-signature';
    },
    async confirmTransaction(signature, commitment) {
      calls.push({ signature, commitment });
      return { value: { err: null } };
    },
  };

  const bridge = await startSignerBridge({
    role: 'maker',
    keypair,
    connection,
    port: 0,
    rpcUrl: 'https://devnet.helius-rpc.com/?api-key=not-a-real-secret',
  });

  try {
    const info = await fetch(`${bridge.url}/info`).then((response) => response.json());
    assert.deepEqual(info, {
      role: 'maker',
      publicKey: keypair.publicKey.toBase58(),
      rpc: 'helius-devnet (redacted)',
    });

    const serializedBase64 = Buffer.from(unsignedTransfer(keypair)).toString('base64');
    const signedResponse = await fetch(`${bridge.url}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serializedBase64 }),
    });
    const signed = await signedResponse.json();
    assert.equal(signedResponse.ok, true, JSON.stringify(signed));
    const signedTx = Transaction.from(Buffer.from(signed.signedSerializedBase64, 'base64'));
    assert.equal(signedTx.verifySignatures(), true);

    const sent = await fetch(`${bridge.url}/sign-and-send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serializedBase64 }),
    }).then((response) => response.json());
    assert.deepEqual(sent, { signature: 'bridge-signature' });
    assert.deepEqual(calls.at(-1), { signature: 'bridge-signature', commitment: 'confirmed' });
  } finally {
    await bridge.close();
  }
});
