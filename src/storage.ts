// src/storage.ts
import { getAccumulatorsCollection } from "./providers";
import { WalletAnalysis } from "./types";
import { ChainId } from "./appConfig";

export async function saveAccumulator(analysis: WalletAnalysis): Promise<void> {
  const collection = getAccumulatorsCollection();
  if (!collection) return;

  await collection.updateOne(
    { 
      wallet: analysis.wallet.toLowerCase(), 
      tokenAddress: analysis.tokenAddress.toLowerCase(),
      chain: analysis.chain,
    },
    {
      $set: {
        ...analysis,
        wallet: analysis.wallet.toLowerCase(),
        tokenAddress: analysis.tokenAddress.toLowerCase(),
        totalTokens: analysis.totalTokens.toString(),
        currentBalance: analysis.currentBalance.toString(),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

export async function hasBeenAlerted(
  wallet: string, 
  tokenAddress: string,
  chain: ChainId
): Promise<boolean> {
  const collection = getAccumulatorsCollection();
  if (!collection) return false;

  const existing = await collection.findOne({
    wallet: wallet.toLowerCase(),
    tokenAddress: tokenAddress.toLowerCase(),
    chain,
    alertedAt: { $exists: true },
  });

  return !!existing;
}

export async function markAsAlerted(
  wallet: string, 
  tokenAddress: string,
  chain: ChainId
): Promise<void> {
  const collection = getAccumulatorsCollection();
  if (!collection) return;

  await collection.updateOne(
    { 
      wallet: wallet.toLowerCase(), 
      tokenAddress: tokenAddress.toLowerCase(),
      chain,
    },
    { $set: { alertedAt: new Date() } }
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMIT PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

interface RateLimitData {
  providerId: string;
  dailyRequests: number;
  monthlyRequests: number;
  lastResetDay: number;
  lastResetMonth: number;
  updatedAt: Date;
}

let rateLimitsCollection: any = null;

export function setRateLimitsCollection(collection: any): void {
  rateLimitsCollection = collection;
}

export async function saveRateLimits(limits: RateLimitData[]): Promise<void> {
  if (!rateLimitsCollection) return;

  const bulkOps = limits.map(limit => ({
    updateOne: {
      filter: { providerId: limit.providerId },
      update: {
        $set: {
          dailyRequests: limit.dailyRequests,
          monthlyRequests: limit.monthlyRequests,
          lastResetDay: limit.lastResetDay,
          lastResetMonth: limit.lastResetMonth,
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  if (bulkOps.length > 0) {
    await rateLimitsCollection.bulkWrite(bulkOps);
  }
}

export async function loadRateLimits(): Promise<Map<string, RateLimitData>> {
  const limits = new Map<string, RateLimitData>();
  if (!rateLimitsCollection) return limits;

  const now = new Date();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth();

  const docs = await rateLimitsCollection.find({}).toArray();
  
  for (const doc of docs) {
    // Reset counters if day/month changed
    let dailyRequests = doc.dailyRequests || 0;
    let monthlyRequests = doc.monthlyRequests || 0;
    
    if (doc.lastResetDay !== currentDay) {
      dailyRequests = 0;
    }
    if (doc.lastResetMonth !== currentMonth) {
      monthlyRequests = 0;
    }

    limits.set(doc.providerId, {
      providerId: doc.providerId,
      dailyRequests,
      monthlyRequests,
      lastResetDay: currentDay,
      lastResetMonth: currentMonth,
      updatedAt: doc.updatedAt,
    });
  }

  return limits;
}

export async function getRateLimitsSummary(): Promise<{ provider: string; daily: number; monthly: number }[]> {
  if (!rateLimitsCollection) return [];

  const docs = await rateLimitsCollection.find({}).toArray();
  return docs.map((doc: any) => ({
    provider: doc.providerId,
    daily: doc.dailyRequests || 0,
    monthly: doc.monthlyRequests || 0,
  }));
}
