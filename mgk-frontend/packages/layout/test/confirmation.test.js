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
