async page => {
  const config = await page.evaluate(() => {
    const raw = localStorage.getItem('__mgkLiveWalletConfig');
    return raw ? JSON.parse(raw) : null;
  });
  if (!config?.bridgeUrl || !config?.publicKeyBase58 || !Array.isArray(config.publicKeyBytes)) {
    throw new Error('Missing __mgkLiveWalletConfig localStorage entry');
  }

  const requestJson = async (path, serializedBase64) => {
    const response = await page.context().request.post(`${config.bridgeUrl}${path}`, {
      data: { serializedBase64 },
      timeout: 30_000,
    });
    const body = await response.json();
    if (!response.ok()) throw new Error(body.error || `signer bridge returned ${response.status()}`);
    return body;
  };

  await page.exposeFunction('__mgkSignTransaction', async serializedBase64 => {
    const body = await requestJson('/sign', serializedBase64);
    return body.signedSerializedBase64;
  });
  await page.exposeFunction('__mgkSignAndSend', async serializedBase64 => {
    const body = await requestJson('/sign-and-send', serializedBase64);
    return body.signature;
  });

  await page.addInitScript(({ publicKeyBytes, publicKeyBase58 }) => {
    const listeners = new Map();
    const emit = (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    };
    const serializeTx = transaction => {
      if (!transaction || typeof transaction.serialize !== 'function') {
        throw new Error('Unsupported transaction type');
      }
      const raw = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const hydrateSigned = (transaction, signedBase64) => {
      const binary = atob(signedBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      if (transaction && typeof transaction.serialize === 'function' && transaction.signatures && typeof transaction.constructor?.from === 'function') {
        return transaction.constructor.from(bytes);
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
        const signedBase64 = await window.__mgkSignTransaction(serializeTx(transaction));
        return hydrateSigned(transaction, signedBase64);
      },
      async signAllTransactions(transactions) {
        const signed = [];
        for (const transaction of transactions) signed.push(await wallet.signTransaction(transaction));
        return signed;
      },
      async signAndSendTransaction(transaction) {
        const signature = await window.__mgkSignAndSend(serializeTx(transaction));
        return { signature };
      },
      async signMessage() {
        throw new Error('signMessage is not supported in the live persona wallet');
      },
    };
    Object.defineProperty(window, 'isPhantomInstalled', { configurable: true, value: true });
    Object.defineProperty(window, 'phantom', { configurable: true, value: { solana: wallet } });
    Object.defineProperty(window, 'solana', { configurable: true, value: wallet });
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
  }, { publicKeyBytes: config.publicKeyBytes, publicKeyBase58: config.publicKeyBase58 });

  await page.evaluate(publicKey => {
    window.__mgkPersonaPublicKey = publicKey;
  }, config.publicKeyBase58);
  await page.reload({ waitUntil: 'domcontentloaded' });
  return { role: config.role, publicKey: config.publicKeyBase58, bridgeUrl: config.bridgeUrl };
}
