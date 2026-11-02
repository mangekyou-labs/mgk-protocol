'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { layouts } = require('../mgk-frontend/packages/layout');
const { createKeeperWorker } = require('./keeper-worker');
const u64 = n => { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function fixture(id=0n) {
 const payer=Keypair.generate(), core=Keypair.generate().publicKey, matcher=Keypair.generate().publicKey, oracle=Keypair.generate().publicKey;
 const pda=(seeds,owner=core)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),owner)[0];
 const registry=pda(['registry']), instrument=pda(['instrument',Buffer.alloc(2)]), vault=pda(['vault']), batch=pda(['batch',u64(id)]), oracleAccount=Keypair.generate().publicKey;
 const accounts=new Map();
 const put=(key,name,fields={})=>{ const data=Buffer.from(layouts[name].fixture); for(const [field,value] of Object.entries(fields)){const [offset,type]=layouts[name].fields[field]; if(type==='u64')data.writeBigUInt64LE(BigInt(value),offset); else if(type==='pubkey')value.toBuffer().copy(data,offset);else if(type==='u16')data.writeUInt16LE(value,offset);else data[offset]=value;} accounts.set(String(key),{owner:core,data}); return data; };
 const reg=put(registry,'Registry',{batchIdCounter:id+1n});
 const inst=put(instrument,'Instrument',{instrumentId:0,oracleAddr:oracleAccount});
 const b=put(batch,'Batch',{batchId:id,status:0});
 const [deadline]=layouts.Batch.fields.commitDeadlineSlot; b.writeBigUInt64LE(25n,deadline);
 const manifest={schema_version:1,name:'keeper-test',cluster:'localnet',programs:{perps_core:String(core),perps_matcher:String(matcher),oracle:String(oracle)},accounts:Object.fromEntries(Object.entries({registry,instrument,oracle:oracleAccount,insurance:vault,maker:payer.publicKey}).map(([k,v])=>[k,{status:'deployed',address:String(v)}])),start_slot:{status:'set',slot:0}};
 const sent=[], alerts=[]; let slot=0, balance=2e9, fail=false, time=0;
 const connection={getAccountInfo:async key=>accounts.get(String(key))??null,getSlot:async()=>slot,getBalance:async()=>balance,getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),simulateTransaction:async()=>({value:{err:null}}),getSignatureStatuses:async()=>({value:[{err:null,confirmationStatus:'confirmed'}]}),sendRawTransaction:async raw=>{const tx=Transaction.from(raw);assert.ok(tx.verifySignatures()); const ix=tx.instructions.at(-1);sent.push(ix);if(fail)throw Error('RPC credentials must stay private'); if(ix.data[0]===6)b[layouts.Batch.fields.status[0]]=2; if(ix.data[0]===7){b[layouts.Batch.fields.status[0]]=4;const data=Buffer.alloc(51);data[0]=8;data[1]=1;data.writeBigUInt64LE(id,8);accounts.set(String(pda(['results',u64(id)],matcher)),{owner:matcher,data});} if(ix.data[0]===8){b[layouts.Batch.fields.status[0]]=3;reg.writeBigUInt64LE(id+2n,layouts.Registry.fields.batchIdCounter[0]);put(pda(['batch',u64(id+1n)]),'Batch',{batchId:id+1n,status:0});}return 'signature';}};
 return {options:{manifest,payer,connection,now:()=>time,alert:a=>alerts.push(a)},accounts,pda,core,matcher,b,reg,inst,batch,sent,alerts,setSlot:v=>slot=v,setBalance:v=>balance=v,setFail:v=>fail=v,setTime:v=>time=v};
}
test('current collecting batch waits for deadline, then clears and restart settles',async()=>{const f=fixture();const w=await createKeeperWorker(f.options);assert.equal((await w.tick()).status,'collecting');assert.equal(f.sent.length,0);f.setSlot(26);assert.equal((await w.tick()).status,'closed');assert.equal((await w.tick()).status,'cleared');const restarted=await createKeeperWorker(f.options);assert.equal((await restarted.tick()).status,'settled');assert.deepEqual(f.sent.map(ix=>ix.data[0]),[6,7,8]);assert.equal((await restarted.tick()).batchId,1n);});
test('missing current batch halts permanently without historical fallback',async()=>{const f=fixture();f.accounts.delete(String(f.batch));const w=await createKeeperWorker(f.options);assert.equal((await w.tick()).status,'halted');assert.equal(f.alerts[0].code,'missing_batch');assert.equal((await w.tick()).status,'halted');assert.equal(f.sent.length,0);});
