// track.js
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const MongoClient = require('mongodb').MongoClient;
require('dotenv').config();

// Construct the absolute path to config.json
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_DEPOSIT_CHANNEL_ID = process.env.TELEGRAM_DEPOSIT_CHANNEL_ID;
const INFURA_URL = process.env.INFURA_URL;
const MONGODB_URL = process.env.MONGODB_URL;

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Function to shorten an Ethereum address for display
function shortenAddress(address) {
  if (address.length <= 10) return address;
  return (
    address.substring(0, 6) + "..." + address.substring(address.length - 4)
  );
}

// Function to convert wei to ETH manually (using 18 decimal places)
function weiToEth(weiAmount) {
  const ethAmount = weiAmount / Math.pow(10, 18);
  return parseFloat(ethAmount.toFixed(6));
}

// Function to get tag associated with an address
function getTagForAddress(address) {
  const wallet = config.exchangeWallets.find(
    (wallet) => wallet.address.toLowerCase() === address.toLowerCase()
  );
  return wallet ? wallet.tag : "";
}

// Function to send notification to Telegram
async function sendTelegramMessage(message, channelID) {
  try {
    await bot.sendMessage(channelID, message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error sending Telegram message in tracking:", error.message);
  }
}

// Function to store the transaction details in MongoDB
async function storeTransactionInDB(tx, db) {
  try {
    const collection = db.collection("DepositTransactions");

    // Check if the deposit address already exists in DepositAddresses
    const depositAddressCollection = db.collection("DepositAddresses");
    const existingAddress = await depositAddressCollection.findOne({ address: tx.to });
    
    if (!existingAddress) {
      // If address doesn't exist, insert it into DepositAddresses
      await depositAddressCollection.insertOne({ address: tx.to, timestamp: new Date(), isActive: false });
    } else {
      // Update the address to mark it as active
      await depositAddressCollection.updateOne(
        { address: tx.to },
        { $set: { timestamp: new Date(), isActive: false } }
      );
    }

    // Insert transaction into DepositTransactions
    const result = await collection.insertOne(tx);
    console.log("Transaction stored in MongoDB with _id:", result.insertedId);
  } catch (error) {
    console.error("Error storing transaction in MongoDB in tracking:", error.message);
    throw error; // Rethrow the error to handle it further up the call stack
  }
}

// Function to track ETH deposits using the method
async function startTrackingDeposits(db) {

  const provider = ethers.getDefaultProvider(INFURA_URL);
  const exchangeWallets = config.exchangeWallets.map((wallet) => wallet.address.toLowerCase());

  let chalk;
  try {
    chalk = (await import("chalk")).default;
    console.log(chalk.yellow("Starting deposit tracking..."));
  } catch (error) {
    console.error("Failed to load chalk:", error);
    return;
  }

  const handleBlock = async (blockNumber) => {
    console.log(chalk.cyan(`New block received: ${blockNumber}`));

    try {
      const block = await provider.getBlock(blockNumber);
      if (block && block.transactions.length > 0) {
        console.log(chalk.green(`Block ${blockNumber} has ${block.transactions.length} transactions.`));
        let foundTransactions = false;
        for (const txHash of block.transactions) {
          try {
            const tx = await provider.getTransaction(txHash);
            if (tx && tx.from && exchangeWallets.includes(tx.from.toLowerCase())) {
              const shortFrom = shortenAddress(tx.from);
              const shortTo = shortenAddress(tx.to);
              console.log(chalk.blue(`Outgoing transaction from exchange wallet ${shortFrom} (${getTagForAddress(tx.from)}) to ${shortTo}:`));

              if (tx.value !== undefined) {
                const amountInWei = parseInt(tx.value);
                if (amountInWei > 0) {
                  const amountInEth = weiToEth(amountInWei);
                  console.log(chalk.white(`Amount: ${amountInEth} ETH`));
                  console.log(chalk.gray(`Transaction Hash: ${tx.hash}`));
                  console.log(chalk.yellow("---"));
                  foundTransactions = true;

                  const etherscanUrl = `https://etherscan.io/tx/${tx.hash}`;
                  const message = `🚀 New Deposit Found ✅\n
From: <code>${shortFrom} (${getTagForAddress(tx.from)})</code>
To: <code>${shortTo}</code>\n
💲Amount: <code>${amountInEth} ETH</code>
🔗 Hash: <a href="${etherscanUrl}">${tx.hash}</a>`;
                  await sendTelegramMessage(message, TELEGRAM_DEPOSIT_CHANNEL_ID);

                  // Store transaction in MongoDB
                  await storeTransactionInDB({
                    from: tx.from,
                    to: tx.to,
                    amountInEth,
                    hash: tx.hash,
                    timestamp: new Date()
                  }, db);
                }
              } else {
                console.log(chalk.white(`Amount: 0 wei`));
                console.log(chalk.gray(`Transaction Hash: ${tx.hash}`));
                console.log(chalk.yellow("---"));
                foundTransactions = true;
              }
            }
          } catch (error) {
            console.error(chalk.red(`Error processing transaction ${txHash}:`), error.message);
          }
        }

        if (!foundTransactions) {
          console.log(chalk.yellow("No outgoing transactions found from exchange wallets in this block."));
        }
      } else {
        console.log(chalk.green(`Block ${blockNumber} has no transactions.`));
      }
    } catch (error) {
      console.error(chalk.red(`Error processing block ${blockNumber}:`), error.message);
    }
  };

  provider.on("block", handleBlock);

  provider.on("error", (error) => {
    console.error(chalk.red("Provider error:"), error);
  });

  const handleSigint = () => {
    console.log(chalk.yellow("SIGINT received. Stopping deposit tracking."));
    provider.removeListener("block", handleBlock);
    process.exit(0);
  };

  if (process.listenerCount("SIGINT") === 0) {
    process.once("SIGINT", handleSigint);
  }
}

module.exports = {
  startTrackingDeposits
};