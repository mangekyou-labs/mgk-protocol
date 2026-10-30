export interface ConfirmationRpc {
 getSignatureStatuses(signatures: string[], options: {searchTransactionHistory: boolean}): Promise<{value: ({err: unknown; confirmationStatus?: string | null} | null)[]}>;
 getBlockHeight(commitment: 'confirmed'): Promise<number>;
}
export function confirmSignature(connection: ConfirmationRpc, signature: string, options?: {timeoutMs?: number; pollIntervalMs?: number; lastValidBlockHeight?: number}): Promise<string>;
