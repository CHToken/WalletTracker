// index.js
require('dotenv').config();
const { startTrackingDeposits } = require('./src/track');
const { SwapTrack } = require('./src/swapTrack');
const { startMEVTracking } = require('./src/mev');

(async () => {
  try {
    // Start tracking deposits
    await startTrackingDeposits();

    // Start tracking swaps
    await SwapTrack();

    // Start tracking MEV transactions
    await startMEVTracking();
  } catch (error) {
    console.error("Failed to start tracking:", error);
  }
})();
