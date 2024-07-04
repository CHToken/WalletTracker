const axios = require('axios');
require('dotenv').config();

const etherscanApiKey = process.env.ETHERSCAN_API_KEY;
const address = '0x0EC804F9Cd0E8712c9C48046f9e3F71394e0f139';

async function checkTransactionCount() {
  try {
    const response = await axios.get(`https://api.etherscan.io/api`, {
      params: {
        module: 'account',
        action: 'txlist',
        address: address,
        startblock: 0,
        endblock: 99999999,
        sort: 'asc',
        apikey: etherscanApiKey
      }
    });

    const transactions = response.data.result;

    const successfulTransactions = transactions.filter(tx => tx.isError === '0');
    const failedTransactions = transactions.filter(tx => tx.isError === '1');

    const successfulTransactionCount = successfulTransactions.length;
    const failedTransactionCount = failedTransactions.length;
    const totalTransactionCount = transactions.length;

    console.log(`Address ${address} has ${successfulTransactionCount} successful transactions.`);
    console.log(`Address ${address} has ${failedTransactionCount} failed transactions.`);
    console.log(`Address ${address} has ${totalTransactionCount} total transactions.`);

    // Check if the total transaction count is less than or equal to 15
    if (totalTransactionCount <= 15) {
      console.log('Total transaction count is less than or equal to 15. Proceed with notification.');
    } else {
      console.log('Total transaction count is greater than 15. Do not send notification.');
    }
  } catch (error) {
    console.error('Error fetching transaction details:', error);
  }
}

checkTransactionCount();
