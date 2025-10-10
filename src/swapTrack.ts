// // src/swapTrack.ts
// import { MongoClient, Db, Collection } from "mongodb";
// import { ethers } from "ethers";
// import dotenv from "dotenv";
// import TelegramBot from "node-telegram-bot-api";
// import moment from "moment";
// import axios from "axios";

// dotenv.config();

// /**
//  * swapTrack.ts
//  * Converted from swapTrack.js -> TypeScript (ESM)
//  *
//  * Notes:
//  * - Exports SwapTrack() which starts monitoring new blocks and sends Telegram notifications.
//  * - Requires environment variables:
//  *    SWAP_INFURA_URL, TELEGRAM_TRACK_BOT_TOKEN, TELEGRAM_SWAP_CHANNEL_ID,
//  *    TELEGRAM_DELETE_ID (optional), ETHERSCAN_API_KEY, MONGODB_URL
//  *
//  * - Install types: npm i -D @types/node @types/telegram__bot_api (or similar) if necessary
//  */

// type TxLike = ethers.provider.TransactionResponse & {
//   hash: string;
//   from: string;
//   to?: string | null;
//   blockNumber?: number | null;
// };

// type TokenDetails = {
//   name: string;
//   symbol: string;
//   decimals: number;
// };

// const infuraUrl = process.env.SWAP_INFURA_URL ?? "";
// const provider = infuraUrl ? ethers.getDefaultProvider(infuraUrl) : ethers.getDefaultProvider();
// const botToken = process.env.TELEGRAM_TRACK_BOT_TOKEN ?? "";
// const chatId = process.env.TELEGRAM_SWAP_CHANNEL_ID ?? "";
// const deleteNotificationChatId = process.env.TELEGRAM_DELETE_ID ?? "";
// const bot = botToken ? new TelegramBot(botToken, { polling: false }) : null;

// const mongoUrl = process.env.MONGODB_URL ?? "";
// const dbName = "blockchain";
// const collectionName = "TokenList";

// let db: Db | undefined;
// let collection: Collection | undefined;

// async function connectToMongo() {
//   if (!mongoUrl) {
//     console.warn("MONGODB_URL not set — MongoDB features will be disabled.");
//     return;
//   }
//   try {
//     const client = new MongoClient(mongoUrl);
//     await client.connect();
//     db = client.db(dbName);
//     const exists = await db.listCollections({ name: collectionName }).toArray();
//     if (exists.length === 0) {
//       await db.createCollection(collectionName);
//       console.log(`Collection ${collectionName} created`);
//     }
//     collection = db.collection(collectionName);
//     console.log("Connected to MongoDB ✅");
//   } catch (err: any) {
//     console.error("Error connecting to MongoDB:", err?.message ?? err);
//   }
// }

// async function importChalk(): Promise<any> {
//   // dynamic import to keep startup fast if chalk isn't installed in some environments
//   const chalkModule = await import("chalk").catch(() => null);
//   return chalkModule ? chalkModule.default : console;
// }

// function weiToEth(weiAmount: ethers.BigNumberish): number {
//   try {
//     const bn = ethers.BigNumber.from(weiAmount as any);
//     const eth = Number(ethers.utils.formatUnits(bn, 18));
//     return parseFloat(eth.toFixed(6));
//   } catch (err: any) {
//     console.error("Error converting wei to ETH:", err?.message ?? err);
//     return 0;
//   }
// }

// function formatTokenAge(creationDate: Date | string | number): string {
//   const now = moment();
//   const created = moment(creationDate);
//   const duration = moment.duration(now.diff(created));
//   if (duration.asMinutes() < 60) return `${Math.floor(duration.asMinutes())} min ago`;
//   if (duration.asHours() < 24) return `${Math.floor(duration.asHours())} hr ago`;
//   return `${Math.floor(duration.asDays())} days ago`;
// }

// async function getTransactionCount(address: string): Promise<number> {
//   try {
//     const etherscanKey = process.env.ETHERSCAN_API_KEY ?? "";
//     if (!etherscanKey) {
//       console.warn("ETHERSCAN_API_KEY not set — skipping transaction count check (returning 0).");
//       return 0;
//     }
//     const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=asc&apikey=${etherscanKey}`;
//     const resp = await axios.get(url, { timeout: 10_000 });
//     const result = resp.data?.result;
//     if (!Array.isArray(result)) return 0;
//     console.log(`Address ${address} has ${result.length} transactions (etherscan)`);
//     return result.length;
//   } catch (err: any) {
//     console.error("Error fetching transaction count from Etherscan:", err?.message ?? err);
//     return 0;
//   }
// }

// const uniswapV2PairABI = [
//   "function token0() external view returns (address)",
//   "function token1() external view returns (address)",
// ];

// const erc20ABI = [
//   "function name() external view returns (string)",
//   "function symbol() external view returns (string)",
//   "function decimals() external view returns (uint8)",
// ];

// async function getTokenAddresses(pairAddress: string): Promise<{ token0: string | null; token1: string | null; }> {
//   try {
//     const pairContract = new ethers.Contract(pairAddress, uniswapV2PairABI, provider);
//     const token0 = await pairContract.token0();
//     const token1 = await pairContract.token1();
//     console.log(`Fetched token addresses for pair ${pairAddress}`);
//     return { token0, token1 };
//   } catch (err: any) {
//     console.error(`Error fetching token addresses for pair ${pairAddress}:`, err?.message ?? err);
//     return { token0: null, token1: null };
//   }
// }

// async function getTokenDetails(tokenAddress?: string | null): Promise<TokenDetails> {
//   try {
//     if (!tokenAddress) return { name: "Unknown", symbol: "Unknown", decimals: 0 };
//     const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, provider);
//     const [name, symbol, decimals] = await Promise.all([
//       tokenContract.name(),
//       tokenContract.symbol(),
//       tokenContract.decimals(),
//     ]);
//     console.log(`Fetched token details for address ${tokenAddress}`);
//     return { name, symbol, decimals };
//   } catch (err: any) {
//     console.error(`Error fetching token details for address ${tokenAddress}:`, err?.message ?? err);
//     return { name: "Unknown", symbol: "Unknown", decimals: 0 };
//   }
// }

// async function sendTelegramMessage(
//   tx: TxLike,
//   tokenContractAddress: string | null,
//   tokenName: string,
//   tokenSymbol: string,
//   tokenDecimals: number,
//   platform: string,
//   tokenCreationDate?: Date | string | number
// ): Promise<void> {
//   try {
//     const transactionCount = await getTransactionCount(tx.from);
//     console.log(`Address ${tx.from} has ${transactionCount} transactions (Etherscan).`);

//     if (transactionCount > 15) {
//       console.log(`Skipping notification for address ${tx.from} with ${transactionCount} transactions.`);
//       return;
//     }

//     const etherscanLink = `https://etherscan.io/tx/${tx.hash}`;
//     const fromLink = `https://etherscan.io/address/${tx.from}`;
//     const toLink = `https://etherscan.io/address/${tx.to ?? ""}`;

//     const ensName = await provider.lookupAddress(tx.from).catch(() => null);
//     const fromAddress = ensName ? `<a href="${fromLink}">${ensName}</a>` : `<a href="${fromLink}">${tx.from}</a>`;
//     const toAddress = `<a href="${toLink}">Swap Tracker (${tx.to ?? "unknown"})</a>`;

//     const tokenAgeStr = tokenCreationDate ? formatTokenAge(tokenCreationDate) : "Unknown age";

//     const message = `
// <b>Swap Detected</b>
// Transaction: <a href="${etherscanLink}">${tx.hash}</a>
// From: ${fromAddress}
// To: ${toAddress}
// Platform: ${platform}
// Token: ${tokenName} (${tokenSymbol}), decimals: ${tokenDecimals}
// Token Address: ${tokenContractAddress ?? "unknown"}
// Token Age: ${tokenAgeStr}
// Block: ${tx.blockNumber}
//     `.trim();

//     if (!bot || !chatId) {
//       console.warn("Telegram bot or chatId not configured; skipping telegram notification.");
//       return;
//     }

//     await bot.sendMessage(chatId, message, { parse_mode: "HTML" });

//     // Optionally send delete notification to another chat id if provided
//     if (deleteNotificationChatId) {
//       await bot.sendMessage(deleteNotificationChatId, `Notification sent for tx ${tx.hash}`, { parse_mode: "HTML" });
//     }

//     console.log("Telegram notification sent for swap transaction:", tx.hash);
//   } catch (err: any) {
//     console.error("Error sending Telegram message:", err?.message ?? err);
//   }
// }

// /**
//  * Main SwapTrack function
//  * - starts provider block listener
//  * - scans txs in block for swap-like transactions (this function expects decoded logs scanning elsewhere)
//  * - simplified here to demonstrate the converted structure from original gist
//  */
// export async function SwapTrack(): Promise<void> {
//   const chalk = await importChalk();
//   try {
//     await connectToMongo();

//     console.log(chalk.yellow ? chalk.yellow("Starting Swap tracking...") : "Starting Swap tracking...");

//     // Example: listen to new blocks and scan transactions
//     provider.on("block", async (blockNumber: number) => {
//       try {
//         console.log(`New block: ${blockNumber}`);
//         const block = await provider.getBlock(blockNumber);
//         if (!block) return;

//         // provider.getBlock returns transaction hashes array — fetch full txs:
//         const txPromises = (block.transactions || []).map(txHash => provider.getTransaction(txHash));
//         const txs = await Promise.all(txPromises);

//         let foundTransaction = false;
//         for (const tx of txs) {
//           if (!tx) continue;

//           // Original logic in the gist checked swap logs, token addresses, etc.
//           // Here we demonstrate typical flow: decode logs, detect token & platform, then notify.
//           // You will want to re-use your existing log decoding logic (like in mev.ts).
//           // For now, attempt to decode logs via provider.getTransactionReceipt
//           const receipt = await provider.getTransactionReceipt(tx.hash).catch(() => null);
//           if (!receipt) continue;

//           // naive detection: check logs for 'Swap' topics (v2 or v3)
//           const hasSwap = receipt.logs.some(l => {
//             return l.topics?.some(t => t && (t === ethers.utils.id("Swap(address,uint256,uint256,uint256,uint256,address)") || t === ethers.utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)")));
//           });

//           if (!hasSwap) continue;

//           // If swap logs present, extract token pair info (best effort using first log address)
//           const log0 = receipt.logs[0];
//           const pairAddress = log0?.address;
//           const tokenAddrs = await getTokenAddresses(pairAddress);
//           const tokenAddr = tokenAddrs.token0 ?? tokenAddrs.token1 ?? null;
//           const tokenDetails = await getTokenDetails(tokenAddr);

//           // In the original code the "platform" was derived from parsing logs; we'll set a best-guess
//           const platform = "Uniswap-like";

//           // Simple token creation date: not provided here — left as undefined or could be retrieved from external indexer
//           const tokenCreationDate = undefined;

//           // send notification for this swap
//           await sendTelegramMessage(tx as TxLike, tokenAddr, tokenDetails.name, tokenDetails.symbol, tokenDetails.decimals, platform, tokenCreationDate);

//           foundTransaction = true;
//         }

//         if (!foundTransaction) {
//           // Optionally log or notify that no relevant transactions were found
//           // (original gist had notifyNoTransactionsFound)
//         }
//       } catch (err: any) {
//         console.error(chalk.red ? chalk.red(`Error processing block ${blockNumber}:`) : `Error processing block ${blockNumber}:`, err?.message ?? err);
//       }
//     });

//     // provider errors
//     provider.on("error", async (err: any) => {
//       console.error("Provider error:", err);
//     });

//     // graceful shutdown
//     process.once("SIGINT", async () => {
//       const chalkLocal = await importChalk();
//       console.log(chalkLocal.yellow ? chalkLocal.yellow("SIGINT received. Stopping Swap tracking.") : "SIGINT received. Stopping Swap tracking.");
//       if (db) {
//         // close client if possible — client not exported, but the connection is alive within MongoClient
//         try {
//           // @ts-ignore - best-effort: close underlying client if present
//           await (db as any).client?.close?.();
//         } catch {}
//       }
//       process.exit(0);
//     });
//   } catch (err: any) {
//     console.error("Error in SwapTrack:", err?.message ?? err);
//     if (bot && chatId) {
//       try {
//         await bot.sendMessage(chatId, `Error in SwapTrack: ${(err as Error).message}`, { parse_mode: "HTML" });
//       } catch {}
//     }
//   }
// }

// export default { SwapTrack };
