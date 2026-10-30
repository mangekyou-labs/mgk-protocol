const {test} = require('node:test');
const assert = require('node:assert/strict');
const {encodeInstruction} = require('../instructions');
test('Initialize accepts the legacy form without vault bump and the explicit bump form', () => {
  const params = {governance:new Uint8Array(32).fill(7),instrumentCount:3,volatilityMultiplier:1234,batchIdCounter:0n,baseDeposit:9n,nMin:5,tMinSlots:2n,tMaxSlots:8n,tRevealSlots:4n,instrumentId:2,tickSize:10n,lotSize:20n,imrBps:1000,mmrBps:500,takerFeeBps:5,makerFeeBps:-2,oracleAddr:new Uint8Array(32).fill(9),registryBump:101,instrumentBump:102};
  const legacy = encodeInstruction('core','Initialize',params);
  const explicit = encodeInstruction('core','Initialize',{...params,vaultBump:103});
  assert.equal(legacy.length,141);
  assert.equal(explicit.length,142);
  assert.deepEqual(explicit.slice(0,-1),legacy);
  assert.equal(explicit.at(-1),103);
});
