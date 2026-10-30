"use strict";
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new Error(`Manifest: expected ${keys.join(", ")}`);
}
function loadManifest(raw) {
  exact(raw, [
    "schema_version",
    "name",
    "cluster",
    "programs",
    "accounts",
    "start_slot",
  ]);
  if (
    raw.schema_version !== 1 ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    !["localnet", "devnet", "testnet", "mainnet-beta"].includes(raw.cluster)
  )
    throw new Error("Manifest: invalid version, name or cluster");
  const seen = new Set();
  const address = (value) => {
    if (
      typeof value !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
    )
      throw new Error("Manifest: invalid address");
    const alphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
    let bytes = 0;
    for (let m = n; m > 0; m >>= 8n) bytes++;
    bytes += /^1*/.exec(value)[0].length;
    if (bytes !== 32 || seen.has(value))
      throw new Error("Manifest: invalid or duplicate address");
    seen.add(value);
    return value;
  };
  exact(raw.programs, ["perps_core", "perps_matcher", "oracle"]);
  const programs = Object.fromEntries(
    Object.entries(raw.programs).map(([k, v]) => [k, address(v)]),
  );
  exact(raw.accounts, [
    "registry",
    "instrument",
    "oracle",
    "insurance",
    "maker",
  ]);
  const accounts = Object.fromEntries(
    Object.entries(raw.accounts).map(([k, v]) => {
      if (v?.status === "pending") {
        exact(v, ["status"]);
        return [k, null];
      }
      exact(v, ["status", "address"]);
      if (v.status !== "deployed")
        throw new Error("Manifest: invalid account status");
      return [k, address(v.address)];
    }),
  );
  let startSlot = null;
  if (raw.start_slot?.status === "pending") exact(raw.start_slot, ["status"]);
  else {
    exact(raw.start_slot, ["status", "slot"]);
    if (
      raw.start_slot.status !== "set" ||
      !Number.isSafeInteger(raw.start_slot.slot) ||
      raw.start_slot.slot < 0
    )
      throw new Error("Manifest: invalid start slot");
    startSlot = raw.start_slot.slot;
  }
  return {
    name: raw.name,
    cluster: raw.cluster,
    programs,
    accounts,
    startSlot,
    ready: startSlot !== null && Object.values(accounts).every(Boolean),
  };
}
module.exports = { loadManifest };
