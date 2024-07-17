// verifyTransaction.js
const { ethers } = require("ethers");
require('dotenv').config();

// Environment variables
const INFURA_URL = process.env.INFURA_URL;
const RHINO_FI_ADDRESS = "0xaf8aE6955d07776aB690e565Ba6Fbc79B8dE3a5d".toLowerCase();
const TRANSACTION_HASH = "0xedb4a293ac58677ab36f4e6884df4072269a9d6735eda211c8296a76c11d4884";

// Function to verify if a transaction is a deposit from Rhino.fi address
async function verifyTransaction() {
  const provider = new ethers.getDefaultProvider(INFURA_URL);

  try {
    // Get the transaction details
    const tx = await provider.getTransaction(TRANSACTION_HASH);

    if (!tx) {
      console.log(`Transaction with hash ${TRANSACTION_HASH} not found.`);
      return;
    }

    // Get the transaction receipt
    const receipt = await provider.getTransactionReceipt(TRANSACTION_HASH);

    console.log("Transaction Receipt:");
    console.log(receipt);

    // Check if the transaction is from the Rhino.fi address
    if (tx.from.toLowerCase() === RHINO_FI_ADDRESS) {
      console.log(`Transaction ${TRANSACTION_HASH} is a deposit from the Rhino.fi address.`);
      console.log(`From: ${tx.from}`);
      console.log(`To: ${tx.to}`);
      console.log(`Amount: ${ethers.formatUnits(tx.value)} ETH`);
      console.log(`Transaction Hash: ${tx.hash}`);
    } else {
      console.log(`Transaction ${TRANSACTION_HASH} is NOT a deposit from the Rhino.fi address.`);
    }
  } catch (error) {
    console.error("Error verifying transaction:", error.message);
  }
}

verifyTransaction();
