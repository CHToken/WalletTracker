const { MongoClient } = require('mongodb');
const { ethers } = require("ethers");
const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");
dotenv.config();

// Set up Infura provider
const infuraUrl = process.env.SWAP_INFURA_URL;
const provider = new ethers.getDefaultProvider(infuraUrl);

// Telegram bot setup
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_SWAP_CHANNEL_ID;
const bot = new TelegramBot(botToken, { polling: false });

// MongoDB setup
const mongoUri = process.env.MONGODB_URL;
const client = new MongoClient(mongoUri);

async function importChalk() {
  const chalk = await import('chalk');
  return chalk.default;
}

// Function to display bot running message
async function displayBotRunning() {
  const chalk = await importChalk();
  console.log(chalk.yellow("Starting Swap tracking..."));
}

// Function to convert wei to ETH manually (using 18 decimal places)
function weiToEth(weiAmount) {
  const ethAmount = weiAmount / Math.pow(10, 18);
  return parseFloat(ethAmount.toFixed(6));
}

async function sendTelegramMessage(tx, tokenContractAddress) {
  try {
    const txDetails = await provider.getTransaction(tx.hash);
    const valueInEth = weiToEth(txDetails.value.toString());

    const etherscanLink = `https://etherscan.io/tx/${tx.hash}`;

    const message = `
🦄 <b>Uniswap Buy Detected ✅</b> 🦄

<b>Transaction Hash:</b> <a href="${etherscanLink}">${tx.hash}</a>\n
<b>Block Number:</b> ${tx.blockNumber}
<b>From:</b> ${txDetails.from}
<b>To:</b> ${txDetails.to}\n
<b>Value:</b> ${valueInEth} ETH
<b>Token Contract:</b> ${tokenContractAddress}
<i>This transaction contains a Uniswap method with input: ${txDetails.data.substring(0, 10)}</i>
    `;
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (error) {
    const chalk = await importChalk();
    console.error(chalk.red('Error sending Telegram message:'), error.message);
  }
}

// Function to parse ERC20 token contract address from transaction logs
function parseTokenContractAddressFromLogs(logs) {
  if (logs && logs.length >= 3) {
    // The token contract address is located in the third log entry
    return logs[2].address.toLowerCase(); 
  }
  return null;
}  

async function SwapTrack() {
  try {
    // Connect to MongoDB and fetch DepositAddresses
    await client.connect();
    const database = client.db("blockchain");
    const collection = database.collection("DepositAddresses");
    const addresses = await collection.distinct("address");
    const trackedAddresses = addresses.map((address) => address.toLowerCase());

    console.log(`Tracked addresses count: ${trackedAddresses.length}`);

    // Display bot running message
    await displayBotRunning();

    // Check transactions with specific method inputs
    provider.on("block", async (blockNumber) => {
      const chalk = await importChalk();
      console.log(chalk.cyan(`New block received: ${blockNumber}`));

      try {
        const block = await provider.getBlock(blockNumber);
        if (block && block.transactions.length > 0) {
          console.log(chalk.cyan(`Block ${blockNumber} has ${block.transactions.length} transactions.`));
          console.log(chalk.green(`Scanning ${trackedAddresses.length} DepositAddresses in block ${blockNumber}.`));

          for (const txHash of block.transactions) {
            try {
              const tx = await provider.getTransaction(txHash);
              if (tx && tx.data) {
                // List of method inputs to check
                const methodInputs = [
                  "0xfb3bdb41",
                  "0x7ff36ab5",
                  "0xb6f9de95",
                  "0x8803dbee",
                ];

                // Check if tx input matches any method input
                if (methodInputs.includes(tx.data.substring(0, 10)) && trackedAddresses.includes(tx.from.toLowerCase())) {
                  console.log(chalk.yellowBright(`Transaction ${tx.hash} contains Uniswap method with input: ${tx.data.substring(0, 10)}`));
                  console.log(chalk.green(`Scanning ${trackedAddresses.length} DepositAddresses in transaction ${tx.hash}.`));

                  const txReceipt = await provider.getTransactionReceipt(tx.hash);
                  const tokenContractAddress = parseTokenContractAddressFromLogs(txReceipt.logs);

                  // Send notification to Telegram channel
                  await sendTelegramMessage(tx, tokenContractAddress);
                }
              }
            } catch (error) {
              console.error(chalk.red(`Error processing transaction ${txHash}:`), error.message);
            }
          }

          // Indicate progress after scanning each block
          console.log(chalk.blue(`Finished scanning block ${blockNumber}.`));
        } else {
          console.log(chalk.cyan(`Block ${blockNumber} has no transactions.`));
        }
      } catch (error) {
        console.error(chalk.red(`Error processing block ${blockNumber}:`), error.message);
      }
    });

    // Handle provider errors
    provider.on("error", async (error) => {
      const chalk = await importChalk();
      console.error(chalk.red("Provider error:"), error);
    });

    // Handle SIGINT to gracefully shut down
    process.once("SIGINT", async () => {
      const chalk = await importChalk();
      console.log(chalk.yellow("SIGINT received. Stopping Uniswap transaction monitoring."));
      await client.close();
      process.exit(0);
    });

  } catch (error) {
    const chalk = await importChalk();
    console.error(chalk.red("Error occurred:"), error);
  }
}

// module.exports = {
//   SwapTrack
// };

SwapTrack();
