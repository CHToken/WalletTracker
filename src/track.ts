import dotenv from "dotenv";
import { ethers, FetchRequest } from "ethers";
import TelegramBot from "node-telegram-bot-api";
import { MongoClient, Db, Collection } from "mongodb";
import fs from "fs";
import path from "path";
import PQueue from "p-queue";

dotenv.config();

// 🧩 Environment Variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TRACK_BOT_TOKEN ?? "";
const TELEGRAM_DEPOSIT_CHANNEL_ID = process.env.TELEGRAM_DEPOSIT_CHANNEL_ID ?? "";
const TELEGRAM_CONFIRMED_DEPOSIT_CHANNEL_ID = process.env.TELEGRAM_CONFIRMED_DEPOSIT_CHANNEL_ID ?? "";
const MONGO_URL = process.env.MONGODB_URL ?? "";

console.log("📨 Telegram token:", TELEGRAM_TOKEN ? "✅ found" : "❌ missing");
console.log("📨 Deposit channel ID:", TELEGRAM_DEPOSIT_CHANNEL_ID ? "✅ found" : "❌ missing");
console.log("📨 Confirmed deposit channel ID:", TELEGRAM_CONFIRMED_DEPOSIT_CHANNEL_ID ? "✅ found" : "❌ missing");
console.log("📨 MongoDB URL:", MONGO_URL ? "✅ found" : "❌ missing");

// 🧩 Config Paths
const CONFIG_PATH = path.join(__dirname, "config.json");
const RPC_CONFIG_PATH = path.join(__dirname, "rpc-config.json");

// 🧩 Load Configs
let config: any = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};
if (!fs.existsSync(CONFIG_PATH)) console.warn("⚠️ config.json not found!");

// 🧩 Load RPC config
if (!fs.existsSync(RPC_CONFIG_PATH)) {
  console.error("❌ rpc-config.json not found! Add your RPC list.");
  process.exit(1);
}


let rpcConfig: any = JSON.parse(fs.readFileSync(RPC_CONFIG_PATH, "utf8"));

// 🔧 Replace ${VAR_NAME} with process.env.VAR_NAME (recursive)
function resolveEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => {
      const val = process.env[name];
      if (!val) {
        console.error(`❌ Missing environment variable: ${name}`);
        process.exit(1);
      }
      return val;
    });
  } else if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  } else if (typeof obj === "object" && obj !== null) {
    const result: any = {};
    for (const key in obj) result[key] = resolveEnvVars(obj[key]);
    return result;
  }
  return obj;
}

// 🧩 Substitute environment variables dynamically
rpcConfig = resolveEnvVars(rpcConfig);

const DB_NAME = "blockchain";
const TRANSFER_TX_COLLECTION = "TransferTransactions";
const PENDING_TX_COLLECTION = "PendingTransactions";

// 🧩 Filter ETH RPCs
const ethRpcs = rpcConfig.rpcs?.filter((rpc: any) => rpc.name.includes("eth")) ?? [];
console.log(`📡 Loaded ${ethRpcs.length} ETH RPCs: ${ethRpcs.map((r: any) => r.name).join(", ")}`);
if (ethRpcs.length === 0) {
  console.error("❌ No ETH RPCs found in config!");
  process.exit(1);
}

// 🧩 HTTP Fallback Provider
const httpProviders = ethRpcs.map((rpc: any) => {
  const fetchReq = new FetchRequest(rpc.http);
  fetchReq.timeout = 10000;
  console.log(`🔗 Creating HTTP provider for ${rpc.name}`);
  return new ethers.JsonRpcProvider(fetchReq);
});
const httpProvider = new ethers.FallbackProvider(httpProviders, 1);

// 🧩 Multi WS Provider
class MultiWsProvider {
  private wsProviders: { provider: ethers.WebSocketProvider; name: string }[] = [];
  private httpFallback: ethers.Provider;
  private blockListeners: Set<(blockNumber: number) => void> = new Set();
  private pendingListeners: Set<(txHash: string) => void> = new Set();
  private txHashesSeen: Set<string> = new Set();
  private nextTxIndex = 0;

  constructor(rpcConfigs: any[], httpFallbackProvider: ethers.Provider) {
    this.httpFallback = httpFallbackProvider;
    this.wsProviders = rpcConfigs
      .filter((rpc) => rpc.ws)
      .map((rpc) => {
        const provider = new ethers.WebSocketProvider(rpc.ws);
        console.log(`🔗 WS provider created: ${rpc.name}`);
        return { provider, name: rpc.name };
      });
  }

  async connect(): Promise<void> {
    if (this.wsProviders.length === 0) {
      console.warn("⚠️ No WS providers, relying on HTTP polling.");
      return;
    }

    for (const { provider, name } of this.wsProviders) {
      try {
        await provider.getNetwork();
        console.log(`✅ Connected to WS: ${name}`);

        provider.on("block", (blockNumber: number) => {
          this.blockListeners.forEach((fn) => fn(blockNumber));
        });

        provider.on("pending", (txHash: string) => {
          if (typeof txHash === "string" && !this.txHashesSeen.has(txHash)) {
            this.txHashesSeen.add(txHash);
            this.pendingListeners.forEach((fn) => fn(txHash));
            setTimeout(() => this.txHashesSeen.delete(txHash), 5 * 60 * 1000);
          }
        });

        if (provider.websocket) {
          provider.websocket.close = () => {
            console.warn(`⚠️ WS ${name} disconnected`);
          };
        }
      } catch (err: any) {
        console.error(`❌ WS connection failed for ${name}: ${err.message}`);
      }
    }
  }

  on(event: "block" | "pending", listener: any) {
    if (event === "block") this.blockListeners.add(listener);
    if (event === "pending") this.pendingListeners.add(listener);
  }

  async getTransaction(hash: string): Promise<ethers.TransactionResponse | null> {
    if (this.wsProviders.length > 0) {
      const provider = this.wsProviders[this.nextTxIndex].provider;
      this.nextTxIndex = (this.nextTxIndex + 1) % this.wsProviders.length;
      try {
        return await provider.getTransaction(hash);
      } catch {
        // fallback
      }
    }
    return await this.httpFallback.getTransaction(hash);
  }

  async getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null> {
    try {
      return await this.httpFallback.getTransactionReceipt(hash);
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.wsProviders.forEach(({ provider }) => provider.destroy());
  }
}

const wsProvider = new MultiWsProvider(ethRpcs, httpProvider);
const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN, { polling: false }) : null;

let mongoClient: MongoClient | null = null;
let db: Db | null = null;
let transferTxCollection: Collection | null = null;
let pendingTxCollection: Collection | null = null;

// 🧩 MongoDB Init
async function initMongo(): Promise<void> {
  if (!MONGO_URL) return;
  mongoClient = new MongoClient(MONGO_URL);
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  transferTxCollection = db.collection(TRANSFER_TX_COLLECTION);
  pendingTxCollection = db.collection(PENDING_TX_COLLECTION);
  console.log("✅ Connected to MongoDB");
}

// 🧩 Helpers
const shortenAddress = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const weiToEth = (w: bigint) => Number(ethers.formatEther(w));

// 🧩 Telegram Message Sender (with retry & HTML)
async function sendTelegramNotification(message: string, confirmed = false, telegramQueue: any): Promise<void> {
  if (!bot) return;
  const chatId = confirmed ? TELEGRAM_CONFIRMED_DEPOSIT_CHANNEL_ID : TELEGRAM_DEPOSIT_CHANNEL_ID;
  if (!chatId) return;

  await telegramQueue.add(async () => {
    for (let retries = 3; retries > 0; retries--) {
      try {
        await bot.sendMessage(chatId, message, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        return;
      } catch (err: any) {
        if (err.code === "ETELEGRAM" && err.response?.statusCode === 429) {
          const retryAfter = Number(err.response.headers?.["retry-after"] ?? 5);
          console.warn(`⚠️ Rate limited — retrying after ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1500));
        } else {
          console.error("❌ Telegram send failed:", err.message);
        }
      }
    }
  });
}

function getTagForAddress(address: string): string {
  const wallet = config.exchangeWallets?.find(
    (w: any) => w.address.toLowerCase() === address.toLowerCase()
  );
  return wallet ? wallet.tag : "";
}

async function storeTransaction(tx: any, pending = false): Promise<void> {
  if (!db) return;
  const collection = pending ? pendingTxCollection : transferTxCollection;
  if (!collection) return;
  await collection.updateOne({ hash: tx.hash }, { $set: tx }, { upsert: true });
}

// 🧩 Message Templates — Box Style
const templates = {
  pending: (from: string, to: string, amount: number, tag: string, etherscanUrl: string) => `
╔══════════════════════════╗
⚡ <b>Pending ETH Transfer</b>
╚══════════════════════════╝
<b>📤 From:</b> <code>${from}</code> ${tag ? "(" + tag + ")" : ""}
<b>📥 To:</b> <code>${to}</code>
<b>💸 Amount:</b> ${amount} ETH
<b>⏳ Status:</b> <b>Pending Confirmation</b>

<a href="${etherscanUrl}">🔗 View on Etherscan</a>
———————————————`,

  confirmed: (from: string, to: string, amount: number, tag: string, etherscanUrl: string) => `
╔══════════════════════════╗
✅ <b>Confirmed ETH Transfer</b>
╚══════════════════════════╝
<b>📤 From:</b> <code>${from}</code> ${tag ? "(" + tag + ")" : ""}
<b>📥 To:</b> <code>${to}</code>
<b>💸 Amount:</b> <b>${amount}</b> ETH
<b>🕒 Status:</b> <b>Confirmed</b>

<a href="${etherscanUrl}">🔗 View on Etherscan</a>
———————————————`,
};

// 🧠 Main Tracker
export async function Track(): Promise<void> {
  // 🧩 Telegram Queue
  const telegramQueue = new PQueue({ interval: 2000, intervalCap: 1, carryoverConcurrencyCount: true });

  await initMongo();

  const exchangeWallets = config.exchangeWallets?.map((w: any) => w.address.toLowerCase()) ?? [];
  const walletSet = new Set(exchangeWallets);
  console.log(`🚀 Tracking ${walletSet.size} ETH wallets`);

  await wsProvider.connect();

  // 🧱 Confirmed TX Handler
  wsProvider.on("block", async (blockNumber: number) => {
    const block = await httpProvider.getBlock(blockNumber, true);
    if (!block?.transactions) return;

    const txs = block.transactions as unknown as readonly ethers.TransactionResponse[];
    for (const tx of txs) {
      if (!tx || tx.value === 0n || !tx.from) continue;
      const from = tx.from.toLowerCase();
      if (!walletSet.has(from)) continue;

      const to = tx.to?.toLowerCase() ?? "";
      const amount = weiToEth(tx.value);
      const tag = getTagForAddress(from);
      const msg = templates.confirmed(shortenAddress(from), shortenAddress(to), amount, tag, `https://etherscan.io/tx/${tx.hash}`);

      const exists = await pendingTxCollection?.findOne({ hash: tx.hash });
      if (exists) await pendingTxCollection?.deleteOne({ hash: tx.hash });

      await sendTelegramNotification(msg, true, telegramQueue);
      await storeTransaction({ from, to, amount, hash: tx.hash, timestamp: new Date(), confirmed: true });
      console.log(`✅ Confirmed ${amount} ETH from ${from} → ${to}`);
    }
  });

  // ⚡ Pending TX Handler
  const pendingQueue = new PQueue({ interval: 1000, intervalCap: 15, carryoverConcurrencyCount: true });

  wsProvider.on("pending", async (txHash: string) => {
    if (typeof txHash !== "string") return;
    const tx = await pendingQueue.add(async () => {
      try {
        return await wsProvider.getTransaction(txHash);
      } catch (err: any) {
        console.warn(`Failed to fetch pending tx ${txHash}: ${err.message}`);
        return null;
      }
    });
    if (!tx || !tx.from || !tx.to || tx.value === 0n) return;

    const from = tx.from.toLowerCase();
    if (!walletSet.has(from)) return;

    const to = tx.to.toLowerCase();
    const amount = weiToEth(tx.value);
    const tag = getTagForAddress(from);
    const msg = templates.pending(shortenAddress(from), shortenAddress(to), amount, tag, `https://etherscan.io/tx/${tx.hash}`);

    await sendTelegramNotification(msg, false, telegramQueue);
    await storeTransaction({ from, to, amount, hash: tx.hash, timestamp: new Date(), confirmed: false }, true);
    console.log(`⚡ Pending ${amount} ETH from ${from} → ${to}`);
  });

  // 🔁 Background Confirmation Checker
  setInterval(async () => {
    if (!pendingTxCollection) return;
    const pendingTxs = await pendingTxCollection.find({}).toArray();
    if (!pendingTxs.length) return;

    let currentBlock: number | null = null;
    try {
      currentBlock = await httpProvider.getBlockNumber();
    } catch (err: any) {
      console.warn(`Failed to get current block: ${err.message}`);
      return;
    }

    for (const tx of pendingTxs) {
      let receipt: ethers.TransactionReceipt | null = null;
      try {
        receipt = await wsProvider.getTransactionReceipt(tx.hash);
      } catch (err: any) {
        console.warn(`Failed to get receipt for ${tx.hash}: ${err.message}`);
        continue;
      }

      if (!receipt || receipt.status !== 1 || !receipt.blockNumber) continue;

      const confirmations = currentBlock - Number(receipt.blockNumber);
      if (confirmations <= 0) continue;

      // Check if already confirmed to avoid duplicates
      const alreadyConfirmed = await transferTxCollection?.findOne({ hash: tx.hash });
      if (alreadyConfirmed) {
        await pendingTxCollection.deleteOne({ hash: tx.hash });
        continue;
      }

      const ethAmount = typeof tx.amount === 'number' ? tx.amount : 0;
      if (ethAmount <= 0) continue;

      // 🧩 Format to fixed decimals for nice display
      const formattedAmount = ethAmount.toFixed(4).replace(/\.?0+$/, ""); // e.g., 1.2300 → 1.23

      const msg = templates.confirmed(
        shortenAddress(tx.from),
        shortenAddress(tx.to),
        Number(formattedAmount),
        getTagForAddress(tx.from),
        `https://etherscan.io/tx/${tx.hash}`
      );

      await sendTelegramNotification(msg, true, telegramQueue);
      await transferTxCollection?.updateOne(
        { hash: tx.hash },
        { $set: { ...tx, confirmed: true } },
        { upsert: true }
      );
      await pendingTxCollection.deleteOne({ hash: tx.hash });

      console.log(`🔁 Moved ${tx.hash} → confirmed (${formattedAmount} ETH)`);
    }
  }, 30_000);

  process.once("SIGINT", async () => {
    console.log("🛑 Shutting down...");
    wsProvider.destroy();
    await mongoClient?.close().catch(() => {});
    process.exit(0);
  });
}

export default { Track };