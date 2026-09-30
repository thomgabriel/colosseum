export function explorerTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}
export function explorerAccountUrl(address: string): string {
  return `https://solscan.io/account/${address}`;
}
