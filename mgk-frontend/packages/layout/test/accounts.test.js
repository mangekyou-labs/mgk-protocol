const { test } = require('node:test');
const assert = require('node:assert/strict');
const layouts = require('../program-layouts.json');
const { decodeAccount } = require('../index.js');
test('reads program-generated registry and rejects stale or wrong accounts', () => {
 const bytes = Uint8Array.from(layouts.Registry.fixture);
 assert.equal(decodeAccount('Registry', bytes).batchIdCounter, 21n);
 for (const [offset, value] of [[0, 2], [1, 99]]) {
  const bad = bytes.slice(); bad[offset] = value;
  assert.throws(() => decodeAccount('Registry', bad));
 }
 assert.throws(() => decodeAccount('Registry', bytes.slice(0,-1)));
});
test('program fixtures preserve nested structures and signed 128-bit values',()=>{
 const {decodeStruct,decodeResults,resultsLayout}=require('../index.js');
 const p=decodeAccount('Portfolio',Uint8Array.from(layouts.Portfolio.fixture));
 assert.equal(p.equity,-((1n<<100n)+20n));
 assert.deepEqual(p.positions[0],decodeStruct('Position',Uint8Array.from(layouts.Position.fixture)));
 assert.deepEqual(p.orders[0],decodeStruct('OrderReservation',Uint8Array.from(layouts.OrderReservation.fixture)));
 const c=decodeAccount('Commitment',Uint8Array.from(layouts.Commitment.fixture));
 assert.deepEqual(c.revealed,decodeStruct('RevealedOrder',Uint8Array.from(layouts.RevealedOrder.fixture)));
 const result=decodeResults(Uint8Array.from(resultsLayout.fixture));
 assert.equal(result.bidClearingPrice,-100n);assert.equal(result.fills[0].price,-100n);assert.equal(result.fills[1].auction,1);
});
