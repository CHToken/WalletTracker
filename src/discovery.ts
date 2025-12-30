// src/discovery.ts
// Auto-discovers tokens from DEX swaps on ETH and BSC

import { ethers } from "ethers";
import { getProvider } from "./providers";
import { CHAINS, ChainId } from "./appConfig";
import { DiscoveredToken } from "./types";

// Event signatures
const SWAP_V2_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_V3_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const PAIR_CREATED_V2 = ethers.id("PairCreated(address,address,address,uint256)");

// Factory addresses (EVM chains only - Solana uses different discovery)
const FACTORIES: Record<ChainId, string[]> = {
  eth: [
    "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2
    "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3
  ],
  bsc: [
    "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", // PancakeSwap V2
    "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", // PancakeSwap V3
  ],
  sol: [], // Solana uses different discovery via Moralis API
};

// Base tokens to filter out
const BASE_TOKENS: Record<ChainId, Set<string>> = {
  eth: new Set([
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
  ]),
  bsc: new Set([
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
    "0x55d398326f99059ff775485246999027b3197955", // USDT
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  ]),
  sol: new Set([
    "So11111111111111111111111111111111111111112", // Wrapped SOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  ]),
};

// Track discovered tokens
const discoveredTokens = new Map<string, DiscoveredToken>();

/**
 * Watch for new token pairs being created
 */
export async function watchNewPairs(
  chain: ChainId,
  onNewToken: (token: DiscoveredToken) => void
): Promise<void> {
  const provider = await getProvider(chain);
  const factories = FACTORIES[chain];
  const baseTokens = BASE_TOKENS[chain];

  console.log(`👀 [${CHAINS[chain].name}] Watching for new pairs...`);

  for (const factory of factories) {
    const filter = {
      address: factory,
      topics: [PAIR_CREATED_V2],
    };

    provider.on(filter, async (log) => {
      try {
        const token0 = "0x" + log.topics[1].slice(26).toLowerCase();
        const token1 = "0x" + log.topics[2].slice(26).toLowerCase();
        const pairAddress = "0x" + log.data.slice(26, 66).toLowerCase();

        const newToken = baseTokens.has(token0) ? token1 : token0;
        const key = `${chain}_${newToken}`;

        if (!baseTokens.has(newToken) && !discoveredTokens.has(key)) {
          const discovered: DiscoveredToken = {
            address: newToken,
            chain,
            pairAddress,
            firstSeen: Date.now(),
          };
          discoveredTokens.set(key, discovered);
          console.log(`🆕 [${CHAINS[chain].name}] New pair: ${newToken}`);
          onNewToken(discovered);
        }
      } catch {
        // Skip malformed logs
      }
    });
  }
}

/**
 * Discover tokens from recent swap activity (chunked for free RPC tiers)
 */
export async function discoverActiveTokens(
  chain: ChainId,
  blocksBack: number = 500
): Promise<string[]> {
  const provider = await getProvider(chain);
  const currentBlock = await provider.getBlockNumber();
  const baseTokens = BASE_TOKENS[chain];
  const dexRouters = new Set(CHAINS[chain].dexRouters.map(a => a.toLowerCase()));

  console.log(`🔍 [${CHAINS[chain].name}] Scanning recent blocks...`);

  const tokens = new Set<string>();

  try {
    // Chunk into small ranges to work with free RPC tiers
    const chunkSize = chain === "eth" ? 10 : 100; // Alchemy free = 10 blocks, BSC = 100
    const chunks: { from: number; to: number }[] = [];
    
    for (let i = 0; i < blocksBack; i += chunkSize) {
      const from = currentBlock - blocksBack + i;
      const to = Math.min(from + chunkSize - 1, currentBlock);
      chunks.push({ from, to });
    }

    // Only scan last few chunks to avoid rate limits
    const chunksToScan = chunks.slice(-5);

    for (const chunk of chunksToScan) {
      try {
        const [v2Logs, v3Logs] = await Promise.all([
          provider.getLogs({ fromBlock: chunk.from, toBlock: chunk.to, topics: [SWAP_V2_TOPIC] }),
          provider.getLogs({ fromBlock: chunk.from, toBlock: chunk.to, topics: [SWAP_V3_TOPIC] }),
        ]);

        const allLogs = [...v2Logs, ...v3Logs];
        const pairAddresses = new Set(allLogs.map(l => l.address.toLowerCase()));

        // Sample a few pairs per chunk
        const pairsToCheck = Array.from(pairAddresses).slice(0, 10);

        for (const pairAddr of pairsToCheck) {
          try {
            const pairContract = new ethers.Contract(
              pairAddr,
              ["function token0() view returns (address)", "function token1() view returns (address)"],
              provider
            );

            const [token0, token1] = await Promise.all([
              pairContract.token0().catch(() => null),
              pairContract.token1().catch(() => null),
            ]);

            if (token0) {
              const t0 = token0.toLowerCase();
              if (!baseTokens.has(t0) && !dexRouters.has(t0)) {
                tokens.add(t0);
              }
            }
            if (token1) {
              const t1 = token1.toLowerCase();
              if (!baseTokens.has(t1) && !dexRouters.has(t1)) {
                tokens.add(t1);
              }
            }
          } catch {
            // Skip unreadable pairs
          }
        }

        // Small delay between chunks
        await new Promise(r => setTimeout(r, 500));
      } catch (err: any) {
        // Skip failed chunks silently
      }
    }
  } catch (err: any) {
    console.error(`Error discovering tokens on ${chain}:`, err?.message);
  }

  console.log(`   Discovered ${tokens.size} tokens`);
  return Array.from(tokens);
}

export function getDiscoveredTokens(): Map<string, DiscoveredToken> {
  return discoveredTokens;
}
