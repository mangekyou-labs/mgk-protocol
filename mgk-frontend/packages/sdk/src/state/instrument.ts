import { PublicKey } from "@solana/web3.js";
import { layouts, decodeAccount } from "../../../layout/index.js";
export const INSTRUMENT_ORACLE_OFFSET =
  layouts.Instrument.fields.oracleAddr![0];
export function decodeInstrument(data: Uint8Array) {
  const value = decodeAccount("Instrument", data);
  return { ...value, oracleAddr: new PublicKey(value.oracleAddr) };
}
export function readInstrumentOracle(data: Uint8Array) {
  return decodeInstrument(data).oracleAddr;
}
