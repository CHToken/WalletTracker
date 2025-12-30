// src/solana-api.ts
// Solana support using Moralis API + direct REST calls

import Moralis from "moralis";
import { SolNetwork } from "@moralisweb3/common-sol-utils";
import axios from "axios";
import { ENV, CHAINS } from "./appConfig";
import { SwapEvent, TokenInfo } from "./types";

let initialized = false;

export async function initMoralisSolana(): Promise<void> {
  if (initialized) return;
  if (!ENV.MORALIS_API_KEY) {
    throw new Error("MORALIS_API_KEY not set in .env");
  }
  await Moralis.start({ apiKey: ENV.MORALIS_API_KEY });
  initialized = true;
}

export async function fetchSolanaSwaps(
  tokenAddress: string,
  _hoursBack: number = 72
): Promise<SwapEvent[]> {
  await initMoralisSolana();
  const swaps: SwapEvent[] = [];
  const chainConfig = CHAINS.sol;
  const tokenLower = tokenAddress.toLowerCase();

  try {
    const url = `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/swaps`;
    const response = await axios.get(url, {
      headers: { "X-API-Key": ENV.MORALIS_API_KEY, "Accept": "application/json" },
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
      headers: { "X-API-Key": ENV.MORALIS_API_KEY, "Accept": "application/json" },
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
      headers: { "X-API-Key": ENV.MORALIS_API_KEY, "Accept": "application/json" },
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
      headers: { "X-API-Key": ENV.MORALIS_API_KEY, "Accept": "application/json" },
      params: { limit: 100 },
      validateStatus: () => true,
    });
    if (response.status === 200 && Array.isArray(response.data)) {
      for (const swap of response.data) {
        const boughtAddr = swap.bought?.address || swap.tokenOut;
        const soldAddr = swap.sold?.address || swap.tokenIn;
        if (boughtAddr && !baseTokens.has(boughtAddr.toLowerCase())) {
          tokens.add(boughtAddr);
        }
        if (soldAddr && !baseTokens.has(soldAddr.toLowerCase())) {
          tokens.add(soldAddr);
        }
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
