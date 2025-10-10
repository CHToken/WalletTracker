// // src/usage.ts
// import dotenv from "dotenv";
// import { MongoClient, Db, Collection } from "mongodb";
// import TelegramBot from "node-telegram-bot-api";
// import { format } from "date-fns";

// dotenv.config();

// /**
//  * usage.ts
//  * Converted from usage.js -> TypeScript (ESM)
//  *
//  * Purpose:
//  *  - Tracks usage statistics for the bot (transactions processed, errors, uptime)
//  *  - Sends periodic summaries to Telegram
//  *
//  * Env variables expected:
//  *  MONGODB_URL, TELEGRAM_USAGE_BOT_TOKEN, TELEGRAM_USAGE_CHAT_ID
//  */

// const MONGO_URL = process.env.MONGODB_URL ?? "";
// const DB_NAME = "bot_monitor";
// const COLLECTION_NAME = "usage_stats";

// const TELEGRAM_TOKEN = process.env.TELEGRAM_USAGE_BOT_TOKEN ?? "";
// const TELEGRAM_CHAT_ID = process.env.TELEGRAM_USAGE_CHAT_ID ?? "";

// let db: Db | undefined;
// let collection: Collection<UsageStat> | undefined;
// const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN, { polling: false }) : null;

// export interface UsageStat {
//   timestamp: number;
//   action: string;
//   success: boolean;
//   details?: string;
//   latencyMs?: number;
// }

// /**
//  * Connect to MongoDB
//  */
// async function connectMongo(): Promise<void> {
//   if (!MONGO_URL) {
//     console.warn("MONGODB_URL not set — skipping MongoDB connection.");
//     return;
//   }
//   try {
//     const client = new MongoClient(MONGO_URL);
//     await client.connect();
//     db = client.db(DB_NAME);

//     const exists = await db.listCollections({ name: COLLECTION_NAME }).toArray();
//     if (exists.length === 0) {
//       await db.createCollection(COLLECTION_NAME);
//     }
//     collection = db.collection<UsageStat>(COLLECTION_NAME);
//     console.log("Connected to MongoDB for usage tracking");
//   } catch (err: any) {
//     console.error("MongoDB connection error:", err?.message ?? err);
//   }
// }

// /**
//  * Record an action usage
//  */
// export async function recordUsage(action: string, success = true, details?: string, latencyMs?: number): Promise<void> {
//   try {
//     if (!collection) await connectMongo();
//     if (!collection) return;

//     const stat: UsageStat = {
//       timestamp: Date.now(),
//       action,
//       success,
//       details,
//       latencyMs,
//     };

//     await collection.insertOne(stat);
//   } catch (err: any) {
//     console.error("Error recording usage stat:", err?.message ?? err);
//   }
// }

// /**
//  * Generate usage summary (for Telegram or CLI)
//  */
// export async function generateUsageSummary(): Promise<string> {
//   if (!collection) await connectMongo();
//   if (!collection) return "⚠️ Usage collection unavailable.";

//   const since = Date.now() - 24 * 60 * 60 * 1000; // last 24h
//   const recentStats = await collection
//     .find({ timestamp: { $gte: since } })
//     .sort({ timestamp: -1 })
//     .toArray();

//   if (recentStats.length === 0) {
//     return "No usage data recorded in the past 24 hours.";
//   }

//   const total = recentStats.length;
//   const successCount = recentStats.filter((x) => x.success).length;
//   const failCount = total - successCount;
//   const avgLatency =
//     recentStats.reduce((acc, x) => acc + (x.latencyMs ?? 0), 0) /
//     (recentStats.filter((x) => x.latencyMs).length || 1);

//   const uptimePercent = ((successCount / total) * 100).toFixed(2);
//   const lastAction = recentStats[0]?.action ?? "N/A";
//   const lastTime = format(new Date(recentStats[0]?.timestamp ?? Date.now()), "yyyy-MM-dd HH:mm:ss");

//   return [
//     "📊 <b>Bot Usage Summary (24h)</b>",
//     "",
//     `✅ Successful: <b>${successCount}</b>`,
//     `❌ Failed: <b>${failCount}</b>`,
//     `⚡ Avg Latency: <b>${avgLatency.toFixed(1)}ms</b>`,
//     `🕒 Uptime: <b>${uptimePercent}%</b>`,
//     "",
//     `🧩 Last Action: ${lastAction}`,
//     `📅 Last Recorded: ${lastTime}`,
//   ].join("\n");
// }

// /**
//  * Send summary to Telegram
//  */
// export async function sendUsageSummary(): Promise<void> {
//   if (!bot || !TELEGRAM_CHAT_ID) {
//     console.warn("Telegram not configured for usage summary.");
//     return;
//   }

//   const message = await generateUsageSummary();

//   try {
//     await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: "HTML" });
//     console.log("Usage summary sent to Telegram.");
//   } catch (err: any) {
//     console.error("Error sending usage summary:", err?.message ?? err);
//   }
// }

// /**
//  * Run as a periodic monitor (every N minutes)
//  */
// export async function startUsageMonitor(intervalMinutes = 30): Promise<void> {
//   await connectMongo();
//   console.log(`Usage monitor started — reporting every ${intervalMinutes} minutes.`);

//   // Immediately send one on startup
//   await sendUsageSummary();

//   setInterval(async () => {
//     await sendUsageSummary();
//   }, intervalMinutes * 60 * 1000);
// }

// process.once("SIGINT", async () => {
//   console.log("SIGINT received. Closing usage tracker.");
//   try {
//     // @ts-ignore
//     await (db as any)?.client?.close?.();
//   } catch {}
//   process.exit(0);
// });

// export default {
//   recordUsage,
//   generateUsageSummary,
//   sendUsageSummary,
//   startUsageMonitor,
// };
