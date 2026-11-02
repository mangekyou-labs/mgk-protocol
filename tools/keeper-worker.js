'use strict';
const { PublicKey, Transaction, TransactionInstruction, VersionedTransaction, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
const { decodeAccount, decodeResults } = require('../mgk-frontend/packages/layout');
const { encodeInstruction } = require('../mgk-frontend/packages/layout/instructions');
const { loadManifest } = require('../mgk-frontend/packages/layout/manifest');
const { confirmSignature } = require('../mgk-frontend/packages/layout/confirmation');
const INTERVAL_MS = 2000;
const u64 = n => { const b=Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const meta = (pubkey,isWritable=true,isSigner=false)=>({pubkey,isWritable,isSigner});
async function createKeeperWorker({manifest:rawManifest,payer,connection,now=Date.now,alert=value=>console.error(JSON.stringify(value)),feeFloorLamports=10000000n}) {
 const manifest=loadManifest(rawManifest);
 if(!manifest.ready || !payer?.publicKey) throw Error('Ready manifest and explicit keeper payer required');
 if(!['localnet','devnet'].includes(manifest.cluster)) throw Error('Keeper supports devnet/localnet only');
 if(manifest.cluster==='devnet' && await connection.getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1') throw Error('RPC cluster differs from manifest');
 const core=new PublicKey(manifest.programs.perps_core),matcher=new PublicKey(manifest.programs.perps_matcher);
 const pda=(seeds,owner=core)=>PublicKey.findProgramAddressSync(seeds,owner);
 const registry=new PublicKey(manifest.accounts.registry),instrument=new PublicKey(manifest.accounts.instrument),vault=new PublicKey(manifest.accounts.insurance),oracle=new PublicKey(manifest.accounts.oracle);
 for(const [actual,seed] of [[registry,'registry'],[vault,'vault']]) if(!actual.equals(pda([Buffer.from(seed)])[0]))throw Error('Noncanonical manifest PDA');
 async function account(key,name,owner=core){const a=await connection.getAccountInfo(key,'confirmed');if(!a || !a.owner.equals(owner))throw Error('Missing or foreign owned account');return name==='Results'?decodeResults(a.data):decodeAccount(name,a.data);}
 async function bindings(){const i=await account(instrument,'Instrument');const id=Buffer.alloc(2);id.writeUInt16LE(i.instrumentId);if(!instrument.equals(pda([Buffer.from('instrument'),id])[0]) || !oracle.equals(new PublicKey(i.oracleAddr)))throw Error('Instrument binding mismatch');return id;}
 await bindings();
 async function send(name,params,keys){const latest=await connection.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:payer.publicKey,...latest}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),new TransactionInstruction({programId:core,keys,data:Buffer.from(encodeInstruction('core',name,params))}));tx.sign(payer);const raw=tx.serialize();const simulation=await connection.simulateTransaction(VersionedTransaction.deserialize(raw),{sigVerify:true,commitment:'confirmed'});if(simulation.value.err)throw Error('Simulation failed');const signature=await connection.sendRawTransaction(raw,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});await confirmSignature(connection,signature,{lastValidBlockHeight:latest.lastValidBlockHeight});return signature;}
 let halted=false;
 async function tick(){if(halted)return {status:"halted"};const counter=(await account(registry,'Registry')).batchIdCounter;if(counter===0n)throw Error('No current batch');const batchId=counter-1n,batch=pda([Buffer.from('batch'),u64(batchId)])[0];const raw=await connection.getAccountInfo(batch,'confirmed');if(!raw){if((await account(registry,'Registry')).batchIdCounter>counter)return {status:'advanced',batchId};halted=true;alert({service:'keeper',severity:'critical',code:'missing_batch',batchId:String(batchId)});return {status:'halted',batchId};}if(!raw.owner.equals(core))throw Error('Foreign batch owner');const state=decodeAccount('Batch',raw.data);if(state.batchId!==batchId)throw Error('Batch identity mismatch');const id=await bindings(),book=pda([Buffer.from('book'),id],matcher)[0],results=pda([Buffer.from('results'),u64(batchId)],matcher)[0];
 if(state.status===0 && BigInt(await connection.getSlot('confirmed'))<state.commitDeadlineSlot)return {status:'collecting',batchId};
 let signature,status;
 if(state.status===0){signature=await send('CloseCommitting',{},[meta(batch),meta(registry)]);status='closed';}
 else if(state.status===2){signature=await send('ClearBatch',{numCommitments:0,numInstruments:1,numPortfolios:0},[meta(batch),meta(book),meta(results),meta(matcher,false),meta(registry),meta(instrument,false),meta(payer.publicKey,true,true),meta(SystemProgram.programId,false)]);status='cleared';}
 else if(state.status===4){const fills=await account(results,'Results',matcher);if(fills.batchId!==batchId || fills.spent)throw Error('Invalid current results');const users=[...new Set(fills.fills.map(f=>new PublicKey(f.user).toBase58()))];const portfolios=users.map(user=>pda([Buffer.from('portfolio'),new PublicKey(user).toBuffer()])[0]);const [next,bump]=pda([Buffer.from('batch'),u64(batchId+1n)]);signature=await send('SettleBatch',{numCommitments:0,numPortfolios:portfolios.length,nextBatchBump:bump},[meta(batch),meta(registry),meta(vault),meta(results),meta(instrument),meta(book),meta(oracle,false),meta(matcher,false),...portfolios.map(p=>meta(p)),meta(next),meta(payer.publicKey,true,true),meta(SystemProgram.programId,false)]);status='settled';}
 else if(state.status===3)status='settled';else throw Error('Unsupported batch phase');
 return {status,batchId,signature};}
 return {tick};
}
module.exports={createKeeperWorker,INTERVAL_MS};
