const {test} = require('node:test');
const assert = require('node:assert/strict');
const {confirmSignature} = require('../confirmation.js');
const rpc = status => ({getSignatureStatuses:async()=>({value:[status]})});
test('only confirmed or finalized error-free status succeeds', async()=>{
 for(const confirmationStatus of ['confirmed','finalized']) await confirmSignature(rpc({confirmationStatus,err:null}),'sig');
 for(const status of [null,{confirmationStatus:'processed',err:null},{confirmationStatus:'confirmed',err:{InstructionError:[0,'Custom']}}]) await assert.rejects(confirmSignature(rpc(status),'sig',{timeoutMs:0}));
});
test('RPC failure and expiry never become success',async()=>{
 await assert.rejects(confirmSignature({getSignatureStatuses:async()=>{throw Error('offline')}},'sig'));
 await assert.rejects(confirmSignature({...rpc(null),getBlockHeight:async()=>11},'sig',{lastValidBlockHeight:10}));
});
test('rebroadcasts while unconfirmed and ignores resend failures',async()=>{
 let polls=0,resends=0;
 const conn={getSignatureStatuses:async()=>({value:[++polls<4?null:{confirmationStatus:'confirmed',err:null}]})};
 await confirmSignature(conn,'sig',{pollIntervalMs:1,resendIntervalMs:0,resend:async()=>{resends++;throw Error('dropped')}});
 assert.equal(resends,3);
});
test('heightCheckIntervalMs spaces out block-height reads but still detects expiry',async()=>{
 let polls=0,heights=0,t=0;
 const realNow=Date.now;Date.now=()=>t;
 try{
  const conn={getSignatureStatuses:async()=>{polls++;t+=1000;return {value:[null]}},getBlockHeight:async()=>{heights++;return heights<2?5:11}};
  await assert.rejects(confirmSignature(conn,'sig',{pollIntervalMs:0,lastValidBlockHeight:10,heightCheckIntervalMs:5000,timeoutMs:60000}),/expired/);
  assert.ok(polls>=6&&heights===2,`polls=${polls} heights=${heights}`);
 }finally{Date.now=realNow}
});
