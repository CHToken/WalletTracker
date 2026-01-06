# Wallet Accumulation Tracker

Detects wallets showing deliberate accumulation behavior on EVM chains (Ethereum, BSC) and Solana. Identifies high-conviction buyers based on multiple buy transactions, holding patterns, and anti-bot filtering.

## How It Works

1. **Token Discovery** - Scans recent blocks for new token pairs on DEXes
2. **Swap Detection** - Fetches token transfers and identifies DEX swaps (buys/sells)
3. **Wallet Analysis** - Filters wallets meeting accumulation criteria
4. **Alerts** - Sends Telegram notifications for valid accumulators

## Detection Criteria

A wallet is flagged only if ALL conditions are met:

| Criteria | Description | Config Key |
|----------|-------------|------------|
| Min Buy Count | Minimum separate buy transactions | `minBuyCount` |
| Min USD Value | Cumulative buy value threshold | `minCumulativeUSD` |
| Buy Spacing | Minimum minutes between buys (anti-bot) | `minBuySpacingMinutes` |
| Max Buys/Hour | Maximum buys in single hour (anti-bot) | `maxBuysPerHour` |
| No-Sell Period | Hours wallet must hold after last buy | `noSellHours` |
| Balance Retention | % of bought tokens still held | `minBalanceRetentionPercent` |
| Token Diversity | Max different tokens traded | `maxUniqueTokensTraded` |
| TX Frequency | Max average transactions per day | `maxTxPerDay` |

## Configuration

### accumulation-config.json

```json
{
  "thresholds": {
    "minBuyCount": 3,
    "minCumulativeUSD": 1000,
    "preCheckThresholdPercent": 80,
    "minBuySpacingMinutes": 5,
    "maxBuysPerHour": 2,
    "noSellHours": 24,
    "minBalanceRetentionPercent": 50,
    "maxUniqueTokensTraded": 50,
    "maxTxPerDay": 100,
    "evaluationWindowHours": 72,
    "scanIntervalMinutes": 5
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `minBuyCount` | Minimum buy transactions required | 5 |
| `minCumulativeUSD` | Minimum total USD value of buys | 10000 |
| `preCheckThresholdPercent` | Quick-filter threshold (% of minCumulativeUSD) | 50 |
| `minBuySpacingMinutes` | Minimum minutes between buys | 10 |
| `maxBuysPerHour` | Maximum buys allowed in single hour | 3 |
| `noSellHours` | Hours must hold after last buy | 72 |
| `minBalanceRetentionPercent` | % of tokens must still be held | 90 |
| `maxUniqueTokensTraded` | Max different tokens wallet trades | 20 |
| `maxTxPerDay` | Max average daily transactions | 50 |
| `evaluationWindowHours` | Time window to analyze | 72 |
| `scanIntervalMinutes` | Re-scan interval | 5 |

## RPC Providers

The bot uses a multi-RPC load balancer with automatic failover and rate limiting.

### Supported Providers

| Provider | Chains | Free Tier | Rate Limit |
|----------|--------|-----------|------------|
| **Alchemy** | ETH, BSC, SOL | 30M CU/month | 50 req/s |
| **Helius** | SOL only | 1M credits/month | 10 req/s |
| **Ankr** | ETH, BSC | 200M credits/month | 10 req/s |
| **Infura** | ETH, BSC | 3M req/month | 10 req/s |
| **GetBlock** | ETH, BSC | 50K CU/day | 20 req/s |
| **Chainstack** | ETH, BSC, SOL | 3M RU/month | 25 req/s |
| **Moralis** | ETH, BSC, SOL | 40K CU/day | API data |

### Environment Variables

```bash
# RPC Providers (comma-separated for multiple keys)
ALCHEMY_API_KEYS=key1,key2,key3
ANKR_API_KEYS=key1,key2
INFURA_API_KEYS=key1,key2
HELIUS_API_KEYS=key1,key2
GETBLOCK_ETH_KEYS=token1,token2
GETBLOCK_BSC_KEYS=token1,token2
CHAINSTACK_ETH_URL=https://...
CHAINSTACK_BSC_URL=https://...
CHAINSTACK_SOL_URL=https://...

# Data APIs
MORALIS_API_KEYS=key1,key2,key3
ETHERSCAN_API_KEY=your_key
BSCSCAN_API_KEY=your_key

# Database
MONGODB_URL=mongodb+srv://...

# Telegram Alerts
TELEGRAM_ACCUMULATION_BOT_TOKEN=your_bot_token
TELEGRAM_ACCUMULATION_CHANNEL_ID=-your_channel_id

# Debug
DEBUG_RPC=true  # Enable verbose RPC logging
```

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your API keys
npm run dev
```

## Architecture

```
src/
├── index.ts          # Entry point, token queue management
├── appConfig.ts      # Configuration loading
├── detector.ts       # Main accumulation detection logic
├── analyzer.ts       # Wallet analysis and validation
├── discovery.ts      # Token discovery from new pairs
├── moralis-api.ts    # Moralis REST API with key rotation
├── solana-api.ts     # Solana-specific API calls
├── blockchain.ts     # EVM blockchain interactions
├── rpc-manager.ts    # Multi-RPC load balancer
├── rpc-logger.ts     # RPC request logging
├── telegram.ts       # Telegram alert formatting
├── storage.ts        # MongoDB persistence
├── providers.ts      # Provider initialization
├── types.ts          # TypeScript interfaces
└── accumulation-config.json  # Detection thresholds
```

## Key Features

- **Multi-key rotation** - Distributes load across multiple API keys
- **Auto-failover** - Switches to healthy providers on errors
- **Rate limiting** - Respects provider limits automatically
- **CU tracking** - Monitors Moralis compute unit usage
- **Caching** - Token metadata and prices cached to reduce API calls
- **Cooldown** - 30-min cooldown between re-analyzing same token

## Output Example

```
🚀 Wallet Accumulation Tracker
══════════════════════════════════════════════════
Mode: Auto-Discovery (ETH + BSC + SOL)
Evaluation window: 72h
Min buys: 3
Min USD: $1000
Scan interval: 5 min

✅ RPC Manager initialized:
────────────────────────────────────────────────────────────
ETH: 8/9 healthy → alchemy(2), ankr(2), getblock(1), infura(1)
BSC: 10/10 healthy → alchemy(2), ankr(2), getblock(2), infura(1)
SOL: 5/5 healthy → helius(2), alchemy(2), chainstack(1)
────────────────────────────────────────────────────────────

📊 [Ethereum] Analyzing: 0x1234...
Token: Example Token (EXT)
Found 231 DEX swap events
Unique wallets with buys: 109
Candidates with ≥3 buys: 5

✅ ACCUMULATOR FOUND: 0xabcd...
   Buys: 7 | Total: $15,432.50 | Retention: 98%
```

## License

MIT
