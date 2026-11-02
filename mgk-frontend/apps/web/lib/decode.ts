/**
 * Decode an account's bytes, or null when the account is missing or its
 * bytes do not decode. Unknown stays null, never a zeroed value.
 */
export function decodeOrNull<T>(
  account: { data: Uint8Array } | null | undefined,
  decode: (data: Uint8Array) => T,
): T | null {
  if (!account) return null;
  try {
    return decode(new Uint8Array(account.data));
  } catch {
    return null;
  }
}
