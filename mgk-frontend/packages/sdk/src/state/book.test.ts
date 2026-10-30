import {it,expect} from 'vitest';
import {layouts} from '../../../layout/index.js';
import {decodeBookHeader,decodeRestingOrder} from './book.js';
it('decodes the Rust order book header and bounds resting order slots',()=>{const b=Uint8Array.from(layouts.OrderBook.fixture);expect(decodeBookHeader(b).bids).toHaveLength(64);expect(decodeBookHeader(b).asks).toHaveLength(64);expect(()=>decodeRestingOrder(b,-1)).toThrow();expect(()=>decodeRestingOrder(b,256)).toThrow();expect(()=>decodeRestingOrder(b,0)).toThrow();});
