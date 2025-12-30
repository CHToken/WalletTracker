// src/moralis-api.ts
// Uses Moralis API for reliable blockchain data (free tier: 40k requests/day)

import Moralis from "moralis";
import { EvmChain } from "@moralisweb3/common-evm-utils";
import { ENV, CHAINS, ChainId } from "./appConfig";
import { SwapEvent, TokenInfo } from "./types";

let initialized = false;

// EVM chains only - Solana uses separate API
const MORALIS_CHAIN_MAP: Record<string, EvmChain> = {
  eth: EvmChain.ETHEREUM,
  bsc: EvmChain.BSC,
};

export async function initMoralis(): Promise<void> {
  if (initialized) return;
  
  if (!ENV.MORALIS_API_KEY) {
    throw new Error("MORALIS_API_KEY not set in .env - get one at https://admin.moralis.io/");
  }

  await Moralis.start({ apiKey: ENV.MORALIS_API_KEY });
  initialized = true;
  console.log("✅ Moralis initialized");
}

export async function getTokenTransfers(
  tokenAddress: string,
  chain: ChainId,
  fromDate?: Date
): Promise<SwapEvent[]> {
  await initMoralis();
  
  const swaps: SwapEvent[] = [];
  const evmChain = MORALIS_CHAIN_MAP[chain];
  const chainConfig = CHAINS[chain];
  const dexRouters = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));

  try {
    const response = await Moralis.EvmApi.token.getTokenTransfers({
      chain: evmChain,
      address: tokenAddress,
      fromDate: fromDate,
      limit: 100,
    });

    for (const transfer of response.result) {
      const from = transfer.fromAddress.lowercase;
      const to = transfer.toAddress.lowercase;
      const amount = BigInt(transfer.value.toString());
      const timestamp = Math.floor(new Date(transfer.blockTimestamp).getTime() / 1000);
      const txHash = transfer.transactionHash;

      // BUY: Token received from DEX router
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

      // SELL: Token sent to DEX router
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
    console.error(`Moralis error for ${tokenAddress}:`, err?.message);
  }

  return swaps;
}

export async function getWalletTokenBalance(
  wallet: string,
  tokenAddress: string,
  chain: ChainId
): Promise<bigint> {
  await initMoralis();

  try {
    const response = await Moralis.EvmApi.token.getWalletTokenBalances({
      chain: MORALIS_CHAIN_MAP[chain],
      address: wallet,
      tokenAddresses: [tokenAddress],
    });

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

  try {
    const response = await Moralis.EvmApi.token.getTokenMetadata({
      chain: MORALIS_CHAIN_MAP[chain],
      addresses: [tokenAddress],
    });

    if (response.result.length > 0) {
      const token = response.result[0].token;
      return {
        symbol: token.symbol || "UNKNOWN",
        name: token.name || "Unknown Token",
        decimals: Number(token.decimals) || 18,
      };
    }
  } catch {
    // Fall through to default
  }

  return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };
}

export async function getWalletTransactionCount(
  wallet: string,
  chain: ChainId
): Promise<number> {
  await initMoralis();

  try {
    const response = await Moralis.EvmApi.transaction.getWalletTransactions({
      chain: MORALIS_CHAIN_MAP[chain],
      address: wallet,
      limit: 100,
    });

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

  try {
    const response = await Moralis.EvmApi.token.getWalletTokenBalances({
      chain: MORALIS_CHAIN_MAP[chain],
      address: wallet,
    });

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

  try {
    const response = await Moralis.EvmApi.token.getTokenPrice({
      chain: MORALIS_CHAIN_MAP[chain],
      address: tokenAddress,
    });

    return response.result.usdPrice || 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch DEX swaps for a token using Moralis API
 * Detects swaps by analyzing token transfer patterns
 */
export async function fetchDexSwapsViaMoralis(
  tokenAddress: string,
  chain: ChainId,
  hoursBack: number = 72
): Promise<SwapEvent[]> {
  await initMoralis();
  
  const fromDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  const swaps: SwapEvent[] = [];
  const evmChain = MORALIS_CHAIN_MAP[chain];
  const chainConfig = CHAINS[chain];
  const dexRouters = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));
  const tokenLower = tokenAddress.toLowerCase();

  // Known pair addresses we discover during scanning
  const knownPairs = new Set<string>();
  
  // Track transactions to group transfers
  const txTransfers = new Map<string, Array<{from: string, to: string, amount: bigint, timestamp: number, blockNumber: number}>>();

  let cursor: string | undefined;
  let pageCount = 0;
  const maxPages = 10;

  try {
    // First pass: collect all transfers and identify pairs
    do {
      const response = await Moralis.EvmApi.token.getTokenTransfers({
        chain: evmChain,
        address: tokenAddress,
        fromDate: fromDate,
        limit: 100,
        cursor: cursor,
      });

      for (const transfer of response.result) {
        const from = transfer.fromAddress.lowercase;
        const to = transfer.toAddress.lowercase;
        const amount = BigInt(transfer.value.toString());
        const timestamp = Math.floor(new Date(transfer.blockTimestamp).getTime() / 1000);
        const txHash = transfer.transactionHash;
        const blockNumber = Number(transfer.blockNumber);

        // Skip mints/burns
        if (from === "0x0000000000000000000000000000000000000000") continue;
        if (to === "0x0000000000000000000000000000000000000000") continue;
        if (amount === 0n) continue;

        // Group by transaction
        const existing = txTransfers.get(txHash) || [];
        existing.push({ from, to, amount, timestamp, blockNumber });
        txTransfers.set(txHash, existing);
      }

      cursor = response.pagination?.cursor;
      pageCount++;
      
      if (cursor) {
        await new Promise(r => setTimeout(r, 200));
      }
    } while (cursor && pageCount < maxPages);

    // Second pass: analyze transactions to identify swaps
    // In a swap, there are typically multiple transfers in the same tx
    // Pattern: User -> Pair (sell) or Pair -> User (buy)
    
    const seenSwaps = new Set<string>();
    
    for (const [txHash, transfers] of txTransfers) {
      // If there's only one transfer, it might still be a swap if it involves a router
      // If there are multiple transfers, look for the user's transfer
      
      for (const t of transfers) {
        const fromIsRouter = dexRouters.has(t.from);
        const toIsRouter = dexRouters.has(t.to);
        
        // Direct router interaction
        if (fromIsRouter && !toIsRouter) {
          // BUY: Router/Pair sends token to user
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
          // SELL: User sends token to router/pair
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
        
        // For multi-transfer transactions, identify pair contracts
        // A pair contract typically appears in multiple transfers within the same tx
        if (transfers.length > 1) {
          // Count how many times each address appears
          const addressCounts = new Map<string, number>();
          for (const tr of transfers) {
            addressCounts.set(tr.from, (addressCounts.get(tr.from) || 0) + 1);
            addressCounts.set(tr.to, (addressCounts.get(tr.to) || 0) + 1);
          }
          
          // Addresses appearing multiple times are likely pairs
          for (const [addr, count] of addressCounts) {
            if (count >= 2 && !dexRouters.has(addr)) {
              knownPairs.add(addr);
            }
          }
        }
      }
    }
    
    // Third pass: check transfers involving discovered pairs
    for (const [txHash, transfers] of txTransfers) {
      for (const t of transfers) {
        const fromIsPair = knownPairs.has(t.from);
        const toIsPair = knownPairs.has(t.to);
        const fromIsRouter = dexRouters.has(t.from);
        const toIsRouter = dexRouters.has(t.to);
        
        // Skip if already processed via router
        if (fromIsRouter || toIsRouter) continue;
        
        if (fromIsPair && !toIsPair) {
          // BUY: Pair sends token to user
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
          // SELL: User sends token to pair
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
    console.error(`Moralis fetchDexSwaps error:`, err?.message);
  }

  console.log(`   [Moralis] Discovered ${knownPairs.size} pair contracts, found ${swaps.length} swaps`);
  return swaps;
}

export function isMoralisConfigured(): boolean {
  return !!ENV.MORALIS_API_KEY;
}
