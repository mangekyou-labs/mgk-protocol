/** True when a browser-exposed RPC URL embeds a billed API credential. */
export function rpcUrlContainsCredential(url: string): boolean {
  return /[?&](api[-_]?key|apikey|access_token)=/i.test(url);
}
