const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadManifest} = require('../manifest.js');
const pending = require('../../../../deployments/devnet.json');
test('pending deployment has explicit readiness and never stale accounts',()=>{
 const result = loadManifest(pending);
 assert.equal(result.ready,false);
 assert.equal(result.accounts.registry,null);
 assert.equal(result.programs.perps_core,pending.programs.perps_core);
});
test('rejects malformed and conflicting identity, unknown fields, incoherent pending',()=>{
 for(const patch of [{schema_version:2},{cluster:'bogus'},{batch_address:'1111'},{programs:{...pending.programs,oracle:pending.programs.perps_core}},{accounts:{...pending.accounts,registry:{status:'pending',address:pending.programs.oracle}}}]) assert.throws(()=>loadManifest({...pending,...patch}));
});
test('complete valid deployment enables signing with exact identities',()=>{
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 function key(n){let b=BigInt(n)<<248n,s='';while(b){s=alphabet[Number(b%58n)]+s;b/=58n;}return s;}
 const accounts=Object.fromEntries(Object.keys(pending.accounts).map((k,i)=>[k,{status:'deployed',address:key(i+1)}]));
 const m=loadManifest({...pending,accounts,start_slot:{status:'set',slot:123}});
 assert.equal(m.ready,true);assert.equal(m.startSlot,123);assert.equal(m.accounts.registry,accounts.registry.address);
});
