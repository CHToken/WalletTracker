// src/providers.ts
import { ethers } from "ethers";
import { Telegraf } from "telegraf";
import { MongoClient, Db, Collection } from "mongodb";
import { ENV, ChainId } from "./appConfig";
import { 
  initRpcManager, 
  getProvider as getRpcProvider, 
  getWsProvider as getRpcWsProvider,
  executeWithFailover,
  executeBatch,
  getRpcStatus,
  getRpcDetailedStatus,
  shutdownRpcManager,
  loadPersistedRateLimits,
  persistRateLimits
} from "./rpc-manager";
import {
  getStats as getRpcStats,
  getRecentLogs,
  printStats,
  closeLogger
} from "./rpc-logger";
import { getMoralisStatus } from "./moralis-api";
import { setRateLimitsCollection, loadRateLimits, saveRateLimits } from "./storage";

let bot: Telegraf | null = null;
let mongoClient: MongoClient | null = null;
let db: Db | null = null;
let swapsCollection: Collection | null = null;
let accumulatorsCollection: Collection | null = null;
let rateLimitsCollection: Collection | null = null;
let rpcInitialized = false;
let rateLimitPersistInterval: NodeJS.Timeout | null = null;

export async function initProviders(): Promise<void> {
  if (!rpcInitialized) {
    await initRpcManager();
    rpcInitialized = true;
  }
}

export async function getProvider(chain: ChainId = "eth"): Promise<ethers.JsonRpcProvider> {
  if (chain === "sol") {
    throw new Error("Use Solana-specific functions for Solana chain");
  }
  if (!rpcInitialized) await initProviders();
  return getRpcProvider(chain);
}

export async function getWsProvider(chain: ChainId): Promise<ethers.WebSocketProvider | null> {
  if (chain === "sol") return null;
  if (!rpcInitialized) await initProviders();
  return getRpcWsProvider(chain);
}

export async function withFailover<T>(
  chain: ChainId,
  operation: (provider: ethers.JsonRpcProvider) => Promise<T>
): Promise<T> {
  if (!rpcInitialized) await initProviders();
  return executeWithFailover(chain, operation);
}

export async function withBatch<T>(
  chain: ChainId,
  operations: Array<(provider: ethers.JsonRpcProvider) => Promise<T>>,
  concurrency: number = 5
): Promise<T[]> {
  if (!rpcInitialized) await initProviders();
  return executeBatch(chain, operations, concurrency);
}

export function getProviderStatus() {
  return getRpcStatus();
}

export function getProviderDetailedStatus() {
  return getRpcDetailedStatus();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING & STATS
// ═══════════════════════════════════════════════════════════════════════════════

export function getRequestStats() {
  return getRpcStats();
}

export function getRequestLogs(count: number = 50) {
  return getRecentLogs(count);
}

export function printRequestStats() {
  printStats();
}

export function getAllProviderStatus() {
  return {
    rpc: getRpcDetailedStatus(),
    moralis: getMoralisStatus(),
    stats: getRpcStats(),
  };
}

export function getTelegramBot(): Telegraf | null {
  if (!bot && ENV.TELEGRAM_TOKEN && ENV.TELEGRAM_CHANNEL_ID) {
    bot = new Telegraf(ENV.TELEGRAM_TOKEN);
    console.log("✅ Telegram bot initialized");
  }
  return bot;
}

export async function initMongo(): Promise<void> {
  if (!ENV.MONGO_URL) {
    console.warn("⚠️ MongoDB URL not set");
    return;
  }
  if (mongoClient) return;

  mongoClient = new MongoClient(ENV.MONGO_URL);
  await mongoClient.connect();
  db = mongoClient.db("blockchain");
  swapsCollection = db.collection("token_swaps");
  accumulatorsCollection = db.collection("accumulators");
  rateLimitsCollection = db.collection("rate_limits");

  await swapsCollection.createIndex({ tokenAddress: 1, wallet: 1, timestamp: -1 });
  await swapsCollection.createIndex({ txHash: 1 }, { unique: true });
  await accumulatorsCollection.createIndex({ wallet: 1, tokenAddress: 1, chain: 1 }, { unique: true });
  await rateLimitsCollection.createIndex({ providerId: 1 }, { unique: true });

  // Set collection reference for storage module
  setRateLimitsCollection(rateLimitsCollection);

  // Load persisted rate limits into RPC manager
  const persistedLimits = await loadRateLimits();
  if (persistedLimits.size > 0) {
    loadPersistedRateLimits(persistedLimits);
    console.log(`📊 Loaded ${persistedLimits.size} rate limit records from DB`);
  }

  // Persist rate limits every 60 seconds
  rateLimitPersistInterval = setInterval(async () => {
    try {
      const limits = persistRateLimits();
      await saveRateLimits(limits);
    } catch (err) {
      // Silent fail
    }
  }, 60000);

  console.log("✅ MongoDB initialized");
}

export function getSwapsCollection(): Collection | null {
  return swapsCollection;
}

export function getAccumulatorsCollection(): Collection | null {
  return accumulatorsCollection;
}

export async function closeMongo(): Promise<void> {
  if (rateLimitPersistInterval) {
    clearInterval(rateLimitPersistInterval);
    rateLimitPersistInterval = null;
  }
  // Final persist before closing
  if (rateLimitsCollection) {
    try {
      const limits = persistRateLimits();
      await saveRateLimits(limits);
    } catch (err) {
      // Silent fail
    }
  }
  await mongoClient?.close();
  mongoClient = null;
  db = null;
}

export function shutdown(): void {
  shutdownRpcManager();
  closeLogger();
  closeMongo();
}
