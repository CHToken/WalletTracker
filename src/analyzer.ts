// src/analyzer.ts
import { CONFIG, ChainId } from "./appConfig";
import { TokenBuy, WalletAnalysis, SwapEvent } from "./types";
import {
  isContract,
  getTokenBalance,
  getUniqueTokensTraded,
  getWalletTxCount,
} from "./blockchain";
import {
  getSolanaTokenBalance,
  getSolanaUniqueTokensTraded,
  getSolanaWalletTxCount,
  isSolanaProgram,
} from "./solana-api";

export async function analyzeWallet(
  wallet: string,
  tokenAddress: string,
  buys: TokenBuy[],
  sells: SwapEvent[],
  chain: ChainId = "eth"
): Promise<WalletAnalysis> {
  const failureReasons: string[] = [];
  const tokenLower = tokenAddress.toLowerCase();
  const walletLower = wallet.toLowerCase();

  // Basic buy stats
  const buyCount = buys.length;
  const totalUSD = buys.reduce((sum, b) => sum + b.amountUSD, 0);
  const totalTokens = buys.reduce((sum, b) => sum + b.amountToken, 0n);
  const buyTimings = buys.map(b => b.timestamp).sort((a, b) => a - b);
  const firstBuyTimestamp = buyTimings[0] ?? 0;
  const lastBuyTimestamp = buyTimings[buyTimings.length - 1] ?? 0;

  // Check for sells within the evaluation window
  const relevantSells = sells.filter(
    s => s.wallet.toLowerCase() === walletLower && !s.isBuy
  );
  const hasSold = relevantSells.length > 0;
  const lastSellTimestamp = hasSold
    ? Math.max(...relevantSells.map(s => s.timestamp))
    : null;

  // Get current on-chain balance
  let currentBalance: bigint;
  let walletIsContract: boolean;
  let uniqueTokensTraded: number;
  let totalTxCount: number;

  if (chain === "sol") {
    // Solana-specific calls
    currentBalance = await getSolanaTokenBalance(wallet, tokenAddress);
    walletIsContract = await isSolanaProgram(wallet);
    uniqueTokensTraded = await getSolanaUniqueTokensTraded(wallet);
    totalTxCount = await getSolanaWalletTxCount(wallet);
  } else {
    // EVM chains
    currentBalance = await getTokenBalance(tokenAddress, wallet, chain);
    walletIsContract = await isContract(wallet, chain);
    uniqueTokensTraded = await getUniqueTokensTraded(wallet, chain);
    totalTxCount = await getWalletTxCount(wallet, chain);
  }

  const balanceRetentionPercent = totalTokens > 0n
    ? Number((currentBalance * 100n) / totalTokens)
    : 0;
  const walletAgeSeconds = Math.floor(Date.now() / 1000) - firstBuyTimestamp;
  const walletAgeDays = Math.max(1, walletAgeSeconds / 86400);
  const avgTxPerDay = totalTxCount / walletAgeDays;

  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDATION CHECKS (ALL must pass)
  // ═══════════════════════════════════════════════════════════════════════════

  // 1. Minimum buy count (≥5 buys)
  if (buyCount < CONFIG.MIN_BUY_COUNT) {
    failureReasons.push(`Buy count ${buyCount} < ${CONFIG.MIN_BUY_COUNT}`);
  }

  // 2. Cumulative USD value (≥$10,000)
  if (totalUSD < CONFIG.MIN_CUMULATIVE_USD) {
    failureReasons.push(`Total USD $${totalUSD.toFixed(2)} < $${CONFIG.MIN_CUMULATIVE_USD}`);
  }

  // 3. Anti-bot timing checks
  if (buyTimings.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < buyTimings.length; i++) {
      intervals.push((buyTimings[i] - buyTimings[i - 1]) / 60); // minutes
    }

    // Check minimum spacing between buys (≥10 minutes)
    const minInterval = Math.min(...intervals);
    if (minInterval < CONFIG.MIN_BUY_SPACING_MINUTES) {
      failureReasons.push(`Buy spacing ${minInterval.toFixed(1)}min < ${CONFIG.MIN_BUY_SPACING_MINUTES}min (bot-like)`);
    }

    // Check for clustered buys in same hour
    const hourBuckets = new Map<number, number>();
    for (const ts of buyTimings) {
      const hourKey = Math.floor(ts / 3600);
      hourBuckets.set(hourKey, (hourBuckets.get(hourKey) ?? 0) + 1);
    }
    const maxBuysInHour = Math.max(...hourBuckets.values());
    if (maxBuysInHour > CONFIG.MAX_BUYS_PER_HOUR) {
      failureReasons.push(`${maxBuysInHour} buys in single hour (bot-like)`);
    }

    // Check for fixed periodicity (bot pattern)
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev < 1 && intervals.length >= 3) {
      failureReasons.push(`Fixed buy periodicity detected (stdDev=${stdDev.toFixed(2)}min)`);
    }
  }

  // 4. No-sell conviction check (72h hold after last buy)
  if (hasSold && lastSellTimestamp) {
    // If they sold, check if it was within the no-sell window
    if (lastSellTimestamp > lastBuyTimestamp) {
      const hoursBetweenBuyAndSell = (lastSellTimestamp - lastBuyTimestamp) / 3600;
      if (hoursBetweenBuyAndSell < CONFIG.NO_SELL_HOURS) {
        failureReasons.push(`Sold ${hoursBetweenBuyAndSell.toFixed(1)}h after last buy (need ${CONFIG.NO_SELL_HOURS}h hold)`);
      }
    }
  }

  // 5. Balance retention check (≥90% of tokens still held)
  if (balanceRetentionPercent < CONFIG.MIN_BALANCE_RETENTION_PERCENT) {
    failureReasons.push(`Balance retention ${balanceRetentionPercent}% < ${CONFIG.MIN_BALANCE_RETENTION_PERCENT}% (possible indirect exit)`);
  }

  // 6. Must be EOA (not a contract)
  if (walletIsContract) {
    failureReasons.push("Wallet is a smart contract (not EOA)");
  }

  // 7. Token diversity filter (not trading too many tokens)
  if (uniqueTokensTraded > CONFIG.MAX_UNIQUE_TOKENS_TRADED) {
    failureReasons.push(`Trades ${uniqueTokensTraded} different tokens (max ${CONFIG.MAX_UNIQUE_TOKENS_TRADED})`);
  }

  // 8. Transaction frequency filter (not high-frequency)
  if (avgTxPerDay > CONFIG.MAX_TX_PER_DAY) {
    failureReasons.push(`${avgTxPerDay.toFixed(1)} tx/day average (max ${CONFIG.MAX_TX_PER_DAY})`);
  }

  return {
    wallet,
    tokenAddress: tokenLower,
    chain,
    buyCount,
    totalUSD,
    totalTokens,
    currentBalance,
    balanceRetentionPercent,
    firstBuyTimestamp,
    lastBuyTimestamp,
    hasSold,
    lastSellTimestamp,
    isContract: walletIsContract,
    uniqueTokensTraded,
    avgTxPerDay,
    buyTimings,
    isValidAccumulator: failureReasons.length === 0,
    failureReasons,
  };
}
