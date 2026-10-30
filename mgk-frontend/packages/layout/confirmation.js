"use strict";
/** Confirm by observed RPC status; never infer acceptance from a submitted signature. */
async function confirmSignature(connection, signature, options = {}) {
  const {
    timeoutMs = 30000,
    pollIntervalMs = 500,
    lastValidBlockHeight,
  } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = result.value[0];
    if (status?.err != null)
      throw new Error(
        `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
      );
    if (
      status?.err === null &&
      ["confirmed", "finalized"].includes(status.confirmationStatus)
    )
      return signature;
    if (
      lastValidBlockHeight !== undefined &&
      (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight
    )
      throw new Error(`Transaction ${signature} expired`);
    if (Date.now() >= deadline)
      throw new Error(
        `Transaction ${signature} confirmation timed out; outcome unknown`,
      );
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
module.exports = { confirmSignature };
