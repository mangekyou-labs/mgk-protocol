import {it,expect} from 'vitest';
import {layouts} from '../../../layout/index.js';
import {readInstrumentOracle,INSTRUMENT_ORACLE_OFFSET} from './instrument.js';
it('reads the conversion oracle from the actual Rust Instrument fixture',()=>{expect(INSTRUMENT_ORACLE_OFFSET).toBe(68);const b=Uint8Array.from(layouts.Instrument.fixture);expect(readInstrumentOracle(b).toBytes()).toEqual(b.slice(68,100));expect(()=>readInstrumentOracle(b.subarray(0,100))).toThrow();});
