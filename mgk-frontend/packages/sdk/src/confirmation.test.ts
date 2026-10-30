import {expect,it} from 'vitest';
import {confirmSignature} from './index.js';
it('SDK confirmation never turns submission, slot advancement or RPC failure into success',async()=>{
 const rpc=(confirmationStatus:string|null,err:unknown=null)=>({getSignatureStatuses:async()=>({value:[confirmationStatus?{confirmationStatus,err}:null]}),getBlockHeight:async()=>100});
 for(const status of ['confirmed','finalized']) expect(await confirmSignature(rpc(status),'signature')).toBe('signature');
 for(const status of [null,'processed']) await expect(confirmSignature(rpc(status),'signature',{timeoutMs:0})).rejects.toThrow(/timed out/);
 await expect(confirmSignature(rpc('confirmed',{InstructionError:[0,'Custom']}),'signature')).rejects.toThrow(/failed/);
 await expect(confirmSignature(rpc(null),'signature',{lastValidBlockHeight:99})).rejects.toThrow(/expired/);
 await expect(confirmSignature({...rpc(null),getSignatureStatuses:async()=>{throw Error('offline');}},'signature')).rejects.toThrow('offline');
});
