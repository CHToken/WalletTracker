// src/moralis-api.ts
// Moralis API with multi-account support using direct REST calls
// 40K CU/day per account - resets daily!

import { ENV, CHAINS, ChainId } from "./appConfig";
import { SwapEvent, TokenInfo } from "./types";
import { logMoralisRequest } from "./rpc-logger";

// ═══════════════════════════════════════════════════════════════════════════════
// CU COST TRACKING (actual Moralis costs)
// ═══════════════════════════════════════════════════════════════════════════════

const CU_COSTS: Record<string, number> = {
  getTokenTransfers: 50,
  getTokenMetadata: 5,
  getTokenPrice: 10,
  getWalletTokenBalances: 25,
  getWalletTransactions: 5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CACHING
// ═══════════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const metadataCache = new Map<string, CacheEntry<TokenInfo>>();
const priceCache = new Map<string, CacheEntry<number>>();
const METADATA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for metadata
const PRICE_CACHE_TTL = 5 * 60 * 1000; // 5min for prices

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string, ttl: number): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < ttl) {
    return entry.data;
  }
  return null;
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

interface MoralisKey {
  index: number;
  key: string;
  dailyRequests: number;
  dailyCU: number;
  lastResetDay: number;
  isHealthy: boolean;
  lastError: string | null;
  avgResponseTime: number;
}

const DAILY_LIMIT = 40000;
const keyPool: MoralisKey[] = [];
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

// Get next healthy key (round-robin with health check)
function getNextKey(): MoralisKey | null {
  if (keyPool.length === 0) return null;
  
  const now = new Date();
  const currentDay = now.getDate();
  
  // First pass: reset daily counters if needed
  for (const keyInfo of keyPool) {
    if (keyInfo.lastResetDay !== currentDay) {
      keyInfo.dailyRequests = 0;
      keyInfo.dailyCU = 0;
      keyInfo.lastResetDay = currentDay;
      keyInfo.isHealthy = true;
      keyInfo.lastError = null;
      console.log(`🔄 Moralis key ${keyInfo.index + 1} reset for new day`);
    }
  }
  
  // Second pass: find a healthy key with quota
  const startIdx = currentKeyIndex;
  for (let i = 0; i < keyPool.length; i++) {
    const idx = (startIdx + i) % keyPool.length;
    const keyInfo = keyPool[idx];
    
    // Skip unhealthy keys entirely
    if (!keyInfo.isHealthy) continue;
    
    // Check if key has quota remaining
    if (keyInfo.dailyCU < DAILY_LIMIT * 0.95) {
      currentKeyIndex = (idx + 1) % keyPool.length;
      return keyInfo;
    }
  }
  
  // All keys exhausted or unhealthy
  console.warn(`⚠️ All Moralis keys exhausted or unhealthy`);
  return null;
}

function trackRequest(keyInfo: MoralisKey, success: boolean, responseTime: number, method: string, error?: string): void {
  keyInfo.dailyRequests++;
  keyInfo.dailyCU += CU_COSTS[method] || 10;
  
  if (success) {
    keyInfo.avgResponseTime = keyInfo.avgResponseTime 
      ? keyInfo.avgResponseTime * 0.8 + responseTime * 0.2 
      : responseTime;
  }
  
  if (!success && error) {
    keyInfo.lastError = error;
    // Mark as unhealthy if quota exhausted
    if (error.includes('consumed') || error.includes('limit') || error.includes('quota') || error.includes('401')) {
      keyInfo.isHealthy = false;
      console.log(`⚠️ Moralis key ${keyInfo.index + 1} marked unhealthy: ${error.slice(0, 60)}`);
    }
  }
}

export function getRemainingCU(): number {
  return keyPool.reduce((sum, k) => {
    if (k.isHealthy) {
      return sum + Math.max(0, DAILY_LIMIT - k.dailyCU);
    }
    return sum;
  }, 0);
}

export function getTotalCUUsed(): number {
  return keyPool.reduce((sum, k) => sum + k.dailyCU, 0);
}

export function hasEnoughCU(method: string, calls: number = 1): boolean {
  const needed = (CU_COSTS[method] || 10) * calls;
  return getRemainingCU() >= needed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const CHAIN_IDS: Record<string, string> = {
  eth: "0x1",
  bsc: "0x38",
};

export async function initMoralis(): Promise<void> {
  if (initialized) return;
  
  const keys = parseKeys();
  if (keys.length === 0) {
    console.warn("⚠️ Moralis API key not configured - some features disabled");
    return;
  }

  const now = new Date();
  for (let i = 0; i < keys.length; i++) {
    keyPool.push({
      index: i,
      key: keys[i],
      dailyRequests: 0,
      dailyCU: 0,
      lastResetDay: now.getDate(),
      isHealthy: true,
      lastError: null,
      avgResponseTime: 0,
    });
  }

  initialized = true;
  const totalDaily = keys.length * DAILY_LIMIT;
  console.log(`✅ Moralis initialized: ${keys.length} key(s), ${(totalDaily/1000).toFixed(0)}K CU/day total`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECT REST API CALLS (with real key rotation)
// ═══════════════════════════════════════════════════════════════════════════════

const BASE_URL = "https://deep-index.moralis.io/api/v2.2";

// Export for use by solana-api.ts
export function getHealthyMoralisKey(): string | null {
  const keyInfo = getNextKey();
  return keyInfo?.key || null;
}

async function moralisRequest<T>(
  endpoint: string,
  method: string,
  params?: Record<string, string>
): Promise<T | null> {
  const keyInfo = getNextKey();
  if (!keyInfo) {
    throw new Error("No Moralis keys available");
  }

  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const start = Date.now();
  
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "X-API-Key": keyInfo.key,
      },
    });

    const responseTime = Date.now() - start;

    if (!response.ok) {
      const errorText = await response.text();
      trackRequest(keyInfo, false, responseTime, method, `${response.status}: ${errorText.slice(0, 100)}`);
      logMoralisRequest(keyInfo.index, false, responseTime, method, errorText.slice(0, 80));
      
      // If this key failed due to quota, try next key
      if (response.status === 401 && errorText.includes('consumed')) {
        keyInfo.isHealthy = false;
        // Retry with next key
        const nextKey = getNextKey();
        if (nextKey && nextKey.index !== keyInfo.index && nextKey.isHealthy) {
          return moralisRequest<T>(endpoint, method, params);
        }
      }
      return null;
    }

    const data = await response.json();
    trackRequest(keyInfo, true, responseTime, method);
    logMoralisRequest(keyInfo.index, true, responseTime, method);
    return data as T;
  } catch (err: any) {
    const responseTime = Date.now() - start;
    trackRequest(keyInfo, false, responseTime, method, err?.message);
    logMoralisRequest(keyInfo.index, false, responseTime, method, err?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

interface MoralisTransfer {
  from_address: string;
  to_address: string;
  value: string;
  block_timestamp: string;
  block_number: string;
  transaction_hash: string;
}

interface MoralisTransfersResponse {
  result: MoralisTransfer[];
  cursor?: string;
}

export async function getTokenMetadata(
  tokenAddress: string,
  chain: ChainId
): Promise<TokenInfo> {
  await initMoralis();
  if (!initialized) return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };

  // Check cache first
  const cacheKey = `${chain}:${tokenAddress.toLowerCase()}`;
  const cached = getCached(metadataCache, cacheKey, METADATA_CACHE_TTL);
  if (cached) return cached;

  const data = await moralisRequest<any[]>(
    `/erc20/metadata`,
    "getTokenMetadata",
    { chain: chainId, addresses: tokenAddress }
  );

  if (data && data.length > 0) {
    const token = data[0];
    const result: TokenInfo = {
      symbol: token.symbol || "UNKNOWN",
      name: token.name || "Unknown Token",
      decimals: Number(token.decimals) || 18,
    };
    setCache(metadataCache, cacheKey, result);
    return result;
  }

  return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };
}

export async function getTokenPrice(
  tokenAddress: string,
  chain: ChainId
): Promise<number> {
  await initMoralis();
  if (!initialized) return 0;

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return 0;

  // Check cache first
  const cacheKey = `${chain}:${tokenAddress.toLowerCase()}`;
  const cached = getCached(priceCache, cacheKey, PRICE_CACHE_TTL);
  if (cached !== null) return cached;

  const data = await moralisRequest<any>(
    `/erc20/${tokenAddress}/price`,
    "getTokenPrice",
    { chain: chainId }
  );

  const price = data?.usdPrice || 0;
  setCache(priceCache, cacheKey, price);
  return price;
}

export async function getWalletTokenBalance(
  wallet: string,
  tokenAddress: string,
  chain: ChainId
): Promise<bigint> {
  await initMoralis();
  if (!initialized) return 0n;

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return 0n;

  const data = await moralisRequest<any[]>(
    `/${wallet}/erc20`,
    "getWalletTokenBalances",
    { chain: chainId, token_addresses: tokenAddress }
  );

  if (data && data.length > 0) {
    return BigInt(data[0].balance || "0");
  }
  return 0n;
}

export async function getWalletTransactionCount(
  wallet: string,
  chain: ChainId
): Promise<number> {
  await initMoralis();
  if (!initialized) return 0;

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return 0;

  const data = await moralisRequest<any>(
    `/${wallet}`,
    "getWalletTransactions",
    { chain: chainId, limit: "100" }
  );

  return data?.result?.length || 0;
}

export async function getWalletTokensTraded(
  wallet: string,
  chain: ChainId
): Promise<number> {
  await initMoralis();
  if (!initialized) return 0;

  const chainId = CHAIN_IDS[chain];
  if (!chainId) return 0;

  const data = await moralisRequest<any[]>(
    `/${wallet}/erc20`,
    "getWalletTokenBalances",
    { chain: chainId }
  );

  return data?.length || 0;
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
  
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return [];
  
  const fromDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  const swaps: SwapEvent[] = [];
  const chainConfig = CHAINS[chain];
  const tokenLower = tokenAddress.toLowerCase();
  
  // Collect all transfers first
  const allTransfers: Array<{from: string, to: string, amount: bigint, timestamp: number, blockNumber: number, txHash: string}> = [];
  const addressTransferCount = new Map<string, number>();

  let cursor: string | undefined;
  let pageCount = 0;
  const maxPages = 4;

  try {
    do {
      const params: Record<string, string> = {
        chain: chainId,
        from_date: fromDate.toISOString(),
        limit: "100",
      };
      if (cursor) params.cursor = cursor;

      const data = await moralisRequest<MoralisTransfersResponse>(
        `/erc20/${tokenAddress}/transfers`,
        "getTokenTransfers",
        params
      );

      if (!data || !data.result) break;

      for (const transfer of data.result) {
        const from = transfer.from_address.toLowerCase();
        const to = transfer.to_address.toLowerCase();
        const amount = BigInt(transfer.value || "0");
        const timestamp = Math.floor(new Date(transfer.block_timestamp).getTime() / 1000);
        const txHash = transfer.transaction_hash;
        const blockNumber = Number(transfer.block_number);

        // Skip mints/burns
        if (from === "0x0000000000000000000000000000000000000000") continue;
        if (to === "0x0000000000000000000000000000000000000000") continue;
        if (amount === 0n) continue;

        allTransfers.push({ from, to, amount, timestamp, blockNumber, txHash });
        
        // Count transfers per address
        addressTransferCount.set(from, (addressTransferCount.get(from) || 0) + 1);
        addressTransferCount.set(to, (addressTransferCount.get(to) || 0) + 1);
      }

      cursor = data.cursor;
      pageCount++;
      
      if (cursor) await new Promise(r => setTimeout(r, 100));
    } while (cursor && pageCount < maxPages);

    // Identify likely pair/pool contracts (addresses with many transfers)
    const likelyPairs = new Set<string>();
    for (const [addr, count] of addressTransferCount) {
      // If an address has 5+ transfers, it's likely a pair contract
      if (count >= 5) {
        likelyPairs.add(addr);
      }
    }

    // Now detect swaps: transfers FROM pair TO wallet = BUY
    const seenSwaps = new Set<string>();
    
    for (const t of allTransfers) {
      const fromIsPair = likelyPairs.has(t.from);
      const toIsPair = likelyPairs.has(t.to);
      const fromIsEOA = !likelyPairs.has(t.from) && addressTransferCount.get(t.from)! < 10;
      const toIsEOA = !likelyPairs.has(t.to) && addressTransferCount.get(t.to)! < 10;
      
      // BUY: from pair/contract → to EOA wallet
      if (fromIsPair && toIsEOA) {
        const key = `${t.txHash}-buy-${t.to}`;
        if (!seenSwaps.has(key)) {
          seenSwaps.add(key);
          swaps.push({
            txHash: t.txHash,
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
      
      // SELL: from EOA wallet → to pair/contract
      if (toIsPair && fromIsEOA) {
        const key = `${t.txHash}-sell-${t.from}`;
        if (!seenSwaps.has(key)) {
          seenSwaps.add(key);
          swaps.push({
            txHash: t.txHash + "-sell",
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

  } catch (err: any) {
    console.error(`Moralis fetchDexSwaps error: ${err?.message}`);
  }

  return swaps;
}

// Legacy function for compatibility
export async function getTokenTransfers(
  tokenAddress: string,
  chain: ChainId,
  fromDate?: Date
): Promise<SwapEvent[]> {
  return fetchDexSwapsViaMoralis(tokenAddress, chain, fromDate ? 
    Math.ceil((Date.now() - fromDate.getTime()) / (60 * 60 * 1000)) : 72);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS & MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

export function getMoralisStatus() {
  return keyPool.map(k => ({
    index: k.index,
    healthy: k.isHealthy,
    dailyRequests: k.dailyRequests,
    dailyCU: k.dailyCU,
    dailyLimit: DAILY_LIMIT,
    cuUsed: `${((k.dailyCU / DAILY_LIMIT) * 100).toFixed(1)}%`,
    avgMs: Math.round(k.avgResponseTime),
    error: k.lastError?.slice(0, 50),
  }));
}

export function isMoralisConfigured(): boolean {
  return keyPool.length > 0 || !!ENV.MORALIS_API_KEY || !!process.env.MORALIS_API_KEYS;
}
