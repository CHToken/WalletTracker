// src/solana-api.ts
// Solana support using Moralis API + Helius + direct REST calls

import Moralis from "moralis";
import { SolNetwork } from "@moralisweb3/common-sol-utils";
import axios from "axios";
import { ENV, CHAINS } from "./appConfig";
import { SwapEvent, TokenInfo } from "./types";
import { initMoralis, getHealthyMoralisKey } from "./moralis-api";

// Re-export for backwards compatibility - uses shared initialization
export const initMoralisSolana = initMoralis;

// Helper to get a working Moralis key
function getMoralisKey(): string {
  const rotatedKey = getHealthyMoralisKey();
  if (rotatedKey) return rotatedKey;
  // Fallback to env var if no healthy keys
  return ENV.MORALIS_API_KEY || "";
}

// Helper to get Helius key
function getHeliusKey(): string | null {
  const keys = process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY;
  if (!keys) return null;
  const keyList = keys.split(',').map(k => k.trim()).filter(k => k.length > 0);
  return keyList[0] || null;
}

export async function fetchSolanaSwaps(
  tokenAddress: string,
  _hoursBack: number = 72
): Promise<SwapEvent[]> {
  await initMoralisSolana();
  const swaps: SwapEvent[] = [];
  const chainConfig = CHAINS.sol;
  const tokenLower = tokenAddress.toLowerCase();
  const apiKey = getMoralisKey();
  
  if (!apiKey) {
    console.warn("   [Solana] No Moralis API key available");
    return [];
  }

  try {
    const url = `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/swaps`;
    const response = await axios.get(url, {
      headers: { "X-API-Key": apiKey, "Accept": "application/json" },
      params: { limit: 100 },
      validateStatus: () => true,
    });

    if (response.status === 200 && Array.isArray(response.data)) {
      for (const swap of response.data) {
        const walletAddress = swap.walletAddress || swap.wallet;
        const timestamp = Math.floor(new Date(swap.blockTimestamp || swap.timestamp).getTime() / 1000);
        const txHash = swap.transactionHash || swap.txHash || swap.signature;
        const isBuy = swap.bought?.address?.toLowerCase() === tokenLower || swap.tokenOut?.toLowerCase() === tokenLower;
        const isSell = swap.sold?.address?.toLowerCase() === tokenLower || swap.tokenIn?.toLowerCase() === tokenLower;

        if (isBuy) {
          swaps.push({
            txHash,
            blockNumber: Number(swap.blockNumber || swap.slot) || 0,
            timestamp,
            wallet: walletAddress,
            tokenIn: swap.sold?.address || swap.tokenIn || chainConfig.wethAddress,
            tokenOut: tokenLower,
            amountIn: BigInt(swap.sold?.amount || swap.amountIn || "0"),
            amountOut: BigInt(swap.bought?.amount || swap.amountOut || "0"),
            isBuy: true,
          });
        }
        if (isSell) {
          swaps.push({
            txHash: txHash + "-sell",
            blockNumber: Number(swap.blockNumber || swap.slot) || 0,
            timestamp,
            wallet: walletAddress,
            tokenIn: tokenLower,
            tokenOut: swap.bought?.address || swap.tokenOut || chainConfig.wethAddress,
            amountIn: BigInt(swap.sold?.amount || swap.amountIn || "0"),
            amountOut: BigInt(swap.bought?.amount || swap.amountOut || "0"),
            isBuy: false,
          });
        }
      }
    } else {
      console.log("   [Solana] Swaps endpoint not available (" + response.status + "), using transfers fallback");
      return await fetchSolanaTransfersAsFallback(tokenAddress);
    }
  } catch (err: any) {
    console.error("Moralis Solana error for " + tokenAddress + ":", err?.message);
    return await fetchSolanaTransfersAsFallback(tokenAddress);
  }
  console.log("   [Solana] Found " + swaps.length + " swaps via Moralis");
  return swaps;
}


async function fetchSolanaTransfersAsFallback(tokenAddress: string): Promise<SwapEvent[]> {
  const swaps: SwapEvent[] = [];
  const chainConfig = CHAINS.sol;
  const dexPrograms = new Set(chainConfig.dexRouters.map(a => a.toLowerCase()));

  try {
    const url = "https://solana-gateway.moralis.io/token/mainnet/" + tokenAddress + "/transfers";
    const response = await axios.get(url, {
      headers: { "X-API-Key": getMoralisKey(), "Accept": "application/json" },
      params: { limit: 100 },
      validateStatus: () => true,
    });

    if (response.status === 200 && Array.isArray(response.data)) {
      for (const transfer of response.data) {
        const from = (transfer.from || transfer.fromAddress || "").toLowerCase();
        const to = (transfer.to || transfer.toAddress || "").toLowerCase();
        const amount = BigInt(transfer.amount || transfer.value || "0");
        const timestamp = Math.floor(new Date(transfer.blockTimestamp || transfer.timestamp).getTime() / 1000);
        const txHash = transfer.transactionHash || transfer.signature;
        const fromIsDex = dexPrograms.has(from);
        const toIsDex = dexPrograms.has(to);

        if (fromIsDex && !toIsDex) {
          swaps.push({
            txHash,
            blockNumber: Number(transfer.slot || transfer.blockNumber) || 0,
            timestamp,
            wallet: to,
            tokenIn: chainConfig.wethAddress,
            tokenOut: tokenAddress.toLowerCase(),
            amountIn: 0n,
            amountOut: amount,
            isBuy: true,
          });
        }
        if (toIsDex && !fromIsDex) {
          swaps.push({
            txHash: txHash + "-sell",
            blockNumber: Number(transfer.slot || transfer.blockNumber) || 0,
            timestamp,
            wallet: from,
            tokenIn: tokenAddress.toLowerCase(),
            tokenOut: chainConfig.wethAddress,
            amountIn: amount,
            amountOut: 0n,
            isBuy: false,
          });
        }
      }
    }
  } catch (err: any) {
    console.error("Solana transfers fallback error:", err?.message);
  }
  console.log("   [Solana] Found " + swaps.length + " swaps via transfers fallback");
  return swaps;
}

export async function getSolanaTokenMetadata(tokenAddress: string): Promise<TokenInfo> {
  await initMoralisSolana();
  try {
    const response = await Moralis.SolApi.token.getTokenMetadata({
      network: SolNetwork.MAINNET,
      address: tokenAddress,
    });
    return {
      symbol: response.result.symbol || "UNKNOWN",
      name: response.result.name || "Unknown Token",
      decimals: 9,
    };
  } catch {
    return { symbol: "UNKNOWN", name: "Unknown Token", decimals: 9 };
  }
}

export async function getSolanaTokenPrice(tokenAddress: string): Promise<number> {
  await initMoralisSolana();
  try {
    const response = await Moralis.SolApi.token.getTokenPrice({
      network: SolNetwork.MAINNET,
      address: tokenAddress,
    });
    return response.result.usdPrice || 0;
  } catch {
    return 0;
  }
}


export async function getSolanaTokenBalance(
  wallet: string,
  tokenAddress: string
): Promise<bigint> {
  await initMoralisSolana();
  try {
    const response = await Moralis.SolApi.account.getSPL({
      network: SolNetwork.MAINNET,
      address: wallet,
    });
    const tokenAccount = response.result.find(
      (t) => t.mint?.toString().toLowerCase() === tokenAddress.toLowerCase()
    );
    if (tokenAccount && tokenAccount.amount) {
      return BigInt(tokenAccount.amount.lamports || "0");
    }
    return 0n;
  } catch {
    return 0n;
  }
}

export async function getSolanaWalletTxCount(wallet: string): Promise<number> {
  await initMoralisSolana();
  try {
    const url = "https://solana-gateway.moralis.io/account/mainnet/" + wallet + "/transactions";
    const response = await axios.get(url, {
      headers: { "X-API-Key": getMoralisKey(), "Accept": "application/json" },
      params: { limit: 100 },
      validateStatus: () => true,
    });
    if (response.status === 200 && Array.isArray(response.data)) {
      return response.data.length;
    }
    const portfolio = await Moralis.SolApi.account.getPortfolio({
      network: SolNetwork.MAINNET,
      address: wallet,
    });
    return portfolio.result.tokens.length + portfolio.result.nfts.length;
  } catch {
    return 0;
  }
}

export async function getSolanaUniqueTokensTraded(wallet: string): Promise<number> {
  await initMoralisSolana();
  try {
    const response = await Moralis.SolApi.account.getSPL({
      network: SolNetwork.MAINNET,
      address: wallet,
    });
    return response.result.length;
  } catch {
    return 0;
  }
}

export async function isSolanaProgram(address: string): Promise<boolean> {
  const knownPrograms = new Set([
    ...CHAINS.sol.dexRouters,
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "11111111111111111111111111111111",
  ]);
  return knownPrograms.has(address);
}

export async function discoverSolanaTokens(): Promise<string[]> {
  await initMoralisSolana();
  const tokens = new Set<string>();
  const baseTokens = new Set(CHAINS.sol.stablecoins.map(s => s.toLowerCase()));
  baseTokens.add(CHAINS.sol.wethAddress.toLowerCase());

  try {
    const url = "https://solana-gateway.moralis.io/token/mainnet/" + CHAINS.sol.wethAddress + "/swaps";
    const response = await axios.get(url, {
      headers: { "X-API-Key": getMoralisKey(), "Accept": "application/json" },
      params: { limit: 100 },
      validateStatus: () => true,
    });
    
    if (response.status === 200) {
      // Handle different response formats
      const data = response.data;
      const swaps = Array.isArray(data) ? data : (data?.result || data?.swaps || []);
      
      for (const swap of swaps) {
        // Try multiple field names for token addresses
        const boughtAddr = swap.bought?.address || swap.tokenOut || swap.baseToken?.address || swap.quoteToken?.address;
        const soldAddr = swap.sold?.address || swap.tokenIn || swap.quoteToken?.address || swap.baseToken?.address;
        
        if (boughtAddr && !baseTokens.has(boughtAddr.toLowerCase())) {
          tokens.add(boughtAddr);
        }
        if (soldAddr && !baseTokens.has(soldAddr.toLowerCase())) {
          tokens.add(soldAddr);
        }
      }
      
      if (tokens.size === 0 && process.env.DEBUG_RPC) {
        console.log("   [Solana] Response structure:", JSON.stringify(data).slice(0, 200));
      }
    } else {
      console.log("   [Solana] Token discovery limited - swaps endpoint returned " + response.status);
    }
  } catch (err: any) {
    console.error("Error discovering Solana tokens:", err?.message);
  }
  console.log("   [Solana] Discovered " + tokens.size + " tokens");
  return Array.from(tokens);
}


// Alternative: Discover tokens via Helius RPC (better Solana support)
export async function discoverSolanaTokensViaHelius(): Promise<string[]> {
  const heliusKey = getHeliusKey();
  if (!heliusKey) {
    return [];
  }

  const tokens = new Set<string>();
  const baseTokens = new Set(CHAINS.sol.stablecoins.map(s => s.toLowerCase()));
  baseTokens.add(CHAINS.sol.wethAddress.toLowerCase());

  try {
    // Use Helius RPC to get recent signatures for wrapped SOL
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    
    // Get recent signatures
    const sigResponse = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [CHAINS.sol.wethAddress, { limit: 50 }]
    }, { validateStatus: () => true });

    if (sigResponse.status === 200 && sigResponse.data?.result) {
      const signatures = sigResponse.data.result.map((s: any) => s.signature);
      
      // Get transaction details for each signature (batch)
      for (const sig of signatures.slice(0, 20)) {
        try {
          const txResponse = await axios.post(rpcUrl, {
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]
          }, { validateStatus: () => true });

          if (txResponse.status === 200 && txResponse.data?.result) {
            const tx = txResponse.data.result;
            // Extract token mints from pre/post token balances
            const preBalances = tx.meta?.preTokenBalances || [];
            const postBalances = tx.meta?.postTokenBalances || [];
            
            for (const balance of [...preBalances, ...postBalances]) {
              const mint = balance.mint;
              if (mint && !baseTokens.has(mint.toLowerCase())) {
                tokens.add(mint);
              }
            }
          }
        } catch {
          // Skip failed transactions
        }
        
        // Small delay to respect rate limits
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    if (tokens.size > 0) {
      console.log(`   [Solana] Helius discovered ${tokens.size} tokens`);
    }
  } catch (err: any) {
    if (process.env.DEBUG_RPC) {
      console.error("Helius discovery error:", err?.message);
    }
  }

  return Array.from(tokens);
}
