"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Keypair,PublicKey,Transaction}=require('@solana/web3.js');
const {layouts}=require('../mgk-frontend/packages/layout');
const {createMakerWorker}=require('./maker-worker');
function fixture(){
 const payer=Keypair.generate(),core=Keypair.generate().publicKey,matcher=Keypair.generate().publicKey,oracleProgram=Keypair.generate().publicKey;
 const pda=(seeds,owner=core)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),owner)[0];
 const registry=pda(['registry']),instrument=pda(['instrument',Buffer.alloc(2)]),vault=pda(['vault']),portfolio=pda(['portfolio',payer.publicKey.toBuffer()]),batch=pda(['batch',Buffer.alloc(8)]),oracle=Keypair.generate().publicKey;
 const accounts=new Map();
 function put(key,name,fields={},owner=core){const data=Buffer.alloc(layouts[name].size);data[0]=layouts[name].discriminator;data[1]=layouts[name].version;for(const[k,v]of Object.entries(fields)){const[o,t]=layouts[name].fields[k];if(t==='pubkey')v.toBuffer().copy(data,o);else if(t==='bool'||t==='u8')data[o]=Number(v);else if(t==='u16')data.writeUInt16LE(v,o);else if(t==='u64')data.writeBigUInt64LE(BigInt(v),o);else if(t==='i64')data.writeBigInt64LE(BigInt(v),o);else if(t==='i128'||t==='u128'){data.writeBigUInt64LE(BigInt.asUintN(64,BigInt(v)),o);data.writeBigInt64LE(BigInt(v)>>64n,o+8);}else throw Error(t);}accounts.set(String(key),{owner,data});return data;}
 put(registry,'Registry',{batchIdCounter:1n,maxOrdersPerBatch:12});
 put(instrument,'Instrument',{instrumentId:0,oracleAddr:oracle,isActive:true,tickSize:1n,lotSize:1n});
 const p=put(portfolio,'Portfolio',{user:payer.publicKey,equity:1000000000n});
 put(vault,'Vault',{insuranceFund:20000000000n});put(batch,'Batch',{batchId:0n,status:0,commitDeadlineSlot:100n});
 put(oracle,'PriceOracle',{instrument,price:100000000n,timestamp:1000n,confidence:100n,isActive:true},oracleProgram);
 const book=pda(['book',Buffer.alloc(2)],matcher);put(book,'OrderBook',{instrumentId:0},matcher);
 const manifest={schema_version:1,name:'maker-test',cluster:'localnet',programs:{perps_core:String(core),perps_matcher:String(matcher),oracle:String(oracleProgram)},accounts:Object.fromEntries(Object.entries({registry,instrument,oracle,insurance:vault,maker:payer.publicKey}).map(([k,v])=>[k,{status:'deployed',address:String(v)}])),start_slot:{status:'set',slot:0}};
 const sent=[],alerts=[];let simulationError=null;
 const connection={getAccountInfo:async k=>accounts.get(String(k))??null,getSlot:async()=>0,getBalance:async()=>2e9,getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),simulateTransaction:async()=>({value:{err:simulationError}}),getSignatureStatuses:async()=>({value:[{err:null,confirmationStatus:'confirmed'}]}),sendRawTransaction:async raw=>{assert.ok(raw.length<=1232);const tx=Transaction.from(raw);assert.ok(tx.verifySignatures());sent.push(tx);return 'signature';},getProgramAccounts:async()=>[]};
 return {options:{payer,manifest,connection,now:()=>1000000,alert:v=>alerts.push(v)},put,accounts,sent,alerts,portfolio,oracle,payer,core,matcher,registry,instrument,vault,batch,book,p,setSimulationError:e=>simulationError=e};
}
test('maker posts an atomic three-level ladder per side at 10, 20 and 30 bps, never taker',async()=>{
 const f=fixture();const result=await(await createMakerWorker(f.options)).tick();assert.equal(result.status,'quoted');
 const orders=f.sent[0].instructions.filter(ix=>ix.data[0]===20);assert.equal(orders.length,6);assert.deepEqual(orders.map(ix=>ix.data.readBigInt64LE(3)),[99900000n,99800000n,99700000n,100100000n,100200000n,100300000n]);for(const ix of orders){assert.equal(ix.data[2],1);assert.equal(ix.data.readBigUInt64LE(11),100n);}assert.equal(f.sent.length,1);
});
module.exports={fixture};
function seedOrders(f,prices=[99900000n,99800000n,99700000n,100100000n,100200000n,100300000n]){
 const base=layouts.Portfolio.fields.orders[0],size=layouts.OrderReservation.size;
 prices.forEach((price,index)=>{const b=f.p.subarray(base+index*size);b.writeBigUInt64LE(BigInt(index+1),0);b.writeBigUInt64LE(100n,8);b.writeBigUInt64LE(100n,16);b.writeBigInt64LE(price,24);b[50]=index<3?0:1;});
}
test('maker restart and next batch preserve existing ladder without stacking GTCs',async()=>{const f=fixture();seedOrders(f);for(let n=0;n<2;n++){assert.equal((await(await createMakerWorker(f.options)).tick()).status,'resting');}assert.equal(f.sent.length,0);});
test('invalid oracle cancels all quotes and never posts, including malformed and foreign data',async()=>{for(const mode of ['stale','future','inactive','zero','confidence','instrument','owner','version','missing']){const f=fixture();seedOrders(f);const a=f.accounts.get(String(f.oracle));if(mode==='stale')a.data.writeBigInt64LE(939n,88);if(mode==='future')a.data.writeBigInt64LE(1001n,88);if(mode==='inactive')a.data[10]=0;if(mode==='zero')a.data.writeBigInt64LE(0n,80);if(mode==='confidence')a.data.writeBigInt64LE(1000001n,96);if(mode==='instrument')Keypair.generate().publicKey.toBuffer().copy(a.data,48);if(mode==='owner')a.owner=f.core;if(mode==='version')a.data[1]=2;if(mode==='missing')f.accounts.delete(String(f.oracle));const result=await(await createMakerWorker(f.options)).tick();assert.equal(result.status,'invalid_price',mode);assert.deepEqual(f.sent.flatMap(tx=>tx.instructions.filter(ix=>ix.programId.equals(f.core)).map(ix=>ix.data[0])),[13],mode);}});
test('price changes atomically cancel old quotes and replace six levels',async()=>{const f=fixture();seedOrders(f);f.accounts.get(String(f.oracle)).data.writeBigInt64LE(200000000n,80);assert.equal((await(await createMakerWorker(f.options)).tick()).status,'quoted');assert.deepEqual(f.sent[0].instructions.filter(ix=>ix.programId.equals(f.core)).map(ix=>ix.data[0]),[13,20,20,20,20,20,20]);});
test('maker acts as last-resort liquidator using canonical victim and clears own reservations first',async()=>{const f=fixture();seedOrders(f);const victim=Keypair.generate().publicKey;const victimPortfolio=PublicKey.findProgramAddressSync([Buffer.from('portfolio'),victim.toBuffer()],f.core)[0];const data=f.put(victimPortfolio,'Portfolio',{user:victim,equity:0n,positionsLen:1});const offset=layouts.Portfolio.fields.positions[0];data.writeBigInt64LE(1000n,offset+layouts.Position.fields.qty[0]);data.writeBigInt64LE(100000000n,offset+layouts.Position.fields.entryVwap[0]);f.options.connection.getProgramAccounts=async()=>[{pubkey:victimPortfolio,account:{owner:f.core,data}}];const result=await(await createMakerWorker(f.options)).tick();assert.equal(result.status,'liquidated');assert.deepEqual(f.sent[0].instructions.filter(ix=>ix.programId.equals(f.core)).map(ix=>ix.data[0]),[13,9]);const liquidation=f.sent[0].instructions.at(-1);assert.equal(String(liquidation.keys[0].pubkey),String(victimPortfolio));assert.equal(String(liquidation.keys[4].pubkey),String(f.portfolio));});
