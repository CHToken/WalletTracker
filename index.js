// index.js

// Requiring the bit.js file from the bitqueryMode folder
const { trackDeposits } = require('./bitqueryMode/bit');

// Call the function to start tracking
trackDeposits();

console.log('Tracking started for...', new Date());
