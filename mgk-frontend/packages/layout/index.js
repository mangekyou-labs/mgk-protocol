"use strict";
// Portable wire contract. Generated offsets come from the actual Rust types.
const layouts = require("./program-layouts.json");
const resultsLayout = require("./results-layout.json");
function read(type, data, offset = 0) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const array = /^\[(.+); (\d+)\]$/.exec(type);
  if (array)
    return Array.from({ length: Number(array[2]) }, (_, i) =>
      read(array[1], data, offset + i * size(array[1])),
    );
  if (layouts[type]) return decodeStruct(type, data, offset);
  if (type === "pubkey") return data.slice(offset, offset + 32);
  if (type === "bool") {
    const n = v.getUint8(offset);
    if (n > 1) throw new Error("Invalid boolean");
    return n === 1;
  }
  const signed = type[0] === "i";
  const bits = Number(type.slice(1));
  if (bits === 128)
    return (
      (BigInt(
        signed
          ? v.getBigInt64(offset + 8, true)
          : v.getBigUint64(offset + 8, true),
      ) <<
        64n) +
      v.getBigUint64(offset, true)
    );
  return v[`get${bits === 64 ? "Big" : ""}${signed ? "Int" : "Uint"}${bits}`](
    offset,
    true,
  );
}
function size(type) {
  return (
    layouts[type]?.size ??
    (type === "pubkey" ? 32 : type === "bool" ? 1 : Number(type.slice(1)) / 8)
  );
}
function decodeStruct(name, data, offset = 0) {
  const l = layouts[name];
  if (!l || offset < 0 || offset + l.size > data.byteLength)
    throw new Error(`${name}: buffer too small`);
  return Object.fromEntries(
    Object.entries(l.fields).map(([key, [off, type]]) => [
      key,
      read(type, data, offset + off),
    ]),
  );
}
function decodeAccount(name, data) {
  const l = layouts[name];
  if (!l || l.discriminator == null) throw new Error("Unknown account type");
  if (data.length < l.size) throw new Error(`${name}: buffer too small`);
  if (data[0] !== l.discriminator)
    throw new Error(`${name}: invalid discriminator`);
  if (data[1] !== l.version)
    throw new Error(`${name}: unsupported layout version`);
  return decodeStruct(name, data);
}
function decodeResults(data) {
  if (data.length < resultsLayout.headerSize)
    throw new Error("BatchResults: buffer too small");
  if (data[0] !== 8 || data[1] !== 1)
    throw new Error("BatchResults: invalid discriminator or version");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numFills = v.getUint16(49, true);
  if (
    numFills > 12 ||
    data.length < resultsLayout.headerSize + numFills * resultsLayout.fillSize
  )
    throw new Error("BatchResults: invalid fill count");
  if (data[16] > 1) throw new Error("BatchResults: invalid spent flag");
  const fills = Array.from({ length: numFills }, (_, i) => {
    const o = resultsLayout.headerSize + i * resultsLayout.fillSize;
    if (data[o + 56] > 1 || data[o + 57] > 1)
      throw new Error("BatchResults: invalid fill role");
    return {
      user: data.slice(o, o + 32),
      orderId: v.getBigUint64(o + 32, true),
      qty: v.getBigUint64(o + 40, true),
      price: v.getBigInt64(o + 48, true),
      isMaker: data[o + 56] === 1,
      auction: data[o + 57],
    };
  });
  return {
    batchId: v.getBigUint64(8, true),
    spent: data[16] === 1,
    bidClearingPrice: v.getBigInt64(17, true),
    askClearingPrice: v.getBigInt64(25, true),
    matchedBidQty: v.getBigUint64(33, true),
    matchedAskQty: v.getBigUint64(41, true),
    numFills,
    fills,
  };
}
module.exports = {
  layouts,
  resultsLayout,
  decodeAccount,
  decodeStruct,
  decodeResults,
};
