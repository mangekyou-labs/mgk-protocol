const {test}=require('node:test');
const assert=require('node:assert/strict');
const {marketSeedBytes,marketSeeds,wrapInstruction}=require('../market');
test('scoped wire uses the exact identity bytes and preserves the inner payload',()=>{
 const seed=new Uint8Array(32).fill(7);
 assert.deepEqual(Array.from(wrapInstruction('core',Uint8Array.of(2,9),seed)),[29,...seed,2,9]);
 assert.deepEqual(Array.from(wrapInstruction('matcher',Uint8Array.of(5),seed)),[10,...seed,5]);
 assert.deepEqual(wrapInstruction('core',Uint8Array.of(2,9)),Uint8Array.of(2,9));
 assert.throws(()=>wrapInstruction('core',Uint8Array.of(29),seed));
 assert.throws(()=>marketSeedBytes('bad'));
});
test('all scoped children include registry between prefix and unchanged suffix',()=>{
 const seed=new Uint8Array(32).fill(7), registry=new Uint8Array(32).fill(9), suffix=Uint8Array.of(2,0);
 for(const name of ['vault','instrument','portfolio','batch','commitment','book','results']) {
   const seeds=[new TextEncoder().encode(name),suffix];
   assert.deepEqual(marketSeeds(seeds,seed,registry),[seeds[0],registry,suffix]);
   assert.deepEqual(marketSeeds(seeds),seeds);
   assert.throws(()=>marketSeeds(seeds,seed));
 }
 assert.deepEqual(marketSeeds([Uint8Array.of(114,101,103,105,115,116,114,121)],seed)[1],seed);
});
const {loadManifest}=require('../manifest');
const legacy=require('../../../../deployments/devnet.json');
test('manifest v2 carries an explicit namespace and rejects malformed/ambiguous identities',()=>{
 const raw={...legacy,schema_version:2,market_seed:'11111111111111111111111111111111'};
 assert.equal(loadManifest(raw).marketSeed,raw.market_seed);
 assert.equal(loadManifest(legacy).marketSeed,null);
 assert.throws(()=>loadManifest({...raw,market_seed:'bad'}));
 assert.throws(()=>loadManifest({...raw,market_seed:null}));
 assert.throws(()=>loadManifest({...legacy,market_seed:raw.market_seed}));
 const {market_seed,...missing}=raw;assert.throws(()=>loadManifest(missing));
});
test('public instruction encoder accepts context without changing legacy payload',()=>{
 const {encodeInstruction}=require('../instructions');const seed=new Uint8Array(32).fill(8);
 assert.deepEqual(encodeInstruction('core','Deposit',{amount:1n},seed),Uint8Array.from([29,...seed,2,1,0,0,0,0,0,0,0]));
});
test('history decoding returns only the selected market and rejects malformed envelopes',()=>{
 const {unwrapInstruction}=require('../market');const a=new Uint8Array(32).fill(7),b=new Uint8Array(32).fill(8),inner=Uint8Array.of(8);
 const scoped=wrapInstruction('core',inner,a);
 assert.deepEqual(unwrapInstruction('core',scoped,a),inner);
 assert.equal(unwrapInstruction('core',scoped,b),null);
 assert.equal(unwrapInstruction('core',scoped),null);
 assert.equal(unwrapInstruction('core',inner,a),null);
 assert.deepEqual(unwrapInstruction('core',inner),inner);
 assert.throws(()=>unwrapInstruction('core',Uint8Array.of(29),a));
 assert.throws(()=>unwrapInstruction('core',Uint8Array.from([29,...a,29]),a));
});
