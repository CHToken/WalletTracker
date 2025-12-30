// src/providers.ts
import { ethers, FetchRequest } from "ethers";
import { Telegraf } from "telegraf";
import { MongoClient, Db, Collection } from "mongodb";
import { ENV, CHAINS, ChainId } from "./appConfig";

// Provider instances per chain
const providers: Map<ChainId, ethers.JsonRpcProvider> = new Map();
let bot: Telegraf | null = null;
let mongoClient: MongoClient | null = null;
let db: Db | null = null;
let swapsCollection: Collection | null = null;
let accumulatorsCollection: Collection | null = null;

export async function getProvider(chain: ChainId = "eth"): Promise<ethers.JsonRpcProvider> {
  // Solana doesn't use ethers provider
  if (chain === "sol") {
    throw new Error("Use Solana-specific functions for Solana chain");
  }

  if (!providers.has(chain)) {
    const chainConfig = CHAINS[chain];
    const rpcUrl = ENV[chainConfig.rpcEnvKey as keyof typeof ENV] as string;
    
    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for ${chain}`);
    }
    
    const fetchReq = new FetchRequest(rpcUrl);
    fetchReq.timeout = 30000;
    const provider = new ethers.JsonRpcProvider(fetchReq);
    providers.set(chain, provider);
    console.log(`✅ ${chainConfig.name} provider initialized`);
  }
  return providers.get(chain)!;
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

  await swapsCollection.createIndex({ tokenAddress: 1, wallet: 1, timestamp: -1 });
  await swapsCollection.createIndex({ txHash: 1 }, { unique: true });
  await accumulatorsCollection.createIndex({ wallet: 1, tokenAddress: 1, chain: 1 }, { unique: true });

  console.log("✅ MongoDB initialized");
}

export function getSwapsCollection(): Collection | null {
  return swapsCollection;
}

export function getAccumulatorsCollection(): Collection | null {
  return accumulatorsCollection;
}

export async function closeMongo(): Promise<void> {
  await mongoClient?.close();
  mongoClient = null;
  db = null;
}
