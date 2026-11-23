'use strict';
// Standalone P0-35 end-of-run audit, using the same transport as drows.js --soak:
// public devnet, 1000-request cap, 3 retries on 429/5xx. Read-only; loads no keypair.
const SRC = '~/.cache/mgk-issue-40/src-aac36b5';
const { jsonRpc, createRequestBudget, assertUnkeyedRpc } = require(`${SRC}/tools/runtime/rpc`);
const audit = require(`${SRC}/tools/runtime/audit`);

const RPC = 'https://api.devnet.solana.com';
assertUnkeyedRpc(RPC);
const budget = createRequestBudget({ max: 1000 });
const startedAt = new Date().toISOString();
audit.auditDeployment({ rpc: jsonRpc(RPC, { budget, retries: 3 }), deployment: `${SRC}/deployments/devnet.json` })
  .then(report => {
    const out = { row: 'P0-35', kind: 'standalone end-of-run audit', candidate: 'aac36b5', rpc: RPC,
      startedAt, finishedAt: new Date().toISOString(), requestCap: 1000, ...report };
    console.log(JSON.stringify(out, null, 2));
    process.exit(report.violations.length ? 1 : 0);
  })
  .catch(error => { console.error(`audit failed: ${error.message}`); process.exit(2); });
