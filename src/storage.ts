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
