// src/index.ts
import dotenv from "dotenv";
import { MongoClient, Db } from "mongodb";
import moment from "moment";
import TelegramBot from "node-telegram-bot-api";
import { Track as startTrackingDeposits } from "./src/track";

dotenv.config();

// --- ENV SETUP ---
const botToken = process.env.TELEGRAM_BOT_TOKEN as string;
const chatId = process.env.TELEGRAM_CHAT_ID as string;
const mongoUri = process.env.MONGODB_URL as string;

if (!botToken || !chatId) {
  console.warn("⚠️ Missing Telegram credentials in environment variables.");
}

if (!mongoUri) {
  console.error("❌ Missing MONGODB_URL in environment variables.");
  process.exit(1);
}

const bot = new TelegramBot(botToken, { polling: true });
let client: MongoClient | null = null;

// --- Ensure MongoDB Connection ---
async function ensureConnection(): Promise<Db> {
  if (!client) {
    client = new MongoClient(mongoUri);
    await client.connect();
    console.log("✅ Connected to MongoDB");
  } else {
    try {
      await client.db("admin").command({ ping: 1 });
    } catch {
      console.log("🔄 Reconnecting MongoDB...");
      client = new MongoClient(mongoUri);
      await client.connect();
      console.log("✅ Reconnected to MongoDB");
    }
  }

  return client.db("blockchain");
}

// --- Type Definitions ---
interface DepositTransaction {
  timestamp: Date;
  [key: string]: unknown;
}

// --- Clean-up Old Records ---
async function removeOldAddresses(cutoffTime: Date): Promise<DepositTransaction[]> {
  const db = await ensureConnection();
  const collection = db.collection<DepositTransaction>("DepositTransactions");

  const query = { timestamp: { $lt: cutoffTime } };
  const oldAddresses = await collection.find(query).toArray();

  console.log(`🕒 Found ${oldAddresses.length} addresses older than cutoff time.`);

  if (oldAddresses.length > 0) {
    const result = await collection.deleteMany(query);
    console.log(`🗑️ Deleted ${result.deletedCount} old addresses.`);
  }

  return oldAddresses;
}

// --- Telegram Commands ---
bot.onText(/\/start/, (msg) => {
  const opts = {
    reply_markup: {
      keyboard: [[{ text: "Run Delete Script" }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
  bot.sendMessage(msg.chat.id, "👋 Welcome! Choose an action:", opts);
});

bot.on("message", async (msg) => {
  if (msg.text === "Run Delete Script") {
    bot.sendMessage(chatId, '⏱ Please specify the cutoff time (e.g., "5 hours", "2 days"):');

    bot.once("message", async (response) => {
      const inputText = (response.text ?? "").trim();
      const [valueStr, unit] = inputText.split(" ");
      const value = parseInt(valueStr);

      if (!value || !["hours", "days"].includes(unit)) {
        await bot.sendMessage(chatId, "❌ Invalid format. Use e.g. '5 hours' or '2 days'.");
        return;
      }

      const cutoffTime = moment()
        .subtract(value, unit as moment.unitOfTime.DurationConstructor)
        .toDate();

      const addresses = await removeOldAddresses(cutoffTime);
      const msgText =
        addresses.length > 0
          ? `✅ Deleted ${addresses.length} addresses older than ${value} ${unit}.`
          : `ℹ️ No addresses found older than ${value} ${unit}.`;

      await bot.sendMessage(chatId, msgText);
    });
  }
});

// --- Start Tracking + Cleanup ---
(async () => {
  try {
    await ensureConnection();
    console.log("🚀 Database ready. Starting deposit tracking...");

    await startTrackingDeposits(); // ✅ runs the refactored tracker from track.ts

    // Future expansion hooks:
    // await SwapTrack(db);
    // await startMEVTracking();
  } catch (error) {
    console.error("❌ Failed to start tracking:", error);
  }
})();

// --- Graceful Shutdown ---
process.once("SIGINT", async () => {
  console.log("🛑 SIGINT received. Closing MongoDB and stopping bot...");
  try {
    await client?.close();
  } catch {}
  bot.stopPolling();
  process.exit(0);
});