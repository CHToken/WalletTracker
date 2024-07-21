require('dotenv').config();
const { MongoClient } = require('mongodb');
const { startTrackingDeposits } = require('./src/track');
const { SwapTrack } = require('./src/swapTrack');
const { startMEVTracking } = require('./src/mev');
const moment = require("moment");
const TelegramBot = require("node-telegram-bot-api");

// Telegram Bot Configuration
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const bot = new TelegramBot(botToken, { polling: true });

const mongoUri = process.env.MONGODB_URL;
const client = new MongoClient(mongoUri);

async function removeOldAddresses(cutoffTime) {
  try {
    await client.connect();
    const database = client.db("blockchain");
    const collection = database.collection("DepositAddresses");

    const query = { timestamp: { $lt: cutoffTime } };

    const oldAddresses = await collection.find(query).toArray();

    console.log(`Number of addresses older than specified time: ${oldAddresses.length}`);

    if (oldAddresses.length > 0) {
      const result = await collection.deleteMany(query);
      console.log(`Deleted ${result.deletedCount} addresses older than specified time.`);
    }

    return oldAddresses;
  } catch (error) {
    console.error("Error retrieving and deleting old addresses:", error);
  } finally {
    await client.close();
  }
}

bot.onText(/\/start/, (msg) => {
  const opts = {
    reply_markup: {
      keyboard: [
        [{ text: 'Run Delete Script' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
  bot.sendMessage(msg.chat.id, 'Welcome! Choose an action:', opts);
});

bot.on('message', async (msg) => {
  if (msg.text === 'Run Delete Script') {
    bot.sendMessage(chatId, 'Please specify the cutoff time in hours or days (e.g., 5 hours, 2 days):');
    bot.once('message', async (response) => {
      const input = response.text.split(' ');

      if (input.length < 2) {
        bot.sendMessage(chatId, 'Invalid input. Please specify the cutoff time in the format "number hours" or "number days"');
        return;
      }

      const value = parseInt(input[0]);
      const unit = input[1] ? input[1].toLowerCase() : '';

      if (isNaN(value) || (unit !== 'hours' && unit !== 'days')) {
        bot.sendMessage(chatId, 'Invalid input. Please specify the cutoff time in the format "number hours" or "number days"');
        return;
      }

      const cutoffTime = moment().subtract(value, unit).toDate();
      const addresses = await removeOldAddresses(cutoffTime);

      if (addresses && addresses.length > 0) {
        bot.sendMessage(chatId, `Deleted ${addresses.length} addresses older than ${value} ${unit}.`);
      } else {
        bot.sendMessage(chatId, `No addresses found older than ${value} ${unit}.`);
      }
    });
  }
});

(async () => {
  try {
    // Connect to MongoDB
    await client.connect();
    const db = client.db('blockchain');
    console.log("Connected to MongoDB");

    // Start tracking deposits
    await startTrackingDeposits(db);
    // Start tracking swaps
    await SwapTrack(db);
    // Start tracking MEV transactions
    await startMEVTracking();
  } catch (error) {
    console.error("Failed to start tracking:", error);
  }
})();
