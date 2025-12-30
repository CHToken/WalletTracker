// src/types.ts

export type ChainId = "eth" | "bsc" | "sol";

export interface TokenBuy {
  txHash: string;
  wallet: string;
  tokenAddress: string;
  amountToken: bigint;
  amountUSD: number;
  timestamp: number;
  blockNumber: number;
}

export interface WalletAnalysis {
  wallet: string;
  tokenAddress: string;
  chain: ChainId;
  buyCount: number;
  totalUSD: number;
  totalTokens: bigint;
  currentBalance: bigint;
  balanceRetentionPercent: number;
  firstBuyTimestamp: number;
  lastBuyTimestamp: number;
  hasSold: boolean;
  lastSellTimestamp: number | null;
  isContract: boolean;
  uniqueTokensTraded: number;
  avgTxPerDay: number;
  buyTimings: number[];
  isValidAccumulator: boolean;
  failureReasons: string[];
}

export interface SwapEvent {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  wallet: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  isBuy: boolean;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
}

export interface DiscoveredToken {
  address: string;
  chain: ChainId;
  pairAddress: string;
  firstSeen: number;
}
