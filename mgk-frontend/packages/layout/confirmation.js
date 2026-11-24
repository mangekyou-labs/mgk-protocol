"use strict";
/** Confirm by observed RPC status; never infer acceptance from a submitted signature. */
async function confirmSignature(connection, signature, options = {}) {
  const {
    timeoutMs = 30000,
    pollIntervalMs = 500,
    lastValidBlockHeight,
    resend,
    resendIntervalMs = 2000,
    // 0 reads the block height on every poll; bots space it out to save RPC credits.
    heightCheckIntervalMs = 0,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastSentAt = Date.now(),
    lastHeightAt = -Infinity;
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
      Date.now() - lastHeightAt >= heightCheckIntervalMs &&
      ((lastHeightAt = Date.now()),
      (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight)
    )
      throw new Error(`Transaction ${signature} expired`);
    if (Date.now() >= deadline)
      throw new Error(
        `Transaction ${signature} confirmation timed out; outcome unknown`,
      );
    // Rebroadcast while unconfirmed: RPCs drop transactions sent with maxRetries 0.
    if (resend && Date.now() - lastSentAt >= resendIntervalMs) {
      lastSentAt = Date.now();
      await Promise.resolve()
        .then(resend)
        .catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
module.exports = { confirmSignature };
