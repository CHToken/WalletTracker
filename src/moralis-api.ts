// src/moralis-api.ts
// Moralis API with multi-account support, auto-rotation, zero-lag switching
// 40K CU/day per account - resets daily!

import Moralis from "moralis";
import { EvmChain } from "@moralisweb3/common-evm-utils";
import { ENV, CHAINS, ChainId } from "./appConfig";
import { SwapEvent, TokenInfo } from "./types";
import { logMoralisRequest } from "./rpc-logger";

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

interface MoralisKey {
  index: number;
  dailyRequests: number;
  lastResetDay: number;
  isHealthy: boolean;
  lastError: string | null;
  avgResponseTime: number;
}

const DAILY_LIMIT = 40000;
const keys: string[] = [];
const keyHealth: MoralisKey[] = [];
let currentKeyIndex = 0;
let initialized = false;

function parseKeys(): string[] {
  const multiKeys = process.env.MORALIS_API_KEYS;
  if (multiKeys) {
    return multiKeys.split(',').map(k => k.trim()).filter(k => k.length > 0);
  }
  if (ENV.MORALIS_API_KEY) {
    return [ENV.MORALIS_API_KEY];
  }
  return [];
}

// Get next available key with quota remaining (round-robin)
function getNextKeyIndex(): number {
  const now = new Date();
  const currentDay = now.getDate();
  
  for (let i = 0; i < keys.length; i++) {
    const idx = (currentKeyIndex + i) % keys.length;
    const health = keyHealth[idx];
    
    // Reset daily counter if new day
    if (health.lastResetDay !== currentDay) {
      health.dailyRequests = 0;
      health.lastResetDay = currentDay;
      health.isHealthy = true;
      health.lastError = null;
    }
    
    // Check quota (95% threshold)
    if (health.isHealthy && health.dailyRequests < DAILY_LIMIT * 0.95) {
      currentKeyIndex = (idx + 1) % keys.length;
      return idx;
    }
  }
  
  // All exhausted, return current anyway
  return currentKeyIndex;
}

function trackRequest(keyIndex: number, success: boolean, responseTime?: number, error?: string): void {
  const health = keyHealth[keyIndex];
  health.dailyRequests++;
  
  if (success && responseTime) {
    health.avgResponseTime = health.avgResponseTime 
      ? health.avgResponseTime * 0.8 + responseTime * 0.2 
      : responseTime;
  }
  
  if (!success && error) {
    health.lastError = error;
    if (error.includes('rate') || error.includes('limit') || error.includes('quota')) {
      health.isHealthy = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const MORALIS_CHAIN_MAP: Record<string, EvmChain> = {
  eth: EvmChain.ETHEREUM,
  bsc: EvmChain.BSC,
};

export async function initMoralis(): Promise<void> {
  if (initialized) return;
  
  const parsedKeys = parseKeys();
  if (parsedKeys.length === 0) {
    console.warn("⚠️ Moralis API key not configured - some features disabled");
    return;
  }

  keys.push(...parsedKeys);
  const now = new Date();
  
  for (let i = 0; i < keys.length; i++) {
    keyHealth.push({
      index: i,
      dailyRequests: 0,
      lastResetDay: now.getDate(),
      isHealthy: true,
      lastError: null,
      avgResponseTime: 0,
    });
  }

  // Initialize SDK with first key
  await Moralis.start({ apiKey: keys[0] });
  initialized = true;
  
  const totalDaily = keys.length * DAILY_LIMIT;
  console.log(`✅ Moralis initialized: ${keys.length} key(s), ${(totalDaily/1000).toFixed(0)}K CU/day total`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// API WRAPPER (with auto key rotation)
// ═══════════════════════════════════════════════════════════════════════════════

async function withKeyRotation<T>(operation: () => Promise<T>, method?: string): Promise<T> {
  if (!initialized || keys.length === 0) {
    throw new Error("Moralis not initialized");
  }
  
  const keyIndex = getNextKeyIndex();
  const start = Date.now();
  
  try {
    const result = await operation();
    const responseTime = Date.now() - start;
    trackRequest(keyIndex, true, responseTime);
    logMoralisRequest(keyIndex, true, responseTime, method);
    return result;
  } catch (err: any) {
    const responseTime = Date.now() - start;
    trackRequest(keyIndex, false, undefined, err?.message);
    logMoralisRequest(keyIndex, false, responseTime, method, err?.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTokenTransfers(
  tokenAddress: string,
  chain: ChainId,
  fromDate?: Date
): Promise<SwapEvent[]> {
  await initMoralis();
  if (!initialized) return [];
  
  const swaps: SwapEvent[] = [];
  const evmChain = MORALIS_CHAIN_MAP[chain];
  if (!evmChain) return [];
  
  const chainConfig = CHAINS[chain];
  const dexRouters = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));

  try {
    const response = await withKeyRotation(() => 
      Moralis.EvmApi.token.getTokenTransfers({
        chain: evmChain,
        address: tokenAddress,
        fromDate: fromDate,
        limit: 100,
      }),
      "getTokenTransfers"
    );

    for (const transfer of response.result) {
      const from = transfer.fromAddress.lowercase;
      const to = transfer.toAddress.lowercase;
      const amount = BigInt(transfer.value.toString());
      const timestamp = Math.floor(new Date(transfer.blockTimestamp).getTime() / 1000);
      const txHash = transfer.transactionHash;

      if (dexRouters.has(from) && !dexRouters.has(to)) {
        swaps.push({
          txHash,
          blockNumber: Number(transfer.blockNumber),
          timestamp,
          wallet: to,
          tokenIn: chainConfig.wethAddress,
          tokenOut: tokenAddress.toLowerCase(),
          amountIn: 0n,
          amountOut: amount,
          isBuy: true,
        });
      }

      if (dexRouters.has(to) && !dexRouters.has(from)) {
        swaps.push({
          txHash: txHash + "-sell",
          blockNumber: Number(transfer.blockNumber),
          timestamp,
          wallet: from,
          tokenIn: tokenAddress.toLowerCase(),
          tokenOut: chainConfig.wethAddress,
          amountIn: amount,
          amountOut: 0n,
          isBuy: false,
        });
      }
    }
  } catch (err: any) {
    if (process.env.DEBUG_RPC) {
      console.error(`Moralis error: ${err?.message}`);
    }
  }

  return swaps;
}

export async function getWalletTokenBalance(
  wallet: string,
  tokenAddress: string,
  chain: ChainId
): Promise<bigint> {
  await initMoralis();
  if (!initialized) return 0n;

  const evmChain = MORALIS_CHAIN_MAP[chain];
  if (!evmChain) return 0n;

  try {
    const response = await withKeyRotation(() =>
      Moralis.EvmApi.token.getWalletTokenBalances({
        chain: evmChain,
        address: wallet,
        tokenAddresses: [tokenAddress],
      }),
      "getWalletTokenBalances"
    );

    if (response.result.length > 0) {
      return BigInt(response.result[0].amount.toString());
    }
    return 0n;
  } catch {
    return 0n;
  }
}

export async function getTokenMetadata(
  tokenAddress: string,
  chain: ChainId
): Promise<TokenInfo> {
  await initMoralis();
  if (!initialized) return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };

  const evmChain = MORALIS_CHAIN_MAP[chain];
  if (!evmChain) return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };

  try {
    const response = await withKeyRotation(() =>
      Moralis.EvmApi.token.getTokenMetadata({
        chain: evmChain,
        addresses: [tokenAddress],
      }),
      "getTokenMetadata"
    );

    if (response.result.length > 0) {
      const token = response.result[0].token;
      return {
        symbol: token.symbol || "UNKNOWN",
        name: token.name || "Unknown Token",
        decimals: Number(token.decimals) || 18,
      };
    }
  } catch {}

  return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };
}

export async function getWalletTransactionCount(
  wallet: string,
  chain: ChainId
): Promise<number> {
  await initMoralis();
  if (!initialized) return 0;

  const evmChain = MORALIS_CHAIN_MAP[chain];
  if (!evmChain) return 0;

  try {
    const response = await withKeyRotation(() =>
      Moralis.EvmApi.transaction.getWalletTransactions({
        chain: evmChain,
        address: wallet,
        limit: 100,
      }),
      "getWalletTransactions"
    );
    return response.result.length;
  } catch {
    return 0;
  }
}

export async function getWalletTokensTraded(
  wallet: string,
  chain: ChainId
): Promise<number> {
  await initMoralis();
  if (!initialized) return 0;

  const evmChain = MORALIS_CHAIN_MAP[chain];
  if (!evmChain) return 0;

  try {
    const response = await withKeyRotation(() =>
      Moralis.EvmApi.token.getWalletTokenBalances({
        chain: evmChain,
        address: wallet,
      }),
      "getWalletTokenBalances"
    );
    return response.result.length;
  } catch {
    return 0;
  }
}

export async function getTokenPrice(
  tokenAddress: string,
  chain: ChainId
): Promise<number> {
  await initMoralis();
  if (!initialized) return 0;

  const evmChain = MORALIS_CHAIN_MAP[chain];
  if (!evmChain) return 0;

  try {
    const response = await withKeyRotation(() =>
      Moralis.EvmApi.token.getTokenPrice({
        chain: evmChain,
        address: tokenAddress,
      }),
      "getTokenPrice"
    );
    return response.result.usdPrice || 0;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEX SWAP FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchDexSwapsViaMoralis(
  tokenAddress: string,
  chain: ChainId,
  hoursBack: number = 72
): Promise<SwapEvent[]> {
  await initMoralis();
  if (!initialized) return [];
  
  const evmChain = MORALIS_CHAIN_MAP[chain];
  if (!evmChain) return [];
  
  const fromDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  const swaps: SwapEvent[] = [];
  const chainConfig = CHAINS[chain];
  const dexRouters = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));
  const tokenLower = tokenAddress.toLowerCase();
  const knownPairs = new Set<string>();
  const txTransfers = new Map<string, Array<{from: string, to: string, amount: bigint, timestamp: number, blockNumber: number}>>();

  let cursor: string | undefined;
  let pageCount = 0;
  const maxPages = 10;

  try {
    do {
      const response = await withKeyRotation(() =>
        Moralis.EvmApi.token.getTokenTransfers({
          chain: evmChain,
          address: tokenAddress,
          fromDate: fromDate,
          limit: 100,
          cursor: cursor,
        }),
        "getTokenTransfers"
      );

      for (const transfer of response.result) {
        const from = transfer.fromAddress.lowercase;
        const to = transfer.toAddress.lowercase;
        const amount = BigInt(transfer.value.toString());
        const timestamp = Math.floor(new Date(transfer.blockTimestamp).getTime() / 1000);
        const txHash = transfer.transactionHash;
        const blockNumber = Number(transfer.blockNumber);

        if (from === "0x0000000000000000000000000000000000000000") continue;
        if (to === "0x0000000000000000000000000000000000000000") continue;
        if (amount === 0n) continue;

        const existing = txTransfers.get(txHash) || [];
        existing.push({ from, to, amount, timestamp, blockNumber });
        txTransfers.set(txHash, existing);
      }

      cursor = response.pagination?.cursor;
      pageCount++;
      
      if (cursor) await new Promise(r => setTimeout(r, 100));
    } while (cursor && pageCount < maxPages);

    const seenSwaps = new Set<string>();
    
    for (const [txHash, transfers] of txTransfers) {
      for (const t of transfers) {
        const fromIsRouter = dexRouters.has(t.from);
        const toIsRouter = dexRouters.has(t.to);
        
        if (fromIsRouter && !toIsRouter) {
          const key = `${txHash}-buy-${t.to}`;
          if (!seenSwaps.has(key)) {
            seenSwaps.add(key);
            swaps.push({
              txHash,
              blockNumber: t.blockNumber,
              timestamp: t.timestamp,
              wallet: t.to,
              tokenIn: chainConfig.wethAddress,
              tokenOut: tokenLower,
              amountIn: 0n,
              amountOut: t.amount,
              isBuy: true,
            });
          }
        }
        
        if (toIsRouter && !fromIsRouter) {
          const key = `${txHash}-sell-${t.from}`;
          if (!seenSwaps.has(key)) {
            seenSwaps.add(key);
            swaps.push({
              txHash: txHash + "-sell",
              blockNumber: t.blockNumber,
              timestamp: t.timestamp,
              wallet: t.from,
              tokenIn: tokenLower,
              tokenOut: chainConfig.wethAddress,
              amountIn: t.amount,
              amountOut: 0n,
              isBuy: false,
            });
          }
        }
        
        if (transfers.length > 1) {
          const addressCounts = new Map<string, number>();
          for (const tr of transfers) {
            addressCounts.set(tr.from, (addressCounts.get(tr.from) || 0) + 1);
            addressCounts.set(tr.to, (addressCounts.get(tr.to) || 0) + 1);
          }
          for (const [addr, count] of addressCounts) {
            if (count >= 2 && !dexRouters.has(addr)) {
              knownPairs.add(addr);
            }
          }
        }
      }
    }
    
    for (const [txHash, transfers] of txTransfers) {
      for (const t of transfers) {
        const fromIsPair = knownPairs.has(t.from);
        const toIsPair = knownPairs.has(t.to);
        if (dexRouters.has(t.from) || dexRouters.has(t.to)) continue;
        
        if (fromIsPair && !toIsPair) {
          const key = `${txHash}-buy-${t.to}`;
          if (!seenSwaps.has(key)) {
            seenSwaps.add(key);
            swaps.push({
              txHash,
              blockNumber: t.blockNumber,
              timestamp: t.timestamp,
              wallet: t.to,
              tokenIn: chainConfig.wethAddress,
              tokenOut: tokenLower,
              amountIn: 0n,
              amountOut: t.amount,
              isBuy: true,
            });
          }
        }
        
        if (toIsPair && !fromIsPair) {
          const key = `${txHash}-sell-${t.from}`;
          if (!seenSwaps.has(key)) {
            seenSwaps.add(key);
            swaps.push({
              txHash: txHash + "-sell",
              blockNumber: t.blockNumber,
              timestamp: t.timestamp,
              wallet: t.from,
              tokenIn: tokenLower,
              tokenOut: chainConfig.wethAddress,
              amountIn: t.amount,
              amountOut: 0n,
              isBuy: false,
            });
          }
        }
      }
    }

  } catch (err: any) {
    if (process.env.DEBUG_RPC) {
      console.error(`Moralis fetchDexSwaps error: ${err?.message}`);
    }
  }

  return swaps;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS & MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

export function getMoralisStatus() {
  return keyHealth.map(h => ({
    index: h.index,
    healthy: h.isHealthy,
    dailyRequests: h.dailyRequests,
    dailyLimit: DAILY_LIMIT,
    quotaUsed: `${((h.dailyRequests / DAILY_LIMIT) * 100).toFixed(1)}%`,
    avgMs: Math.round(h.avgResponseTime),
    error: h.lastError?.slice(0, 50),
  }));
}

export function isMoralisConfigured(): boolean {
  return keys.length > 0 || !!ENV.MORALIS_API_KEY || !!process.env.MORALIS_API_KEYS;
}
