// index.js
require('dotenv').config();
const { startTrackingDeposits } = require('./src/track');
const { SwapTrack } = require('./src/swapTrack');

(async () => {
  try {
    // Start tracking deposits
    await startTrackingDeposits();
    // Start tracking swaps
    await SwapTrack();
  } catch (error) {
    console.error("Failed to start tracking:", error);
  }
})();
