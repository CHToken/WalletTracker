// src/detector.ts
import { CONFIG, ChainId, CHAINS } from "./appConfig";
import { TokenBuy, WalletAnalysis, SwapEvent } from "./types";
import { getProvider, initMongo, getTelegramBot } from "./providers";
import {
  getTokenInfo,
  fetchDexSwapsForToken,
  calculateSwapUSD,
} from "./blockchain";
import {
  isMoralisConfigured,
  initMoralis,
  fetchDexSwapsViaMoralis,
  getTokenMetadata,
  getTokenPrice,
} from "./moralis-api";
import {
  fetchSolanaSwaps,
  getSolanaTokenMetadata,
  getSolanaTokenPrice,
} from "./solana-api";
import { analyzeWallet } from "./analyzer";
import { sendAccumulatorAlert } from "./telegram";
import { saveAccumulator, hasBeenAlerted, markAsAlerted } from "./storage";
import { sleep } from "./utils";

// Use Moralis if configured, otherwise fall back to RPC
const USE_MORALIS = isMoralisConfigured();
const DEBUG = !!process.env.DEBUG_RPC;

export async function detectAccumulators(
  tokenAddress: string,
  chain: ChainId = "eth"
): Promise<WalletAnalysis[]> {
  const chainName = CHAINS[chain].name;
  console.log(`\n🔍 [${chainName}] Analyzing: ${tokenAddress}`);

  // Handle Solana separately
  if (chain === "sol") {
    return detectSolanaAccumulators(tokenAddress);
  }

  // Initialize Moralis if configured
  if (USE_MORALIS) {
    await initMoralis();
    console.log(`   Using Moralis API for data fetching`);
  }

  const tokenInfo = USE_MORALIS 
    ? await getTokenMetadata(tokenAddress, chain)
    : await getTokenInfo(tokenAddress, chain);
  console.log(`   Token: ${tokenInfo.name} (${tokenInfo.symbol})`);

  let allSwaps: SwapEvent[];

  if (USE_MORALIS) {
    console.log(`   Fetching swaps via Moralis (${CONFIG.EVALUATION_WINDOW_HOURS}h window)...`);
    allSwaps = await fetchDexSwapsViaMoralis(tokenAddress, chain, CONFIG.EVALUATION_WINDOW_HOURS);
  } else {
    const provider = await getProvider(chain);
    const currentBlock = await provider.getBlockNumber();
    const blocksPerHour = chain === "bsc" ? 1200 : 300;
    const windowBlocks = CONFIG.EVALUATION_WINDOW_HOURS * blocksPerHour;
    const fromBlock = currentBlock - windowBlocks;

    console.log(`   Scanning blocks ${fromBlock} to ${currentBlock} (${CONFIG.EVALUATION_WINDOW_HOURS}h window)...`);
    allSwaps = await fetchDexSwapsForToken(tokenAddress, fromBlock, currentBlock, chain);
  }

  console.log(`   Found ${allSwaps.length} DEX swap events`);

  if (allSwaps.length === 0) {
    console.log(`   No swap activity found`);
    return [];
  }

  // Group by wallet
  const walletBuys = new Map<string, SwapEvent[]>();
  const walletSells = new Map<string, SwapEvent[]>();

  for (const swap of allSwaps) {
    const walletLower = swap.wallet.toLowerCase();
    if (swap.isBuy) {
      const existing = walletBuys.get(walletLower) ?? [];
      existing.push(swap);
      walletBuys.set(walletLower, existing);
    } else {
      const existing = walletSells.get(walletLower) ?? [];
      existing.push(swap);
      walletSells.set(walletLower, existing);
    }
  }

  console.log(`   Unique wallets with buys: ${walletBuys.size}`);

  // Pre-filter: wallets with minimum buy count
  const candidateWallets = Array.from(walletBuys.entries())
    .filter(([_, buys]) => buys.length >= CONFIG.MIN_BUY_COUNT)
    .map(([wallet]) => wallet);

  console.log(`   Candidates with ≥${CONFIG.MIN_BUY_COUNT} buys: ${candidateWallets.length}`);

  if (candidateWallets.length === 0) {
    return [];
  }

  const validAccumulators: WalletAnalysis[] = [];

  // Cache token price once per token analysis (not per buy)
  let cachedTokenPrice: number | null = null;
  if (USE_MORALIS) {
    cachedTokenPrice = await getTokenPrice(tokenAddress, chain);
  }

  for (const wallet of candidateWallets) {
    const swapEvents = walletBuys.get(wallet) ?? [];

    const buys: TokenBuy[] = [];
    let totalUSDEstimate = 0;

    for (const swap of swapEvents) {
      let usdValue: number;
      
      if (USE_MORALIS && cachedTokenPrice !== null) {
        const tokenAmountDecimal = Number(swap.amountOut) / Math.pow(10, tokenInfo.decimals);
        usdValue = tokenAmountDecimal * cachedTokenPrice;
      } else {
        usdValue = await calculateSwapUSD(swap.txHash, tokenAddress, swap.amountOut, chain);
      }
      
      totalUSDEstimate += usdValue;

      buys.push({
        txHash: swap.txHash,
        wallet: swap.wallet,
        tokenAddress: tokenAddress.toLowerCase(),
        amountToken: swap.amountOut,
        amountUSD: usdValue,
        timestamp: swap.timestamp,
        blockNumber: swap.blockNumber,
      });

      await sleep(100);
    }

    // Quick pre-check: skip if total USD is way below threshold
    const preCheckThreshold = CONFIG.MIN_CUMULATIVE_USD * (CONFIG.PRE_CHECK_THRESHOLD_PERCENT / 100);
    if (totalUSDEstimate < preCheckThreshold) {
      if (DEBUG) {
        console.log(`   ⏭️ ${wallet} skipped: $${totalUSDEstimate.toFixed(0)} < $${preCheckThreshold.toFixed(0)} threshold`);
      }
      continue;
    }

    const sells = walletSells.get(wallet) ?? [];
    const analysis = await analyzeWallet(wallet, tokenAddress, buys, sells, chain);

    if (analysis.isValidAccumulator) {
      validAccumulators.push(analysis);
      console.log(`   ✅ ACCUMULATOR FOUND: ${wallet}`);
      console.log(`      Buys: ${analysis.buyCount} | Total: $${analysis.totalUSD.toFixed(2)} | Retention: ${analysis.balanceRetentionPercent}%`);
      console.log(`      Total Tx: ${analysis.totalDexTrades} | Unique Tokens: ${analysis.uniqueTokensTraded}`);
    } else {
      // Always show why candidates failed
      console.log(`   ❌ ${wallet} failed: ${analysis.failureReasons.join(', ')}`);
    }

    await sleep(200);
  }

  // Summary for this token
  if (candidateWallets.length > 0) {
    console.log(`   📊 Result: ${validAccumulators.length}/${candidateWallets.length} candidates passed all criteria`);
  }

  return validAccumulators;
}

export async function scanTokenForAccumulators(
  tokenAddress: string,
  chain: ChainId = "eth"
): Promise<WalletAnalysis[]> {
  const accumulators = await detectAccumulators(tokenAddress, chain);
  const tokenInfo = await getTokenInfo(tokenAddress, chain);

  for (const acc of accumulators) {
    await saveAccumulator(acc);

    const alerted = await hasBeenAlerted(acc.wallet, tokenAddress, chain);
    if (!alerted) {
      await sendAccumulatorAlert(acc, tokenInfo, chain);
      await markAsAlerted(acc.wallet, tokenAddress, chain);
    }
  }

  return accumulators;
}

export async function startAccumulationMonitor(
  tokenAddresses: { address: string; chain: ChainId }[]
): Promise<void> {
  const chains = new Set(tokenAddresses.map(t => t.chain));
  for (const chain of chains) {
    await getProvider(chain);
  }
  
  await initMongo();
  getTelegramBot();

  console.log(`\n🚀 Starting accumulation monitor`);
  console.log(`   Tokens: ${tokenAddresses.length}`);
  console.log(`   Chains: ${Array.from(chains).join(", ")}`);
  console.log(`   Scan interval: ${CONFIG.SCAN_INTERVAL_MS / 60000} min`);
  console.log(`   Evaluation window: ${CONFIG.EVALUATION_WINDOW_HOURS}h`);
  console.log(`   Min buys: ${CONFIG.MIN_BUY_COUNT}`);
  console.log(`   Min USD: $${CONFIG.MIN_CUMULATIVE_USD}`);

  for (const { address, chain } of tokenAddresses) {
    try {
      await scanTokenForAccumulators(address, chain);
    } catch (err: any) {
      console.error(`Error scanning ${address} on ${chain}:`, err?.message);
    }
    await sleep(5000);
  }

  setInterval(async () => {
    for (const { address, chain } of tokenAddresses) {
      try {
        await scanTokenForAccumulators(address, chain);
      } catch (err: any) {
        console.error(`Error scanning ${address} on ${chain}:`, err?.message);
      }
      await sleep(5000);
    }
  }, CONFIG.SCAN_INTERVAL_MS);
}

export async function scanOnce(tokenAddress: string, chain: ChainId = "eth"): Promise<void> {
  await getProvider(chain);
  await initMongo();
  getTelegramBot();

  const accumulators = await scanTokenForAccumulators(tokenAddress, chain);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`RESULTS: Found ${accumulators.length} valid accumulators`);
  console.log(`${"═".repeat(60)}\n`);

  for (const acc of accumulators) {
    console.log(`Wallet: ${acc.wallet}`);
    console.log(`  Chain: ${acc.chain}`);
    console.log(`  Buys: ${acc.buyCount} | Total: $${acc.totalUSD.toFixed(2)}`);
    console.log(`  Balance Retention: ${acc.balanceRetentionPercent}%`);
    console.log(`  Has Sold: ${acc.hasSold}`);
    console.log(`  Unique Tokens: ${acc.uniqueTokensTraded} | Total Tx: ${acc.totalDexTrades}`);
    console.log(`  Avg Tx/Day: ${acc.avgTxPerDay.toFixed(1)}`);
    if (acc.failureReasons.length > 0) {
      console.log(`  Issues: ${acc.failureReasons.join(", ")}`);
    }
    console.log("");
  }
}

async function detectSolanaAccumulators(tokenAddress: string): Promise<WalletAnalysis[]> {
  console.log(`   Using Moralis Solana API for data fetching`);

  const tokenInfo = await getSolanaTokenMetadata(tokenAddress);
  console.log(`   Token: ${tokenInfo.name} (${tokenInfo.symbol})`);

  console.log(`   Fetching swaps via Moralis (${CONFIG.EVALUATION_WINDOW_HOURS}h window)...`);
  const allSwaps = await fetchSolanaSwaps(tokenAddress, CONFIG.EVALUATION_WINDOW_HOURS);

  console.log(`   Found ${allSwaps.length} DEX swap events`);

  if (allSwaps.length === 0) {
    console.log(`   No swap activity found`);
    return [];
  }

  const walletBuys = new Map<string, SwapEvent[]>();
  const walletSells = new Map<string, SwapEvent[]>();

  for (const swap of allSwaps) {
    const walletLower = swap.wallet.toLowerCase();
    if (swap.isBuy) {
      const existing = walletBuys.get(walletLower) ?? [];
      existing.push(swap);
      walletBuys.set(walletLower, existing);
    } else {
      const existing = walletSells.get(walletLower) ?? [];
      existing.push(swap);
      walletSells.set(walletLower, existing);
    }
  }

  console.log(`   Unique wallets with buys: ${walletBuys.size}`);

  const candidateWallets = Array.from(walletBuys.entries())
    .filter(([_, buys]) => buys.length >= CONFIG.MIN_BUY_COUNT)
    .map(([wallet]) => wallet);

  console.log(`   Candidates with ≥${CONFIG.MIN_BUY_COUNT} buys: ${candidateWallets.length}`);

  if (candidateWallets.length === 0) {
    return [];
  }

  const validAccumulators: WalletAnalysis[] = [];

  for (const wallet of candidateWallets) {
    const swapEvents = walletBuys.get(wallet) ?? [];
    const buys: TokenBuy[] = [];
    let totalUSDEstimate = 0;

    const tokenPrice = await getSolanaTokenPrice(tokenAddress);

    for (const swap of swapEvents) {
      const tokenAmountDecimal = Number(swap.amountOut) / Math.pow(10, tokenInfo.decimals);
      const usdValue = tokenAmountDecimal * tokenPrice;
      totalUSDEstimate += usdValue;

      buys.push({
        txHash: swap.txHash,
        wallet: swap.wallet,
        tokenAddress: tokenAddress.toLowerCase(),
        amountToken: swap.amountOut,
        amountUSD: usdValue,
        timestamp: swap.timestamp,
        blockNumber: swap.blockNumber,
      });

      await sleep(50);
    }

    if (totalUSDEstimate < CONFIG.MIN_CUMULATIVE_USD * (CONFIG.PRE_CHECK_THRESHOLD_PERCENT / 100)) {
      if (DEBUG) {
        console.log(`   ⏭️ ${wallet} skipped: $${totalUSDEstimate.toFixed(0)} < threshold`);
      }
      continue;
    }

    const sells = walletSells.get(wallet) ?? [];
    const analysis = await analyzeWallet(wallet, tokenAddress, buys, sells, "sol");

    if (analysis.isValidAccumulator) {
      validAccumulators.push(analysis);
      console.log(`   ✅ ACCUMULATOR FOUND: ${wallet}`);
      console.log(`      Buys: ${analysis.buyCount} | Total: $${analysis.totalUSD.toFixed(2)} | Retention: ${analysis.balanceRetentionPercent}%`);
      console.log(`      Total Tx: ${analysis.totalDexTrades} | Unique Tokens: ${analysis.uniqueTokensTraded}`);
    } else {
      console.log(`   ❌ ${wallet} failed: ${analysis.failureReasons.join(', ')}`);
    }

    await sleep(200);
  }

  if (candidateWallets.length > 0) {
    console.log(`   📊 Result: ${validAccumulators.length}/${candidateWallets.length} candidates passed all criteria`);
  }

  return validAccumulators;
}
