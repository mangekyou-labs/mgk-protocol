import {describe,it,expect} from 'vitest';
import {layouts} from '../../../layout/index.js';
import {decodeBatch,decodeCommitment,decodePortfolio,decodeRegistry,decodeInstrument,decodeAccount,decodeStruct} from './index.js';
describe('Rust program account fixtures',()=> {
 it('decodes registry header and packed counters',()=>{const v=decodeRegistry(Uint8Array.from(layouts.Registry.fixture));expect(v.batchIdCounter).toBe(21n);expect(v.governance.toBytes()).toEqual(new Uint8Array(32).fill(18));});
 it('decodes the v3 economic ledger and funding checkpoints',()=>{const v=decodePortfolio(Uint8Array.from(layouts.Portfolio.fixture));expect(v.principal).toBe(21n);expect(v.equity).toBe(-((1n<<100n)+20n));expect(v.positions[0]?.entryRemainder).toBe(decodeStruct('Position',Uint8Array.from(layouts.Position.fixture)).entryRemainder);expect(v.realizedUsd).toBe(22n);expect(v.riskPnl).toBeDefined();expect(v.positions).toHaveLength(1);expect(v.lastFundingCheckpoint).toHaveLength(32);});
 it('decodes batch and nested commitment records',()=>{expect(decodeBatch(Uint8Array.from(layouts.Batch.fixture)).batchId).toBe(18n);expect(decodeCommitment(Uint8Array.from(layouts.Commitment.fixture)).user.toBytes()).toHaveLength(32);});
 it('decodes instrument, vault and slab fixtures',()=>{expect(decodeInstrument(Uint8Array.from(layouts.Instrument.fixture)).oracleAddr.toBytes()).toHaveLength(32);expect(decodeAccount('Vault',Uint8Array.from(layouts.Vault.fixture)).insuranceFund).toBeDefined();expect(decodeAccount('SlabHeader',Uint8Array.from(layouts.SlabHeader.fixture)).seqno).toBeDefined();});
 for(const [name,l] of Object.entries(layouts)) {
  if(l.discriminator==null)continue;
  it(`rejects malformed ${name} headers, unsupported versions and truncated fixtures`,()=>{
   const n=name as keyof typeof layouts;const b=Uint8Array.from(l.fixture);
   expect(()=>decodeAccount(n,b.subarray(0,l.size-1))).toThrow();
   b[0]=255;expect(()=>decodeAccount(n,b)).toThrow(/discriminator/);b[0]=l.discriminator!;
   b[1]=255;expect(()=>decodeAccount(n,b)).toThrow(/version/);
  });
 }
 it('supports Buffer slices and rejects invalid position counts',()=>{const b=Buffer.concat([Buffer.alloc(7),Buffer.from(layouts.Portfolio.fixture)]).subarray(7);expect(decodePortfolio(b).principal).toBe(21n);b.writeUInt16LE(33,layouts.Portfolio.fields.positionsLen![0]);expect(()=>decodePortfolio(b)).toThrow(/position count/);});
});
