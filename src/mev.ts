// // src/mev.ts
// import { ethers } from "ethers";
// import dotenv from "dotenv";
// import TelegramBot from "node-telegram-bot-api";
// import { MongoClient, Db, Collection } from "mongodb";

// dotenv.config();

// /**
//  * NOTE:
//  * - This file assumes ethers providers (JsonRpcProvider) API.
//  * - Adjust imports/types if you use ethers v6 vs v5 (this code aims for compatibility).
//  */

// /* ------------------------
//    Types
//    ------------------------ */
// type TokenDetails = {
//   name: string;
//   symbol: string;
//   decimals: number;
// };

// type DecodedLog = {
//   platform: "Uniswap V2" | "Uniswap V3";
//   log: ethers.utils.LogDescription;
//   address: string;
// };

// type TxLike = ethers.providers.TransactionResponse & {
//   hash: string;
//   from: string;
//   to?: string | null;
//   blockNumber?: number | null;
// };

// type TxReceiptLike = ethers.providers.TransactionReceipt & {
//   logs: ethers.providers.Log[];
// };

// /* ------------------------
//    Config & Globals
//    ------------------------ */

// const processedBlocks = new Set<number>();
// const firstTransactionCache = new Set<string>();

// // Provider setup (use JSON RPC / Infura URL provided in env)
// const infuraUrl = process.env.MEV_INFURA_URL;
// if (!infuraUrl) {
//   console.warn("Warning: MEV_INFURA_URL not set. Provider may fail.");
// }
// const provider = new ethers.providers.JsonRpcProvider(infuraUrl);

// // Telegram bot
// const botToken = process.env.TELEGRAM_MEVBOT_TOKEN;
// const chatId = process.env.TELEGRAM_MEVSWAP_CHANNEL_ID;
// if (!botToken) {
//   console.warn("Warning: TELEGRAM_MEVBOT_TOKEN not set. Telegram messages will fail.");
// }
// const bot = botToken ? new TelegramBot(botToken, { polling: false }) : null;

// // MongoDB
// const mongoUrl = process.env.MONGODB_URL;
// const dbName = "blockchain";
// const collectionName = "TokenList";

// let db: Db | undefined;
// let collection: Collection | undefined;

// (async function connectToMongoDB() {
//   if (!mongoUrl) {
//     console.warn("MONGODB_URL not set — MongoDB features will be disabled.");
//     return;
//   }
//   try {
//     const client = new MongoClient(mongoUrl);
//     await client.connect();
//     db = client.db(dbName);
//     const collections = await db
//       .listCollections({ name: collectionName })
//       .toArray();
//     if (collections.length === 0) {
//       await db.createCollection(collectionName);
//       console.log(`Collection ${collectionName} created`);
//     }
//     collection = db.collection(collectionName);
//     console.log("Connected to MongoDB ✅");
//   } catch (error: any) {
//     console.error("Error connecting to MongoDB:", error?.message ?? error);
//   }
// })();

// /* ------------------------
//    Event signatures & ABIs
//    ------------------------ */

// const uniswapV2EventSignature = ethers.id(
//   "Swap(address,uint256,uint256,uint256,uint256,address)"
// );
// const uniswapV3EventSignature = ethers.id(
//   "Swap(address,address,int256,int256,uint160,uint128,int24)"
// );

// // Uniswap V2 Pair ABI (minimal)
// const uniswapV2PairABI = [
//   "function token0() external view returns (address)",
//   "function token1() external view returns (address)",
// ];

// // ERC-20 token ABI (minimal)
// const erc20ABI = [
//   "function name() external view returns (string)",
//   "function symbol() external view returns (string)",
//   "function decimals() external view returns (uint8)",
//   "function balanceOf(address owner) external view returns (uint256)",
// ];

// /* ------------------------
//    Utilities
//    ------------------------ */

// function weiToEth(weiAmount: ethers.BigNumberish): number {
//   try {
//     const bn = ethers.BigNumber.from(weiAmount);
//     // convert using 18 decimals
//     const eth = Number(ethers.utils.formatUnits(bn, 18));
//     // round to 2 decimals
//     return parseFloat(eth.toFixed(2));
//   } catch (error: any) {
//     console.error("Error converting wei to ETH:", error?.message ?? error);
//     return 0;
//   }
// }

// function formatNumber(value: number): string {
//   if (value >= 1e12) return (value / 1e12).toFixed(2) + "T";
//   if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
//   if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
//   if (value >= 1e3) return (value / 1e3).toFixed(2) + "K";
//   return value.toString();
// }

// function amountToDecimal(
//   amount: ethers.BigNumberish | bigint | number,
//   decimals: number,
//   isUniswapV3 = false
// ): string {
//   try {
//     const amtBN = ethers.BigNumber.from(amount as any);

//     if (decimals === 0) {
//       return amtBN.toString();
//     }

//     // Handle Uniswap V3 negative amounts logic if necessary (we'll treat negative as absolute)
//     // In ethers BigNumber is unsigned, but original logic used negative check for V3; keep parity:
//     // we simply format absolute value.
//     const abs = amtBN.abs ? amtBN.abs() : amtBN;
//     const decimalStr = ethers.utils.formatUnits(abs, decimals);
//     const decimalNum = Number(decimalStr);
//     return formatNumber(decimalNum);
//   } catch (error: any) {
//     console.error("Error converting amount using decimals:", error?.message ?? error);
//     return "0";
//   }
// }

// /* ------------------------
//    Blockchain helpers
//    ------------------------ */

// async function getTokenAddresses(pairAddress: string): Promise<{
//   token0: string | null;
//   token1: string | null;
// }> {
//   try {
//     const pairContract = new ethers.Contract(pairAddress, uniswapV2PairABI, provider);
//     const token0 = await pairContract.token0();
//     const token1 = await pairContract.token1();
//     console.log(`Fetched token addresses for pair ${pairAddress}`);
//     return { token0, token1 };
//   } catch (error: any) {
//     console.error(
//       `Error fetching token addresses for pair ${pairAddress}:`,
//       error?.message ?? error
//     );
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
//   } catch (error: any) {
//     console.error(
//       `Error fetching token details for address ${tokenAddress}:`,
//       error?.message ?? error
//     );
//     return { name: "Unknown", symbol: "Unknown", decimals: 0 };
//   }
// }

// /**
//  * Check if a tx.to address had non-zero balance for token at previous block (blockNumber - 1)
//  * This mirrors original logic; note many providers may not support blockTag for token.balanceOf.
//  */
// async function isFirstTransactionForToken(
//   tokenAddress: string,
//   userAddress: string,
//   blockNumber?: number | null
// ): Promise<boolean> {
//   if (!blockNumber) return false;
//   try {
//     const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, provider);
//     // Some providers allow balanceOf with blockTag; ethers.js supports provider.getBalance with blockTag,
//     // but tokenContract.balanceOf may not accept a blockTag depending on provider configuration.
//     // We attempt the call with overrides; if it fails, return false.
//     // Use provider.call to invoke ERC20 balanceOf at previous block:
//     const iface = new ethers.utils.Interface(erc20ABI);
//     const data = iface.encodeFunctionData("balanceOf", [userAddress]);
//     const res = await provider.call(
//       {
//         to: tokenAddress,
//         data,
//       },
//       blockNumber - 1
//     );
//     const decoded = iface.decodeFunctionResult("balanceOf", res);
//     const balance = ethers.BigNumber.from(decoded[0]);
//     return balance.isZero();
//   } catch (error: any) {
//     console.error(
//       `Error checking token balance for ${tokenAddress} and user ${userAddress}:`,
//       error?.message ?? error
//     );
//     return false;
//   }
// }

// async function getFormattedBlockDateTime(blockNumber: number): Promise<string> {
//   try {
//     const block = await provider.getBlock(blockNumber);
//     if (!block || !block.timestamp) return "Unknown Date and Time";
//     const timestamp = new Date(block.timestamp * 1000);
//     const formattedDate = timestamp.toLocaleDateString();
//     const formattedTime = timestamp.toLocaleTimeString();
//     return `${formattedDate} ${formattedTime}`;
//   } catch (error: any) {
//     console.error(
//       `Error fetching block timestamp for block ${blockNumber}:`,
//       error?.message ?? error
//     );
//     return "Unknown Date and Time";
//   }
// }

// /* ------------------------
//    Message/Log decode + send
//    ------------------------ */

// async function sendTelegramMessage(tx: TxLike, decodedLogs: DecodedLog[]): Promise<void> {
//   if (!bot || !chatId) {
//     console.warn("Telegram bot or chatId not configured; skipping sendTelegramMessage.");
//     return;
//   }

//   try {
//     const etherscanLink = `https://etherscan.io/tx/${tx.hash}`;
//     const fromLink = `https://etherscan.io/address/${tx.from}`;
//     const toLink = `https://etherscan.io/address/${tx.to ?? "unknown"}`;

//     // Try resolving ENS (may return null)
//     const ensName = await provider.lookupAddress(tx.from);
//     const fromAddress = ensName ? `<a href="${fromLink}">${ensName}</a>` : `<a href="${fromLink}">${tx.from}</a>`;
//     const toAddress = `<a href="${toLink}">MEV BOT (${tx.to ?? "unknown"})</a>`;

//     const logDetailsArr = await Promise.all(
//       decodedLogs.map(async (log) => {
//         try {
//           let amountIn: ethers.BigNumberish;
//           let amountOut: ethers.BigNumberish;
//           let tokenIn: string | null = null;
//           let tokenOut: string | null = null;
//           let tokenInDetails: TokenDetails = { name: "Unknown", symbol: "Unknown", decimals: 0 };
//           let tokenOutDetails: TokenDetails = { name: "Unknown", symbol: "Unknown", decimals: 0 };

//           if (log.platform === "Uniswap V2") {
//             // For v2, args are: amount0In, amount1In, amount0Out, amount1Out
//             // Original code used amount1In / amount0Out; follow that logic to determine "in/out"
//             amountIn = log.log.args.amount1In;
//             amountOut = log.log.args.amount0Out;

//             const tokenAddresses = await getTokenAddresses(log.address);
//             tokenIn = tokenAddresses.token0;
//             tokenOut = tokenAddresses.token1;
//           } else {
//             // Uniswap V3
//             // args: amount0, amount1
//             amountIn = log.log.args.amount0;
//             amountOut = log.log.args.amount1;
//             const tokenAddresses = await getTokenAddresses(log.address);
//             tokenIn = tokenAddresses.token0;
//             tokenOut = tokenAddresses.token1;
//           }

//           tokenInDetails = await getTokenDetails(tokenIn);
//           tokenOutDetails = await getTokenDetails(tokenOut);

//           const amountInEth = weiToEth(amountIn);
//           const amountOutDecimal = amountToDecimal(amountOut, tokenInDetails.decimals, log.platform === "Uniswap V3");

//           // Skip if Amount In is 0 ETH or decimals is 0 or Amount Out is 0
//           if (amountInEth === 0 || tokenInDetails.decimals === 0 || amountOutDecimal === "0") {
//             return null;
//           }

//           // Check if it's the first transaction for the token by the tx.to address
//           const isFirstTransaction = tokenIn ? await isFirstTransactionForToken(tokenIn, tx.to ?? "", tx.blockNumber) : false;
//           if (!isFirstTransaction || (tokenIn && firstTransactionCache.has(tokenIn))) {
//             return null;
//           }

//           if (tokenIn) firstTransactionCache.add(tokenIn);
//           console.log(`First transaction detected for token: ${tokenIn}`);

//           let firstTransactionDateTime = "";
//           if (isFirstTransaction && tx.blockNumber) {
//             firstTransactionDateTime = await getFormattedBlockDateTime(tx.blockNumber);
//           }

//           // Persist to MongoDB if configured
//           if (isFirstTransaction && collection && tokenIn) {
//             await collection.insertOne({
//               token: tokenIn,
//               user: tx.to,
//               blockNumber: tx.blockNumber,
//               dateTime: firstTransactionDateTime,
//               details: {
//                 name: tokenInDetails.name,
//                 symbol: tokenInDetails.symbol,
//                 decimals: tokenInDetails.decimals,
//                 amountInEth,
//                 amountOut: amountOutDecimal,
//               },
//             });
//             console.log(`Stored first transaction details for token: ${tokenIn} in MongoDB`);
//           }

//           const name = log.platform === "Uniswap V2" ? tokenInDetails.name : tokenOutDetails.name;
//           const symbol = log.platform === "Uniswap V2" ? tokenInDetails.symbol : tokenOutDetails.symbol;
//           const decimals = log.platform === "Uniswap V2" ? tokenInDetails.decimals : tokenOutDetails.decimals;

//           return `Platform: ${log.platform}\n Token Bought ✅: ${name} (${symbol}, ${decimals} decimals) (${tokenIn})\n Amount In: ${amountInEth} ETH\n Amount Out: ${amountOutDecimal} ${symbol}\n First Transaction: ${isFirstTransaction ? 'Yes' : 'No'}\n${isFirstTransaction ? `Time: ${firstTransactionDateTime}` : ''}\n`;
//         } catch (err) {
//           console.error("Error processing decoded log entry:", err);
//           return null;
//         }
//       })
//     );

//     const filteredLogDetails = logDetailsArr.filter((d): d is string => d !== null);
//     if (filteredLogDetails.length === 0) {
//       console.log("No valid swap logs found with non-zero Amount In or valid decimals or no first transaction.");
//       return;
//     }

//     console.log("Sending Telegram message...");

//     const message = `Transaction Detected ✅\nTransaction Hash: ${tx.hash}\nBlock Number: ${tx.blockNumber}\nFrom: ${fromAddress}\nTo: ${toAddress}\n\nLogs:\n${filteredLogDetails.join("\n\n")}`;

//     await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
//     console.log("First transaction notification sent.");
//   } catch (error: any) {
//     console.error("Error sending Telegram message in mevbot:", error?.message ?? error);
//   }
// }

// function decodeLogs(logs: ethers.providers.Log[]): DecodedLog[] {
//   try {
//     const ifaceV2 = new ethers.utils.Interface([
//       "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
//     ]);
//     const ifaceV3 = new ethers.utils.Interface([
//       "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
//     ]);

//     const decodedLogs: DecodedLog[] = [];

//     for (const log of logs) {
//       const topic0 = log.topics && log.topics[0] ? log.topics[0] : "";
//       if (topic0 === uniswapV2EventSignature) {
//         const decodedLog = ifaceV2.parseLog(log);
//         decodedLogs.push({ platform: "Uniswap V2", log: decodedLog, address: log.address });
//       } else if (topic0 === uniswapV3EventSignature) {
//         const decodedLog = ifaceV3.parseLog(log);
//         decodedLogs.push({ platform: "Uniswap V3", log: decodedLog, address: log.address });
//       }
//     }

//     console.log("Logs decoded successfully.");
//     return decodedLogs;
//   } catch (error: any) {
//     console.error("Error decoding logs:", error?.message ?? error);
//     return [];
//   }
// }

// async function getTransactionData(txHash: string): Promise<void> {
//   try {
//     // Note: ethers provider has getTransactionReceipt (v5) / getTransactionReceipt (v6) as well
//     const receipt = (await provider.getTransactionReceipt(txHash)) as TxReceiptLike | null;
//     if (!receipt) {
//       console.log("Transaction receipt not found.");
//       return;
//     }

//     // Decode logs
//     const decodedLogs = decodeLogs(receipt.logs);
//     if (decodedLogs.length > 0) {
//       const tx = (await provider.getTransaction(txHash)) as TxLike | null;
//       if (!tx) {
//         console.log("Transaction not found.");
//         return;
//       }
//       await sendTelegramMessage(tx, decodedLogs);
//     } else {
//       console.log("No Uniswap V2 or V3 swap logs found in this transaction.");
//     }
//   } catch (error: any) {
//     console.error("Error getting transaction data:", error?.message ?? error);
//   }
// }

// /* ------------------------
//    Main tracking function
//    ------------------------ */

// /**
//  * Start tracking MEV-like transactions.
//  *
//  * Uses provider.on('block') to process each new block, inspects transactions,
//  * and for matching transactions (from -> to addresses), decodes logs & notifies.
//  */
// export async function startMEVTracking(): Promise<void> {
//   const fromAddress = process.env.MEV_TX_FROM;
//   const toAddress = process.env.MEV_BOT_ADDRESS;

//   if (!fromAddress || !toAddress) {
//     console.warn("MEV_TX_FROM or MEV_BOT_ADDRESS not set; startMEVTracking will not proceed.");
//     return;
//   }

//   provider.on("block", async (blockNumber: number) => {
//     try {
//       if (processedBlocks.has(blockNumber)) {
//         console.log(`Block ${blockNumber} has already been processed.`);
//         return;
//       }
//       processedBlocks.add(blockNumber);
//       console.log(`New block detected: ${blockNumber}`);

//       const block = await provider.getBlock(blockNumber);
//       if (!block) {
//         console.warn("Block not found.");
//         return;
//       }

//       // block.transactions may be an array of tx hashes or full tx objects depending on provider call;
//       // here we assume it's an array of transaction hashes (string[]).
//       const txHashes: string[] = Array.isArray(block.transactions)
//         ? (block.transactions as string[])
//         : [];

//       console.log(`Processing block: ${blockNumber}, Transactions: ${txHashes.length}`);

//       // Fetch transactions in parallel
//       const txs = await Promise.all(txHashes.map((h) => provider.getTransaction(h)));

//       for (const tx of txs) {
//         if (!tx) continue;
//         const from = tx.from ? tx.from.toLowerCase() : "";
//         const to = tx.to ? tx.to.toLowerCase() : "";
//         if (from === fromAddress.toLowerCase() && to === toAddress.toLowerCase()) {
//           console.log(`MEV BOT transaction detected: ${tx.hash}`);
//           await getTransactionData(tx.hash);
//         }
//       }
//     } catch (error: any) {
//       console.error(`Error processing block ${blockNumber}:`, error?.message ?? error);
//     }
//   });
// }

// /* default export for convenience */
// export default { startMEVTracking };
