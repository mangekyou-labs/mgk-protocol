import {it,expect} from 'vitest';
import {layouts} from '../../layout/index.js';
import {decodePriceOracle,PRICE_ORACLE_VERSION} from './oracle.js';
it('decodes the versioned Rust oracle fixture and rejects legacy magic',()=>{const b=Uint8Array.from(layouts.PriceOracle.fixture);const v=decodePriceOracle(b);expect(v.version).toBe(1);expect(PRICE_ORACLE_VERSION).toBe(1);expect(v.authority.toBytes()).toHaveLength(32);b.set(new TextEncoder().encode('PRCLORCL'));expect(()=>decodePriceOracle(b)).toThrow(/discriminator/);});
