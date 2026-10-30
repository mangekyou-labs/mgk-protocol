import {it,expect} from 'vitest';
import {state} from '@mgk/sdk';
import {decodeDfbaFills,decodeFills} from './decoder.js';
it('decodes actual program results with envelope and both auction roles',()=>{const b=Uint8Array.from(state.resultsLayout.fixture);const fills=decodeDfbaFills(b,100,42n,0,'sig');expect(fills).toHaveLength(2);expect(fills[0]).toMatchObject({price:-100n,qty:11n,isMaker:true,takerSide:1});expect(fills[1]).toMatchObject({price:101n,qty:12n,isMaker:false,takerSide:0});expect(()=>decodeDfbaFills(b,100,41n,0,'sig')).toThrow(/batch ID/);expect(()=>decodeDfbaFills(b.subarray(0,b.length-1),100,42n,0,'sig')).toThrow();});
it('rejects legacy unversioned result buffers',()=>{expect(()=>decodeFills(new Uint8Array(51),1,1n,0,'sig',0)).toThrow(/Legacy/);});
