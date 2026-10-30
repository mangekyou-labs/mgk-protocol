import type { BatchState } from "./types.js";
import { decodeAccount, decodeResults } from "../../../layout/index.js";
export function decodeBatch(data: Uint8Array): BatchState {
  const value = decodeAccount("Batch", data);
  return {
    ...value,
    status: value.status as BatchState["status"],
    markValid: value.markValid === 1,
    liqPaused: value.liqPaused === 1,
  };
}
export const DFBA_RESULTS_HEADER_SIZE = 51;
export const DFBA_FILL_SIZE = 58;
export type DfbaClearResult = ReturnType<typeof decodeResults>;
export const decodeDfbaResultsHeader = decodeResults;
