// src/telegram.ts
import { getTelegramBot } from "./providers";
import { ENV, CONFIG, ChainId, CHAINS } from "./appConfig";
import { WalletAnalysis, TokenInfo } from "./types";

export async function sendAccumulatorAlert(
  analysis: WalletAnalysis,
  tokenInfo: TokenInfo,
  chain: ChainId = "eth"
): Promise<void> {
  const bot = getTelegramBot();
  if (!bot || !ENV.TELEGRAM_CHANNEL_ID) return;

  const chainConfig = CHAINS[chain];
  let explorerBase: string;
  
  if (chain === "sol") {
    explorerBase = "https://solscan.io";
  } else if (chain === "bsc") {
    explorerBase = "https://bscscan.com";
  } else {
    explorerBase = "https://etherscan.io";
  }
  
  const tokenAmount = Number(analysis.totalTokens) / Math.pow(10, tokenInfo.decimals);
  const currentAmount = Number(analysis.currentBalance) / Math.pow(10, tokenInfo.decimals);
  const holdingDays = ((Date.now() / 1000) - analysis.firstBuyTimestamp) / 86400;

  // Solana uses different URL patterns
  const walletUrl = chain === "sol" 
    ? `${explorerBase}/account/${analysis.wallet}`
    : `${explorerBase}/address/${analysis.wallet}`;

  const message = `
╔══════════════════════════════════════╗
🐋 <b>ACCUMULATOR DETECTED</b>
╚══════════════════════════════════════╝

<b>Chain:</b> ${chainConfig.name}
<b>Token:</b> ${tokenInfo.name} (${tokenInfo.symbol})
<b>Contract:</b> <code>${analysis.tokenAddress}</code>

<b>Wallet:</b> <code>${analysis.wallet}</code>
<a href="${walletUrl}">View on Explorer</a>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 <b>Accumulation Stats:</b>
• Buy Count: <b>${analysis.buyCount}</b> transactions
• Total Invested: <b>$${analysis.totalUSD.toLocaleString()}</b> USD
• Tokens Bought: <b>${formatNumber(tokenAmount)}</b> ${tokenInfo.symbol}
• Current Balance: <b>${formatNumber(currentAmount)}</b> ${tokenInfo.symbol}
• Retention: <b>${analysis.balanceRetentionPercent}%</b>

⏱ <b>Timing:</b>
• First Buy: ${formatTimestamp(analysis.firstBuyTimestamp)}
• Last Buy: ${formatTimestamp(analysis.lastBuyTimestamp)}
• Holding: <b>${holdingDays.toFixed(1)} days</b>

🔒 <b>Conviction Signals:</b>
• No Sells: ${analysis.hasSold ? "❌" : "✅"}
• EOA Wallet: ${analysis.isContract ? "❌" : "✅"}
• Low Token Diversity: ${analysis.uniqueTokensTraded <= CONFIG.MAX_UNIQUE_TOKENS_TRADED ? "✅" : "❌"} (${analysis.uniqueTokensTraded} tokens)
• Normal Tx Frequency: ${analysis.avgTxPerDay <= CONFIG.MAX_TX_PER_DAY ? "✅" : "❌"} (${analysis.avgTxPerDay.toFixed(1)}/day)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>High conviction accumulation pattern detected</i>
`.trim();

  try {
    await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    console.log(`📨 Alert sent for wallet ${analysis.wallet}`);
  } catch (err: any) {
    console.error("Telegram send error:", err?.message);
  }
}

function formatNumber(num: number): string {
  if (num >= 1e12) return (num / 1e12).toFixed(2) + "T";
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(2) + "K";
  return num.toFixed(2);
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}
