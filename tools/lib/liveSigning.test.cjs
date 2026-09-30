'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Keypair, Transaction, SystemProgram } = require('@solana/web3.js');

const {
  resolvePersonaKeypairPath,
  loadPersonaKeypair,
  publicKeyBytesFromKeypair,
  signAndSendSerialized,
  signSerialized,
  buildLiveWalletInitScript,
  artifactContainsSecret,
  redactRpcUrl,
} = require('./liveSigning.cjs');

describe('persona keypair paths', () => {
  it('defaults maker and taker paths under ~/.config/solana', () => {
    assert.equal(
      resolvePersonaKeypairPath('maker', {}, '/tmp/home'),
      '/tmp/home/.config/solana/mgk-trader-maker.json',
    );
    assert.equal(
      resolvePersonaKeypairPath('taker', {}, '/tmp/home'),
      '/tmp/home/.config/solana/mgk-trader-taker.json',
    );
  });

  it('prefers MGK_MAKER_KEYPAIR and MGK_TAKER_KEYPAIR when set', () => {
    assert.equal(
      resolvePersonaKeypairPath(
        'maker',
        { MGK_MAKER_KEYPAIR: '/custom/maker.json' },
        '/tmp/home',
      ),
      '/custom/maker.json',
    );
    assert.equal(
      resolvePersonaKeypairPath(
        'taker',
        { MGK_TAKER_KEYPAIR: '/custom/taker.json' },
        '/tmp/home',
      ),
      '/custom/taker.json',
    );
  });
});

describe('loadPersonaKeypair', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mgk-live-sign-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a keypair whose public key matches the file and does not expose secretKey on JSON.stringify of the public surface', () => {
    const kp = Keypair.generate();
    const path = join(dir, 'trader.json');
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));

    const loaded = loadPersonaKeypair(path);
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());

    const publicSurface = {
      publicKey: loaded.publicKey.toBase58(),
      bytes: publicKeyBytesFromKeypair(loaded),
    };
    const dumped = JSON.stringify(publicSurface);
    assert.equal(artifactContainsSecret(dumped, kp.secretKey), false);
  });
});

describe('signAndSendSerialized', () => {
  it('sends a signed legacy transaction through the connection and never logs the secret', async () => {
    const payer = Keypair.generate();
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    );
    const serializedBase64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    let sent = null;
    const logs = [];
    const logger = {
      log: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    };

    const result = await signAndSendSerialized({
      serializedBase64,
      secretKey: payer.secretKey,
      connection: {
        sendRawTransaction: async (raw) => {
          sent = Buffer.from(raw);
          return 'fake-signature-1';
        },
        confirmTransaction: async () => ({}),
      },
      logger,
    });

    assert.equal(result.signature, 'fake-signature-1');
    assert.ok(sent);
    const signed = Transaction.from(sent);
    assert.equal(signed.verifySignatures(), true);

    const logText = JSON.stringify(logs);
    assert.equal(artifactContainsSecret(logText, payer.secretKey), false);
  });

  it('signSerialized returns a signed tx that still verifies', () => {
    const payer = Keypair.generate();
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    );
    const serializedBase64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    const signedB64 = signSerialized({
      serializedBase64,
      secretKey: payer.secretKey,
    });
    const signed = Transaction.from(Buffer.from(signedB64, 'base64'));
    assert.equal(signed.verifySignatures(), true);
  });
});

describe('buildLiveWalletInitScript', () => {
  it('embeds only public key bytes and never the word secretKey', () => {
    const bytes = Array.from({ length: 32 }, (_, i) => i + 1);
    const src = buildLiveWalletInitScript({ publicKeyBytes: bytes });
    assert.match(src, /isPhantom/);
    assert.match(src, /__mgkSignAndSend/);
    assert.match(src, /signAndSendTransaction/);
    assert.doesNotMatch(src, /secretKey/i);
    assert.doesNotMatch(src, /password/i);
    assert.match(src, /1,\s*2,\s*3/);
  });
});

describe('secret scan helpers', () => {
  it('detects a secret key JSON array inside an artifact', () => {
    const kp = Keypair.generate();
    const artifact = `connected ${kp.publicKey.toBase58()} secret=${JSON.stringify(Array.from(kp.secretKey))}`;
    assert.equal(artifactContainsSecret(artifact, kp.secretKey), true);
    assert.equal(artifactContainsSecret(`pubkey only ${kp.publicKey.toBase58()}`, kp.secretKey), false);
  });

  it('redacts Helius and api-key RPC URLs', () => {
    assert.equal(
      redactRpcUrl('https://devnet.helius-rpc.com/?api-key=super-secret'),
      'helius-devnet (redacted)',
    );
    assert.equal(
      redactRpcUrl('https://api.devnet.solana.com'),
      'https://api.devnet.solana.com/',
    );
  });

  it('redacts credential-bearing QuickNode path URLs', () => {
    assert.equal(
      redactRpcUrl('https://responsive-rough-breeze.solana-devnet.quiknode.pro/credential-token/'),
      'quicknode-devnet (redacted)',
    );
  });

  it('redacts credential-bearing Infura path URLs', () => {
    assert.equal(
      redactRpcUrl('https://solana-devnet.infura.io/v3/secret-token'),
      'infura-devnet (redacted)',
    );
  });
});
