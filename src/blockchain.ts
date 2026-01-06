// src/blockchain.ts
import { ethers } from "ethers";
import axios from "axios";
import { getProvider } from "./providers";
import { ENV, CHAINS, ChainId, ERC20_ABI, EXCHANGE_ADDRESSES, ETHERSCAN_V2_URL } from "./appConfig";
import { TokenInfo, SwapEvent } from "./types";

// Event signatures for DEX swaps
const SWAP_V2_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_V3_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// Price cache (5 min TTL)
const priceCache: Map<string, { price: number; timestamp: number }> = new Map();
const PRICE_CACHE_TTL = 5 * 60 * 1000;

export async function isContract(address: string, chain: ChainId = "eth"): Promise<boolean> {
  try {
    const provider = await getProvider(chain);
    const code = await provider.getCode(address);
    return code !== "0x";
  } catch {
    return false;
  }
}

export async function getTokenBalance(tokenAddress: string, wallet: string, chain: ChainId = "eth"): Promise<bigint> {
  try {
    const provider = await getProvider(chain);
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await contract.balanceOf(wallet);
  } catch {
    return 0n;
  }
}

export async function getTokenInfo(tokenAddress: string, chain: ChainId = "eth"): Promise<TokenInfo> {
  try {
    const provider = await getProvider(chain);
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, name, decimals] = await Promise.all([
      contract.symbol(),
      contract.name(),
      contract.decimals(),
    ]);
    return { symbol, name, decimals: Number(decimals) };
  } catch {
    return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 18 };
  }
}

export async function getNativeTokenPriceUSD(chain: ChainId = "eth"): Promise<number> {
  const cacheKey = `native_${chain}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached.price;
  }

  try {
    const coinId = chain === "bsc" ? "binancecoin" : "ethereum";
    const resp = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { timeout: 10000 }
    );
    const price = resp.data?.[coinId]?.usd ?? (chain === "bsc" ? 600 : 3000);
    priceCache.set(cacheKey, { price, timestamp: Date.now() });
    return price;
  } catch {
    return chain === "bsc" ? 600 : 3000;
  }
}

export async function getTokenPriceUSD(tokenAddress: string, chain: ChainId = "eth"): Promise<number> {
  const cacheKey = `${chain}_${tokenAddress.toLowerCase()}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached.price;
  }

  try {
    const chainConfig = CHAINS[chain];
    const apiKey = ENV[chainConfig.explorerApiKey as keyof typeof ENV] as string;
    if (!apiKey) return 0;

    // Get token price from DEXScreener (works for both chains)
    const resp = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { timeout: 10000 }
    );
    
    const pairs = resp.data?.pairs;
    if (pairs && pairs.length > 0) {
      const price = parseFloat(pairs[0].priceUsd) || 0;
      priceCache.set(cacheKey, { price, timestamp: Date.now() });
      return price;
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function getWalletTxCount(wallet: string, chain: ChainId = "eth"): Promise<number> {
  try {
    const chainConfig = CHAINS[chain];
    const apiKey = ENV.ETHERSCAN_API_KEY;
    
    // Use Etherscan V2 API
    if (apiKey && chainConfig.chainId > 0) {
      const url = `${ETHERSCAN_V2_URL}?chainid=${chainConfig.chainId}&module=account&action=txlist&address=${wallet}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
      const resp = await axios.get(url, { timeout: 15000 });
      if (resp.data?.status === "1" && Array.isArray(resp.data?.result)) {
        return resp.data.result.length;
      }
    }
    
    // Fallback to Moralis if Etherscan fails
    if (ENV.MORALIS_API_KEY) {
      const chainMap: Record<string, string> = { eth: "eth", bsc: "bsc" };
      const moralisChain = chainMap[chain];
      if (moralisChain) {
        const url = `https://deep-index.moralis.io/api/v2.2/${wallet}?chain=${moralisChain}`;
        const resp = await axios.get(url, {
          headers: { "X-API-Key": ENV.MORALIS_API_KEY },
          timeout: 15000,
        });
        if (Array.isArray(resp.data?.result)) {
          return resp.data.result.length;
        }
      }
    }
    
    return 0;
  } catch (err: any) {
    if (process.env.DEBUG_RPC) {
      console.log(`   [Etherscan] getWalletTxCount error: ${err?.message}`);
    }
    return 0;
  }
}

export async function getUniqueTokensTraded(wallet: string, chain: ChainId = "eth"): Promise<number> {
  try {
    const chainConfig = CHAINS[chain];
    const apiKey = ENV.ETHERSCAN_API_KEY;
    
    // Use Etherscan V2 API
    if (apiKey && chainConfig.chainId > 0) {
      const url = `${ETHERSCAN_V2_URL}?chainid=${chainConfig.chainId}&module=account&action=tokentx&address=${wallet}&sort=desc&apikey=${apiKey}`;
      const resp = await axios.get(url, { timeout: 15000 });
      if (resp.data?.status === "1" && Array.isArray(resp.data?.result)) {
        const tokens = new Set<string>();
        for (const tx of resp.data.result) {
          tokens.add(tx.contractAddress?.toLowerCase());
        }
        return tokens.size;
      }
    }
    
    // Fallback to Moralis if Etherscan fails
    if (ENV.MORALIS_API_KEY) {
      const chainMap: Record<string, string> = { eth: "eth", bsc: "bsc" };
      const moralisChain = chainMap[chain];
      if (moralisChain) {
        const url = `https://deep-index.moralis.io/api/v2.2/${wallet}/erc20/transfers?chain=${moralisChain}&limit=100`;
        const resp = await axios.get(url, {
          headers: { "X-API-Key": ENV.MORALIS_API_KEY },
          timeout: 15000,
        });
        if (Array.isArray(resp.data?.result)) {
          const tokens = new Set<string>();
          for (const tx of resp.data.result) {
            tokens.add(tx.address?.toLowerCase());
          }
          return tokens.size;
        }
      }
    }
    
    return 0;
  } catch (err: any) {
    if (process.env.DEBUG_RPC) {
      console.log(`   [Etherscan] getUniqueTokensTraded error: ${err?.message}`);
    }
    return 0;
  }
}

/**
 * Get unique tokens traded on DEX (excluding the target token)
 * Only counts tokens involved in DEX swap transactions, not all token transfers
 */
export async function getUniqueDexTokensTraded(wallet: string, excludeToken: string, chain: ChainId = "eth"): Promise<number> {
  try {
    const chainConfig = CHAINS[chain];
    const apiKey = ENV.ETHERSCAN_API_KEY;
    if (!apiKey || chainConfig.chainId === 0) return 0;
    
    const dexRouters = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));
    const excludeTokenLower = excludeToken.toLowerCase();
    
    // Get all transactions for the wallet using V2 API
    const txUrl = `${ETHERSCAN_V2_URL}?chainid=${chainConfig.chainId}&module=account&action=txlist&address=${wallet}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
    const txResp = await axios.get(txUrl, { timeout: 15000 });
    if (txResp.data?.status !== "1" || !Array.isArray(txResp.data?.result)) return 0;

    // Find transaction hashes that interact with DEX routers
    const dexTxHashes = new Set<string>();
    for (const tx of txResp.data.result) {
      const toAddress = tx.to?.toLowerCase();
      if (toAddress && dexRouters.has(toAddress)) {
        dexTxHashes.add(tx.hash.toLowerCase());
      }
    }

    if (dexTxHashes.size === 0) return 0;

    // Get token transfers and filter to only those in DEX transactions
    const tokenUrl = `${ETHERSCAN_V2_URL}?chainid=${chainConfig.chainId}&module=account&action=tokentx&address=${wallet}&sort=desc&apikey=${apiKey}`;
    const tokenResp = await axios.get(tokenUrl, { timeout: 15000 });
    if (tokenResp.data?.status !== "1" || !Array.isArray(tokenResp.data?.result)) return 0;

    const dexTradedTokens = new Set<string>();
    for (const tx of tokenResp.data.result) {
      const tokenAddress = tx.contractAddress?.toLowerCase();
      const txHash = tx.hash?.toLowerCase();
      
      // Only count tokens from DEX transactions, excluding the target token
      if (txHash && dexTxHashes.has(txHash) && tokenAddress && tokenAddress !== excludeTokenLower) {
        dexTradedTokens.add(tokenAddress);
      }
    }
    
    return dexTradedTokens.size;
  } catch {
    return 0;
  }
}

/**
 * Get total DEX trades count for a wallet across all tokens
 * Counts swap transactions by looking for interactions with known DEX routers
 */
export async function getWalletTotalDexTrades(wallet: string, chain: ChainId = "eth"): Promise<number> {
  try {
    const chainConfig = CHAINS[chain];
    const apiKey = ENV.ETHERSCAN_API_KEY;
    if (!apiKey || chainConfig.chainId === 0) return 0;
    
    const dexRouters = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));
    
    // Get all transactions for the wallet using V2 API
    const url = `${ETHERSCAN_V2_URL}?chainid=${chainConfig.chainId}&module=account&action=txlist&address=${wallet}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
    const resp = await axios.get(url, { timeout: 15000 });
    if (resp.data?.status !== "1" || !Array.isArray(resp.data?.result)) return 0;

    let dexTradeCount = 0;
    for (const tx of resp.data.result) {
      // Count transactions that interact with DEX routers
      const toAddress = tx.to?.toLowerCase();
      if (toAddress && dexRouters.has(toAddress)) {
        dexTradeCount++;
      }
    }
    
    return dexTradeCount;
  } catch {
    return 0;
  }
}

/**
 * Fetch ONLY DEX swap transactions for a token (excludes airdrops, transfers, mints)
 * Chunked for free RPC tier compatibility
 */
export async function fetchDexSwapsForToken(
  tokenAddress: string,
  fromBlock: number,
  toBlock: number,
  chain: ChainId = "eth"
): Promise<SwapEvent[]> {
  const swaps: SwapEvent[] = [];
  const tokenLower = tokenAddress.toLowerCase();
  const provider = await getProvider(chain);
  const chainConfig = CHAINS[chain];
  const dexRouters = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));

  // Chunk size for free RPC tiers
  const chunkSize = chain === "eth" ? 10 : 500;
  const totalBlocks = toBlock - fromBlock;
  const chunks: { from: number; to: number }[] = [];

  for (let i = 0; i < totalBlocks; i += chunkSize) {
    chunks.push({
      from: fromBlock + i,
      to: Math.min(fromBlock + i + chunkSize - 1, toBlock),
    });
  }

  // Limit chunks to avoid excessive API calls (sample recent activity)
  const chunksToProcess = chunks.slice(-50);

  for (const chunk of chunksToProcess) {
    try {
      const transferLogs = await provider.getLogs({
        address: tokenAddress,
        topics: [TRANSFER_TOPIC],
        fromBlock: chunk.from,
        toBlock: chunk.to,
      });

      // Group transfers by transaction hash
      const txTransfers = new Map<string, typeof transferLogs>();
      for (const log of transferLogs) {
        const existing = txTransfers.get(log.transactionHash) ?? [];
        existing.push(log);
        txTransfers.set(log.transactionHash, existing);
      }

      // For each transaction, check if it's a DEX swap
      for (const [txHash, transfers] of txTransfers) {
        try {
          const receipt = await provider.getTransactionReceipt(txHash);
          if (!receipt) continue;

          // Check if this tx has Swap events (V2 or V3)
          const hasSwapEvent = receipt.logs.some(log =>
            log.topics[0] === SWAP_V2_TOPIC || log.topics[0] === SWAP_V3_TOPIC
          );

          if (!hasSwapEvent) continue;

          const block = await provider.getBlock(receipt.blockNumber);
          const timestamp = block?.timestamp ?? Math.floor(Date.now() / 1000);

          for (const transfer of transfers) {
            const from = "0x" + transfer.topics[1].slice(26).toLowerCase();
            const to = "0x" + transfer.topics[2].slice(26).toLowerCase();
            const amount = BigInt(transfer.data);

            if (dexRouters.has(from) && dexRouters.has(to)) continue;

            // BUY
            if (dexRouters.has(from) || isLikelyPair(from)) {
              if (!dexRouters.has(to) && !isLikelyPair(to) && to !== ethers.ZeroAddress) {
                swaps.push({
                  txHash,
                  blockNumber: receipt.blockNumber,
                  timestamp,
                  wallet: to,
                  tokenIn: chainConfig.wethAddress,
                  tokenOut: tokenLower,
                  amountIn: 0n,
                  amountOut: amount,
                  isBuy: true,
                });
              }
            }

            // SELL
            if (dexRouters.has(to) || isLikelyPair(to) || EXCHANGE_ADDRESSES.has(to)) {
              if (!dexRouters.has(from) && !isLikelyPair(from) && from !== ethers.ZeroAddress) {
                swaps.push({
                  txHash: txHash + "-sell",
                  blockNumber: receipt.blockNumber,
                  timestamp,
                  wallet: from,
                  tokenIn: tokenLower,
                  tokenOut: chainConfig.wethAddress,
                  amountIn: amount,
                  amountOut: 0n,
                  isBuy: false,
                });
              }
            }
          }
        } catch {
          // Skip problematic transactions
        }
      }

      // Small delay between chunks
      await new Promise(r => setTimeout(r, 100));
    } catch {
      // Skip failed chunks
    }
  }

  return swaps;
}

// Simple heuristic to identify pair/pool contracts
function isLikelyPair(address: string): boolean {
  // Pairs typically have addresses that look like contract addresses
  // This is a basic check - could be enhanced with actual pair registry lookups
  return address.startsWith("0x") && address.length === 42;
}

/**
 * Calculate USD value of a swap by analyzing the transaction
 */
export async function calculateSwapUSD(
  txHash: string,
  tokenAddress: string,
  tokenAmount: bigint,
  chain: ChainId = "eth"
): Promise<number> {
  try {
    const provider = await getProvider(chain);
    const chainConfig = CHAINS[chain];
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return 0;

    // Method 1: Check if native token (ETH/BNB) was sent
    const tx = await provider.getTransaction(txHash);
    if (tx && tx.value > 0n) {
      const nativeAmount = Number(ethers.formatEther(tx.value));
      const nativePrice = await getNativeTokenPriceUSD(chain);
      return nativeAmount * nativePrice;
    }

    // Method 2: Look for WETH/WBNB transfer in the same tx
    const wethAddress = chainConfig.wethAddress.toLowerCase();
    for (const log of receipt.logs) {
      if (log.topics[0] === TRANSFER_TOPIC && log.address.toLowerCase() === wethAddress) {
        const amount = BigInt(log.data);
        const wethAmount = Number(ethers.formatEther(amount));
        const nativePrice = await getNativeTokenPriceUSD(chain);
        return wethAmount * nativePrice;
      }
    }

    // Method 3: Look for stablecoin transfer
    for (const stablecoin of chainConfig.stablecoins) {
      for (const log of receipt.logs) {
        if (log.topics[0] === TRANSFER_TOPIC && log.address.toLowerCase() === stablecoin.toLowerCase()) {
          const amount = BigInt(log.data);
          // USDT/USDC have 6 decimals, DAI has 18
          const decimals = stablecoin.toLowerCase().includes("6b175474") ? 18 : 6;
          return Number(amount) / Math.pow(10, decimals);
        }
      }
    }

    // Method 4: Use token price from DEXScreener
    const tokenPrice = await getTokenPriceUSD(tokenAddress, chain);
    if (tokenPrice > 0) {
      const tokenInfo = await getTokenInfo(tokenAddress, chain);
      const tokenAmountDecimal = Number(tokenAmount) / Math.pow(10, tokenInfo.decimals);
      return tokenAmountDecimal * tokenPrice;
    }

    return 0;
  } catch {
    return 0;
  }
}
