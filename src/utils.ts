// src/utils.ts

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function estimateUSDFromTokenAmount(
  amount: bigint,
  decimals: number,
  ethPrice: number
): number {
  const tokenAmount = Number(amount) / Math.pow(10, decimals);
  // Rough estimation - assumes average token price of 0.001 ETH
  return tokenAmount * 0.001 * ethPrice;
}
