const { MongoClient } = require("mongodb");
const { ethers } = require("ethers");
const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");
const moment = require("moment");
dotenv.config();
const axios = require('axios');

// Set up Infura provider
const infuraUrl = process.env.SWAP_INFURA_URL;
const provider = new ethers.getDefaultProvider(infuraUrl);

// Telegram bot setup
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_SWAP_CHANNEL_ID;
const deleteNotificationChatId = process.env.TELEGRAM_DELETE_ID;
const bot = new TelegramBot(botToken, { polling: false });

// MongoDB setup
const mongoUri = process.env.MONGODB_URL;
const client = new MongoClient(mongoUri);

async function importChalk() {
  const chalk = await import("chalk");
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

function formatTokenAge(creationDate) {
  const now = moment();
  const duration = moment.duration(now.diff(creationDate));
  if (duration.asMinutes() < 60) {
    return `${Math.floor(duration.asMinutes())} min ago`;
  } else if (duration.asHours() < 24) {
    return `${Math.floor(duration.asHours())} hr ago`;
  } else {
    return `${Math.floor(duration.asDays())} days ago`;
  }
}

async function getTransactionCount(address) {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=asc&apikey=${process.env.ETHERSCAN_API_KEY}`;
  const response = await axios.get(url);
  const transactions = response.data.result;
  console.log(`Address ${address} has ${transactions.length} before sending telegram notification.`);
  return transactions.length;
}

async function sendTelegramMessage(tx, tokenContractAddress, tokenName, tokenSymbol, tokenDecimals, platform, tokenCreationDate) {
  try {
    const transactionCount = await getTransactionCount(tx.from);
    console.log(`Address ${tx.from} has ${transactionCount} in telegram notification transactions.`);

    if (transactionCount > 15) {
      console.log(`Skipping notification for address ${tx.from} with ${transactionCount} transactions.`);
      return;
    }

    console.log("Sending Telegram message...");
    const valueInEth = weiToEth(tx.value.toString());
    const etherscanLink = `https://etherscan.io/tx/${tx.hash}`;
    const tokenAge = formatTokenAge(tokenCreationDate);
    console.log("Token Age: ", tokenAge);
    console.log("Value in ETH: ", valueInEth);
    console.log("Transaction Hash: ", tx.hash);
    console.log("Transaction Count: ", transactionCount);

    if (valueInEth === 0.5) {
      const message = `
<b>${platform} Buy Detected ✅</b>

<b>Transaction Hash:</b> <a href="${etherscanLink}">${tx.hash}</a>\n
<b>Block Number:</b> ${tx.blockNumber}
<b>From:</b> <code>${tx.from}</code>
<b>To:</b> <code>${tx.to}</code>\n
<b>Value:</b> <b>${valueInEth} ETH</b>\n
<b>Token:</b> ${tokenName} (${tokenSymbol})
<b>Decimals:</b> ${tokenDecimals}
<b>Token Contract:</b> <a href="https://etherscan.io/address/${tokenContractAddress}">${tokenContractAddress}</a>
<b>Token Age:</b> ${tokenAge}
<b>Transaction Count:</b> ${transactionCount}
`;
      await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    } else if (valueInEth > 0.5) {
      const message = `
<b>${platform} Buy Detected ✅</b>

<b>Transaction Hash:</b> <a href="${etherscanLink}">${tx.hash}</a>\n
<b>Block Number:</b> ${tx.blockNumber}
<b>From:</b> <code>${tx.from}</code>
<b>To:</b> <code>${tx.to}</code>\n
<b>Value:</b> <b>${valueInEth} ETH</b>\n
<b>Token:</b> ${tokenName} (${tokenSymbol})
<b>Decimals:</b> ${tokenDecimals}
<b>Token Contract:</b> <a href="https://etherscan.io/address/${tokenContractAddress}">${tokenContractAddress}</a>
<b>Token Age:</b> ${tokenAge}
<b>Transaction Count:</b> ${transactionCount}
`;
      await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    }
  } catch (error) {
    const chalk = await importChalk();
    console.error(chalk.red("Error sending Telegram message:"), error.message);
  }
}

async function sendTelegramNots(message) {
  try {
    await bot.sendMessage(deleteNotificationChatId, message, { parse_mode: "HTML" });
  } catch (error) {
    const chalk = await importChalk();
    console.error(chalk.red("Error sending Telegram notification:"), error.message);
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

async function sendDeleteNotification(deleteNotificationChatId, countInactive) {
  try {
    const message = `
📢 <b>Inactive Addresses Removed</b> 📢

The following addresses have been removed from the database due to inactivity:
Total Address Count is ${countInactive}
    `;
    await bot.sendMessage(deleteNotificationChatId, message, { parse_mode: "HTML" });
  } catch (error) {
    const chalk = await importChalk();
    console.error(chalk.red("Error sending Telegram notification:"), error.message);
  }
}

async function removeInactiveAddresses() {
  try {
    await client.connect();
    const collection = client.db("blockchain").collection("DepositAddresses");

    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 8);

    // Log the count of addresses before attempting deletion
    const countBefore = await collection.countDocuments({});
    console.log("All addresses count before deletion:", countBefore);

    // Find inactive addresses before deleting and count them
    const inactiveAddresses = await collection.find({
      timestamp: { $lt: cutoff },
      isActive: false,
    }).toArray();

    const countInactive = inactiveAddresses.length;

    // Log the inactive addresses found
    console.log("Inactive addresses found:", inactiveAddresses);

    // Perform deletion
    const result = await collection.deleteMany({
      timestamp: { $lt: cutoff },
      isActive: false,
    });

    // Log the count of remaining addresses after deletion attempt
    const countAfter = await collection.countDocuments({});
    console.log("Remaining addresses count after deletion:", countAfter);

    console.log(`Removed ${result.deletedCount} inactive addresses`);

    // Send notification if addresses were removed
    if (result.deletedCount > 0) {
      // display only the inactive addresses count
      await sendDeleteNotification(deleteNotificationChatId, countInactive);
    }

    // Log and return the count of inactive addresses
    console.log(`Inactive addresses count: ${countInactive}`);
  } catch (error) {
    console.error("Error removing inactive addresses:", error);
  } finally {
    await client.close();
  }
}

async function notifyNoTransactionsFound(blockNumber, trackedAddresses) {
  const chalk = await importChalk();
  console.log(chalk.blue(`Finished scanning block ${blockNumber}. No transactions found for tracked addresses.`));
  const message = `Finished scanning block ${blockNumber}. No transactions found for tracked addresses. Total Address Count is ${trackedAddresses.length}`;
  await sendTelegramNots(message); 
}

// Function to get the token contract creation date using Etherscan API
async function getTokenCreationDate(tokenAddress) {
  try {
    console.log(`Starting the process to get contract creation date for ${tokenAddress}...`);

    // Fetch transaction list for the contract address
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${tokenAddress}&startblock=0&endblock=99999999&sort=asc&apikey=${process.env.ETHERSCAN_API_KEY}`;
    console.log(`Fetching transactions for contract address: ${tokenAddress}`);
    const response = await axios.get(url);

    if (response.data.status === "1") {
      console.log("Transaction list fetched successfully.");
      const transactions = response.data.result;
      const creationTx = transactions[0]; // The first transaction is the contract creation

      const creationBlock = creationTx.blockNumber;
      console.log(`The contract was created in block number: ${creationBlock}`);

      // Fetch block details to get the timestamp
      const blockUrl = `https://api.etherscan.io/api?module=block&action=getblockreward&blockno=${creationBlock}&apikey=${process.env.ETHERSCAN_API_KEY}`;
      console.log(`Fetching details for block number: ${creationBlock}`);
      const blockResponse = await axios.get(blockUrl);

      if (blockResponse.data.status === "1") {
        console.log("Block details fetched successfully.");
        const blockTimestamp = blockResponse.data.result.timeStamp;
        return new Date(blockTimestamp * 1000);
      } else {
        console.error("Failed to fetch block details.");
        console.error(blockResponse.data);
        return null;
      }
    } else {
      console.error("Failed to fetch transaction details.");
      console.error(response.data);
      return null;
    }
  } catch (error) {
    console.error("An error occurred while fetching the contract creation date:");
    console.error(error.message);
    return null;
  }
}

async function SwapTrack() {
  try {
    // Connect to MongoDB
    await client.connect();
    const database = client.db("blockchain");
    const collection = database.collection("DepositAddresses");

    // Display bot running message
    await displayBotRunning();

    // Periodically remove inactive addresses
    setInterval(async () => {
      await removeInactiveAddresses();
    }, 30 * 60 * 1000); // Check every 30 minutes

    // Subscribe to new blocks
    provider.on("block", async (blockNumber) => {
      const chalk = await importChalk();
      console.log(chalk.cyan(`New block received: ${blockNumber}`));

      try {
        // Ensure MongoDB client is connected before processing the block
        if (!client.connect()) {
          await client.connect();
        }

        const block = await provider.getBlock(blockNumber);
        if (block && block.transactions.length > 0) {
          console.log(chalk.cyan(`Block ${blockNumber} has ${block.transactions.length} transactions in SwapTrack.`));

          let foundTransaction = false;

          // Fetch tracked addresses from MongoDB
          const trackedAddresses = await collection.find({}).toArray();
          const trackedAddressSet = new Set(trackedAddresses.map(addr => addr.address.toLowerCase()));

          for (const txHash of block.transactions) {
            try {
              const tx = await provider.getTransaction(txHash);
              if (tx && tx.data) {
                // List of method inputs to check for Uniswap V2
                const uniswapV2MethodInputs = [
                  "0xfb3bdb41", // Uniswap V2
                  "0x7ff36ab5", // Uniswap V2
                  "0xb6f9de95", // Uniswap V2
                  "0x8803dbee", // Uniswap V2
                ];

                // Check if the transaction is a Uniswap V3 Universal Router transaction
                const uniswapV3RouterAddress =
                  "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

                // Check if the transaction is a KyberSwap v2 transaction
                const kyberSwapRouterAddress =
                  "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

                // Check if the transaction is a 1Inch Swap transaction
                const oneInchSwapRouterAddress =
                  "0x1111111254EEB25477B68fb85Ed929f73A960582";

                // Check if the transaction involves any tracked address
                const isTrackedAddress = trackedAddressSet.has(tx.from.toLowerCase()) || trackedAddressSet.has(tx.to.toLowerCase());

                if (
                  isTrackedAddress &&
                  (
                    uniswapV2MethodInputs.includes(tx.data.substring(0, 10)) ||
                    (tx.to &&
                      (tx.to.toLowerCase() ===
                        uniswapV3RouterAddress.toLowerCase() ||
                        tx.to.toLowerCase() ===
                          kyberSwapRouterAddress.toLowerCase() ||
                        tx.to.toLowerCase() ===
                          oneInchSwapRouterAddress.toLowerCase()))
                  )
                ) {
                  // Log the transaction details
                  const txReceipt = await provider.getTransactionReceipt(
                    tx.hash
                  );
                  const tokenContractAddress =
                    parseTokenContractAddressFromLogs(txReceipt.logs);

                  if (!tokenContractAddress) {
                    console.log(
                      chalk.yellow(
                        "Unable to extract token contract address from transaction logs."
                      )
                    );
                    continue;
                  }

                  const tokenContract = new ethers.Contract(
                    tokenContractAddress,
                    [
                      "function name() view returns (string)",
                      "function symbol() view returns (string)",
                      "function decimals() view returns (uint8)",
                    ],
                    provider
                  );

                  const tokenName = await tokenContract.name();
                  const tokenSymbol = await tokenContract.symbol();
                  const tokenDecimals = await tokenContract.decimals();

                  // Check the token contract creation date
                  const tokenCreationDate = await getTokenCreationDate(
                    tokenContractAddress
                  );
                  const fourteenDaysAgo = new Date();
                  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

                  if (tokenCreationDate > fourteenDaysAgo) {
                    foundTransaction = true;

                    // Log the transaction details and send notification
                    // Determine if it's a V3, V2, KyberSwap, or 1Inch transaction
                    let platform = "Unknown Platform";

                    if (uniswapV2MethodInputs.includes(tx.data.substring(0, 10))) {
                      platform = "Uniswap V2";
                      console.log(chalk.blue(`Uniswap V2 input found in transaction: ${tx.hash}`)); // Added log statement
                    } else if (
                      tx.to.toLowerCase() === uniswapV3RouterAddress.toLowerCase()
                    ) {
                      platform = "Uniswap V3";
                      const valueInEth = weiToEth(tx.value.toString());
                      if (valueInEth === 0) {
                        console.log(chalk.blue(`Skipping Uniswap V3 transaction with 0 ETH: ${tx.hash}`)); // Log statement
                        continue; // Skip notification for 0 ETH Uniswap V3 transactions
                      }
                    } else if (
                      tx.to.toLowerCase() === kyberSwapRouterAddress.toLowerCase()
                    ) {
                      platform = "KyberSwap";
                      const valueInEth = weiToEth(tx.value.toString());
                      if (valueInEth === 0) {
                        console.log(chalk.blue(`Skipping KyberSwap transaction with 0 ETH: ${tx.hash}`)); // Log statement
                        continue; // Skip notification for 0 ETH KyberSwap transactions
                      }
                    } else if (
                      tx.to.toLowerCase() === oneInchSwapRouterAddress.toLowerCase()
                    ) {
                      platform = "1Inch Swap";
                      const valueInEth = weiToEth(tx.value.toString());
                      if (valueInEth === 0) {
                        console.log(chalk.blue(`Skipping 1Inch Swap transaction with 0 ETH: ${tx.hash}`)); // Log statement
                        continue; // Skip notification for 0 ETH 1Inch transactions
                      }
                    }

                    // Send Telegram message with transaction and token details
                    await sendTelegramMessage(
                      tx,
                      tokenContractAddress,
                      tokenName,
                      tokenSymbol,
                      tokenDecimals,
                      platform,
                      tokenCreationDate
                    );
                  } else {
                    console.log(
                      chalk.yellow(
                        `Skipping notification for token ${tokenName} as its contract age is more than 14 days.`
                      )
                    );
                    await sendTelegramNots(`Token ${tokenName} at address ${tokenContractAddress} is more than 14 days old.`);
                  }
                }
              }
            } catch (error) {
              console.error(
                chalk.red(
                  `Error processing transaction ${txHash} in block ${blockNumber}`
                )
              );
            }
          }

          if (!foundTransaction) {
            await notifyNoTransactionsFound(blockNumber, trackedAddresses);
          }
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
    console.error(chalk.red("Error in SwapTrack"), error);
    await sendTelegramNots(`Error in SwapTrack: ${error.message}`);
  }
}

module.exports = {
  SwapTrack
};

// Uncomment the line below to start the tracking when the script is run directly
// SwapTrack();