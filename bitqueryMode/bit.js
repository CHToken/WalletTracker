require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

// Load configuration from config.json
let config;
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
} catch (error) {
  console.error('Error reading config.json:', error);
  process.exit(1); // Exit the script if there's an error reading config.json
}

// Ensure WALLET_ADDRESSES is an array
const exchangeWallets = Array.isArray(config.WALLET_ADDRESSES) ? config.WALLET_ADDRESSES : [];

const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const BITQUERY_URL = process.env.BITQUERY_URL;

const query = `
  query ($address: String!, $limit: Int!) {
    ethereum {
      transfers(receiver: {is: $address}, limit: $limit, options: {desc: "block.timestamp.time"}) {
        block {
          timestamp {
            time(format: "%Y-%m-%d %H:%M:%S")
          }
        }
        sender {
          address
        }
        receiver {
          address
        }
        amount
        currency {
          symbol
        }
      }
    }
  }
`;

async function trackDeposits() {
  try {
    // Ensure exchangeWallets is an array
    if (!Array.isArray(exchangeWallets)) {
      throw new Error('WALLET_ADDRESSES in config.json is not an array');
    }

    for (const walletAddress of exchangeWallets) {
      const response = await axios.post(BITQUERY_URL, {
        query,
        variables: {
          address: walletAddress,
          limit: 10
        }
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': BITQUERY_API_KEY
        }
      });

      if (response.data && response.data.data && response.data.data.ethereum) {
        const transfers = response.data.data.ethereum.transfers;

        transfers.forEach(tx => {
          if (tx.receiver.address.toLowerCase() === walletAddress.toLowerCase()) {
            console.log(`Transaction from ${tx.sender.address} to ${tx.receiver.address}:`);
            console.log(`Amount: ${tx.amount / Math.pow(10, 18)} ETH`);
            console.log(`Date: ${tx.block.timestamp.time}`);
            console.log('---');
          }
        });
      } else {
        console.error('Unexpected response structure:', response.data);
      }
    }
  } catch (error) {
    console.error('Error fetching transactions:', error);
  }
}

setInterval(trackDeposits, 60000); // Check for new transactions every minute

module.exports = {
  trackDeposits
};
