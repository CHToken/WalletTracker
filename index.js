// index.js
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { startTrackingDeposits } = require('./src/track');
const { SwapTrack } = require('./src/swapTrack');
const { startMEVTracking } = require('./src/mev');

(async () => {
  const mongoUri = process.env.MONGODB_URL;
  const client = new MongoClient(mongoUri);

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
  } finally {
    await client.close();
  }
})();