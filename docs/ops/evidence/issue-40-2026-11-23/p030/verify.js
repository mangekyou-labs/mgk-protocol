'use strict';
// P0-30 post-catch-up checks against the pre-restart snapshot.
//   node verify.js <post-dir>   (post-dir holds taker-fills.json and trades.json from capture.sh)
const fs = require('fs');
const path = require('path');
const START_SLOT = 517959329;
const dir = process.argv[2];
const J = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const arr = j => (Array.isArray(j) ? j : j.fills || j.trades || []);
const pre = { fills: arr(J(path.join(__dirname, 'pre/taker-fills.json'))), trades: arr(J(path.join(__dirname, 'pre/trades.json'))) };
const post = { fills: arr(J(path.join(dir, 'taker-fills.json'))), trades: arr(J(path.join(dir, 'trades.json'))) };

const fillKey = f => [f.tx_signature, f.batch_id, f.role, f.price, f.qty, f.slot].join('|');
const tradeKey = t => [t.slot, t.batch_id, t.price, t.qty, t.taker_side, t.is_maker].join('|');
const dups = (xs, key) => {
  const seen = new Map();
  for (const x of xs) seen.set(key(x), (seen.get(key(x)) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, count: n }));
};
const slots = xs => xs.map(x => Number(x.slot));
const batches = xs => xs.map(x => Number(x.batch_id));

// Every pre-restart row inside the post window must still be present after replay.
const minPostFillSlot = Math.min(...slots(post.fills));
const postFillKeys = new Set(post.fills.map(fillKey));
const missingFills = pre.fills.filter(f => Number(f.slot) >= minPostFillSlot && !postFillKeys.has(fillKey(f)));
const minPostTradeSlot = Math.min(...slots(post.trades));
const postTradeKeys = new Set(post.trades.map(tradeKey));
const missingTrades = pre.trades.filter(t => Number(t.slot) >= minPostTradeSlot && !postTradeKeys.has(tradeKey(t)));

const out = {
  startSlot: START_SLOT,
  fills: {
    pre: pre.fills.length, post: post.fills.length,
    postBatchRange: [Math.min(...batches(post.fills)), Math.max(...batches(post.fills))],
    earliestPostSlot: minPostFillSlot, earliestGeStart: minPostFillSlot >= START_SLOT,
    duplicateTuples: dups(post.fills, fillKey), missingFromPre: missingFills.length,
  },
  trades: {
    pre: pre.trades.length, post: post.trades.length,
    earliestPostSlot: minPostTradeSlot, earliestGeStart: minPostTradeSlot >= START_SLOT,
    identicalRows: dups(post.trades, tradeKey), missingFromPre: missingTrades.length,
  },
};
out.pass = out.fills.earliestGeStart && out.trades.earliestGeStart && out.fills.duplicateTuples.length === 0 &&
  out.fills.missingFromPre === 0 && out.trades.missingFromPre === 0;
console.log(JSON.stringify(out, null, 2));
