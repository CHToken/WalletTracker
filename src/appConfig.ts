// src/appConfig.ts
import dotenv from "dotenv";
dotenv.config();

// Supported chains
export type ChainId = "eth" | "bsc" | "sol";

interface ChainConfig {
  name: string;
  chainId: number;  // For Etherscan V2 API
  rpcEnvKey: string;
  explorerApiKey: string;
  wethAddress: string;
  stablecoins: string[];
  dexRouters: string[];
}

// Etherscan V2 unified API endpoint
export const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

export const CHAINS: Record<ChainId, ChainConfig> = {
  eth: {
    name: "Ethereum",
    chainId: 1,
    rpcEnvKey: "ETH_RPC_URL",
    explorerApiKey: "ETHERSCAN_API_KEY",
    wethAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    stablecoins: [
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0x6b175474e89094c44da98b954eedeac495271d0f",
    ],
    dexRouters: [
      "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
      "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
      "0xe592427a0aece92de3edee1f18e0157c05861564",
      "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b",
      "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
    ],
  },
  bsc: {
    name: "BSC",
    chainId: 56,
    rpcEnvKey: "BSC_RPC_URL",
    explorerApiKey: "ETHERSCAN_API_KEY",  // V2 uses same key for all chains
    wethAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    stablecoins: [
      "0x55d398326f99059ff775485246999027b3197955",
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      "0xe9e7cea3dedca5984780bafc599bd69add087d56",
    ],
    dexRouters: [
      "0x10ed43c718714eb63d5aa57b78b54704e256024e",
      "0x13f4ea83d0bd40e75c8222255bc855a974568dd4",
    ],
  },
  sol: {
    name: "Solana",
    chainId: 0,  // Not applicable for Solana
    rpcEnvKey: "SOLANA_RPC_URL",
    explorerApiKey: "",
    wethAddress: "So11111111111111111111111111111111111111112", // Wrapped SOL
    stablecoins: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    ],
    dexRouters: [
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter V6
      "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM
      "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
      "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM_V2
      "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",  // Raydium CPMM
      "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // Pump.fun AMM
      "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"  // Pump.fun
    ],
  },
};

// Environment variables
export const ENV = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_ACCUMULATION_BOT_TOKEN ?? "",
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_ACCUMULATION_CHANNEL_ID ?? "",
  MONGO_URL: process.env.MONGODB_URL ?? "",
  ETH_RPC_URL: process.env.ETH_RPC_URL ?? "",
  BSC_RPC_URL: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY ?? "",  // V2 uses single key for all chains
  MORALIS_API_KEY: process.env.MORALIS_API_KEY ?? "",
};

// Detection thresholds - load from config file, fallback to defaults
import * as fs from "fs";
import * as path from "path";

interface AccumulationConfig {
  thresholds?: {
    minBuyCount?: number;
    minCumulativeUSD?: number;
    preCheckThresholdPercent?: number;
    minBuySpacingMinutes?: number;
    maxBuysPerHour?: number;
    noSellHours?: number;
    minBalanceRetentionPercent?: number;
    maxUniqueTokensTraded?: number;
    maxTotalTrades?: number;
    maxTxPerDay?: number;
    evaluationWindowHours?: number;
    scanIntervalMinutes?: number;
  };
  chains?: {
    eth?: boolean;
    bsc?: boolean;
    sol?: boolean;
  };
}

function loadConfig(): AccumulationConfig {
  try {
    const configPath = path.join(__dirname, "accumulation-config.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const fileConfig = loadConfig();
const t = fileConfig.thresholds || {};
const c = fileConfig.chains || {};

export const CONFIG = {
  EVALUATION_WINDOW_HOURS: t.evaluationWindowHours ?? 72,
  MIN_BUY_COUNT: t.minBuyCount ?? 5,
  MIN_CUMULATIVE_USD: t.minCumulativeUSD ?? 10000,
  PRE_CHECK_THRESHOLD_PERCENT: t.preCheckThresholdPercent ?? 50,
  MIN_BUY_SPACING_MINUTES: t.minBuySpacingMinutes ?? 10,
  MAX_BUYS_PER_HOUR: t.maxBuysPerHour ?? 3,
  NO_SELL_HOURS: t.noSellHours ?? 72,
  MIN_BALANCE_RETENTION_PERCENT: t.minBalanceRetentionPercent ?? 90,
  MAX_UNIQUE_TOKENS_TRADED: t.maxUniqueTokensTraded ?? 5,
  MAX_TOTAL_TRADES: t.maxTotalTrades ?? 500,
  MAX_TX_PER_DAY: t.maxTxPerDay ?? 50,
  SCAN_INTERVAL_MS: (t.scanIntervalMinutes ?? 5) * 60 * 1000,
};

// Chain enable/disable flags
export const ENABLED_CHAINS = {
  eth: c.eth ?? true,
  bsc: c.bsc ?? true,
  sol: c.sol ?? true,
};

export function isChainEnabled(chain: ChainId): boolean {
  return ENABLED_CHAINS[chain] ?? true;
}

// Known exchange deposit addresses to exclude
export const EXCHANGE_ADDRESSES = new Set([
  "0x28c6c06298d514db089934071355e5743bf21d60",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43",
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b",
  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0",
]);

// ABIs
export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];
