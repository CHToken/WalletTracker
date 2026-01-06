// src/index.ts
import dotenv from "dotenv";
dotenv.config();

import { 
  getProvider, 
  initMongo, 
  initProviders,
  getTelegramBot, 
  printRequestStats,
  shutdown 
} from "./providers";
import { scanTokenForAccumulators } from "./detector";
import { discoverActiveTokens, watchNewPairs } from "./discovery";
import { discoverSolanaTokens } from "./solana-api";
import { CONFIG, ChainId, CHAINS, ENV } from "./appConfig";
import { DiscoveredToken } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Token queue for analysis
interface QueuedToken {
  address: string;
  chain: ChainId;
}

const tokenQueue: QueuedToken[] = [];
const analyzedTokens = new Set<string>();

function getTokenKey(address: string, chain: ChainId): string {
  return `${chain}_${address.toLowerCase()}`;
}

async function processQueue(): Promise<void> {
  while (tokenQueue.length > 0) {
    const token = tokenQueue.shift()!;
    const key = getTokenKey(token.address, token.chain);

    if (analyzedTokens.has(key)) continue;

    try {
      console.log(`\n📊 [${CHAINS[token.chain].name}] Analyzing: ${token.address}`);
      await scanTokenForAccumulators(token.address, token.chain);
      analyzedTokens.add(key);
    } catch (err: any) {
      console.error(`Error analyzing ${token.address}:`, err?.message);
    }

    await sleep(5000); // Rate limit
  }
}

async function main(): Promise<void> {
  console.log("🚀 Wallet Accumulation Tracker");
  console.log("═".repeat(50));
  console.log(`   Mode: Auto-Discovery (ETH + BSC + SOL)`);
  console.log(`   Evaluation window: ${CONFIG.EVALUATION_WINDOW_HOURS}h`);
  console.log(`   Min buys: ${CONFIG.MIN_BUY_COUNT}`);
  console.log(`   Min USD: $${CONFIG.MIN_CUMULATIVE_USD}`);
  console.log(`   Scan interval: ${CONFIG.SCAN_INTERVAL_MS / 60000} min`);
  console.log("");

  // Initialize
  await initProviders();
  await initMongo();
  getTelegramBot();

  const evmChains: ChainId[] = ["eth", "bsc"];

  // Initialize EVM providers
  for (const chain of evmChains) {
    try {
      await getProvider(chain);
    } catch (err: any) {
      console.warn(`⚠️ Could not connect to ${chain}: ${err?.message}`);
    }
  }

  // Discover tokens from recent activity on each chain
  console.log("\n🔍 Initial token discovery...");
  
  // EVM chains
  for (const chain of evmChains) {
    try {
      const tokens = await discoverActiveTokens(chain, 100);
      for (const address of tokens) {
        tokenQueue.push({ address, chain });
      }
      console.log(`   [${CHAINS[chain].name}] Queued ${tokens.length} tokens`);
    } catch (err: any) {
      console.warn(`   [${CHAINS[chain].name}] Discovery failed: ${err?.message}`);
    }
  }

  // Solana (requires Moralis API key)
  if (ENV.MORALIS_API_KEY || process.env.MORALIS_API_KEYS) {
    try {
      const solTokens = await discoverSolanaTokens();
      for (const address of solTokens) {
        tokenQueue.push({ address, chain: "sol" });
      }
      console.log(`   [Solana] Queued ${solTokens.length} tokens`);
    } catch (err: any) {
      console.warn(`   [Solana] Discovery failed: ${err?.message}`);
    }
  } else {
    console.log(`   [Solana] Skipped - MORALIS_API_KEY not set`);
  }

  // Watch for new tokens in real-time (EVM only)
  for (const chain of evmChains) {
    try {
      await watchNewPairs(chain, (newToken: DiscoveredToken) => {
        const key = getTokenKey(newToken.address, newToken.chain);
        if (!analyzedTokens.has(key)) {
          tokenQueue.push({ address: newToken.address, chain: newToken.chain });
          console.log(`   Queued new token: ${newToken.address} on ${CHAINS[newToken.chain].name}`);
        }
      });
    } catch (err: any) {
      console.warn(`   Could not watch ${chain} pairs: ${err?.message}`);
    }
  }

  // Process initial queue
  console.log(`\n📋 Processing ${tokenQueue.length} tokens...`);
  await processQueue();

  // Continuous re-scan
  setInterval(async () => {
    console.log(`\n🔄 Re-scanning ${analyzedTokens.size} tokens...`);

    for (const key of analyzedTokens) {
      const parts = key.split("_");
      const chain = parts[0] as ChainId;
      const address = parts[1];
      try {
        await scanTokenForAccumulators(address, chain);
      } catch (err: any) {
        console.error(`Error re-scanning ${address}:`, err?.message);
      }
      await sleep(3000);
    }

    // Discover new Solana tokens periodically
    if (ENV.MORALIS_API_KEY) {
      try {
        const solTokens = await discoverSolanaTokens();
        for (const address of solTokens) {
          const key = getTokenKey(address, "sol");
          if (!analyzedTokens.has(key)) {
            tokenQueue.push({ address, chain: "sol" });
          }
        }
      } catch (err: any) {
        // Silent fail for Solana discovery
      }
    }

    // Process any new tokens
    await processQueue();
    
    // Print RPC stats every scan cycle
    printRequestStats();

  }, CONFIG.SCAN_INTERVAL_MS);

  console.log("\n✅ Bot running - watching for accumulation patterns on ETH, BSC & SOL...");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

process.once("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  printRequestStats();
  shutdown();
  process.exit(0);
});
