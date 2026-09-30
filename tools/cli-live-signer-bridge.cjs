'use strict';

const http = require('node:http');
const { once } = require('node:events');
const { Connection } = require('@solana/web3.js');
const { loadWebEnv } = require('./lib/loadWebEnv.cjs');
const {
  resolvePersonaKeypairPath,
  loadPersonaKeypair,
  redactRpcUrl,
  resolveRpcUrl,
  signSerialized,
  signAndSendSerialized,
} = require('./lib/liveSigning.cjs');

const DEFAULT_PORTS = { maker: 4011, taker: 4012 };
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function jsonResponse(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('access-control-allow-origin', 'http://localhost:3000');
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(body || '{}');
}

function validateRole(role) {
  if (role !== 'maker' && role !== 'taker') {
    throw new Error(`role must be maker|taker, got ${role}`);
  }
}

async function startSignerBridge({
  role,
  keypair,
  keypairPath,
  connection,
  rpcUrl,
  host = '127.0.0.1',
  port = DEFAULT_PORTS[role],
}) {
  validateRole(role);
  const resolvedRpcUrl = rpcUrl || resolveRpcUrl();
  const loadedKeypair = keypair || loadPersonaKeypair(keypairPath || resolvePersonaKeypairPath(role));
  const liveConnection = connection || new Connection(resolvedRpcUrl, 'confirmed');
  const secretKey = loadedKeypair.secretKey;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.setHeader('access-control-allow-origin', 'http://localhost:3000');
        response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
        response.setHeader('access-control-allow-headers', 'content-type');
        response.end();
        return;
      }

      if (request.method === 'GET' && request.url === '/info') {
        jsonResponse(response, 200, {
          role,
          publicKey: loadedKeypair.publicKey.toBase58(),
          rpc: redactRpcUrl(resolvedRpcUrl),
        });
        return;
      }

      if (request.method !== 'POST' || !['/sign', '/sign-and-send'].includes(request.url)) {
        jsonResponse(response, 404, { error: 'not found' });
        return;
      }

      const { serializedBase64 } = await readJson(request);
      if (typeof serializedBase64 !== 'string' || serializedBase64.length === 0) {
        jsonResponse(response, 400, { error: 'serializedBase64 is required' });
        return;
      }

      if (request.url === '/sign') {
        const signedSerializedBase64 = signSerialized({ serializedBase64, secretKey });
        jsonResponse(response, 200, { signedSerializedBase64 });
        return;
      }

      const { signature } = await signAndSendSerialized({
        serializedBase64,
        secretKey,
        connection: liveConnection,
        logger: { log() {} },
      });
      jsonResponse(response, 200, { signature });
    } catch (error) {
      jsonResponse(response, 400, { error: error instanceof Error ? error.message : 'signing request failed' });
    }
  });

  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  return {
    role,
    publicKey: loadedKeypair.publicKey.toBase58(),
    rpc: redactRpcUrl(resolvedRpcUrl),
    url,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

async function main() {
  const role = process.argv[2];
  validateRole(role);
  loadWebEnv();
  const bridge = await startSignerBridge({
    role,
    port: Number(process.env[`MGK_${role.toUpperCase()}_SIGNER_PORT`] || DEFAULT_PORTS[role]),
  });
  console.log(`Live signer bridge ${role}: ${bridge.url} ${bridge.publicKey} RPC ${bridge.rpc}`);
  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Signer bridge failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}

module.exports = { startSignerBridge, DEFAULT_PORTS };
