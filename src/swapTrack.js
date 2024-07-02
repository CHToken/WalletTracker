const { MongoClient } = require("mongodb");
const { ethers } = require("ethers");
const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");
const moment = require("moment");
dotenv.config();

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

async function sendTelegramMessage(tx, tokenContractAddress, tokenName, tokenSymbol, tokenDecimals, platform, tokenCreationDate) {
  try {
    console.log("Sending Telegram message...");
    const valueInEth = weiToEth(tx.value.toString());
    const etherscanLink = `https://etherscan.io/tx/${tx.hash}`;
    const tokenAge = formatTokenAge(tokenCreationDate);

    if (valueInEth === 0.5) {
      const message = `
<b>${platform} Buy Detected ✅</b>

<b>Transaction Hash:</b> <a href="${etherscanLink}">${tx.hash}</a>\n
<b>Block Number:</b> ${tx.blockNumber}
<b>From:</b> <code>${tx.from}</code>
<b>To:</b> <code>${tx.to}</code>\n
<b>Value:</b> <b>${valueInEth}</b>\n
<b>Token:</b> ${tokenName} (${tokenSymbol})
<b>Decimals:</b> ${tokenDecimals}
<b>Token Contract:</b> <a href="https://etherscan.io/address/${tokenContractAddress}">${tokenContractAddress}</a>
<b>Token Age:</b> ${tokenAge}
`;
      await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    } else if (valueInEth > 0.5) {
      const message = `
<b>${platform} Buy Detected ✅</b>

<b>Transaction Hash:</b> <a href="${etherscanLink}">${tx.hash}</a>\n
<b>Block Number:</b> ${tx.blockNumber}
<b>From:</b> <code>${tx.from}</code>
<b>To:</b> <code>${tx.to}</code>\n
<b>Value:</b> <b>${valueInEth}</b>\n
<b>Token:</b> ${tokenName} (${tokenSymbol})
<b>Decimals:</b> ${tokenDecimals}
<b>Token Contract:</b> <a href="https://etherscan.io/address/${tokenContractAddress}">${tokenContractAddress}</a>
<b>Token Age:</b> ${tokenAge}
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

async function sendDeleteNotification(deleteNotificationChatId, addresses) {
  try {
    const message = `
📢 <b>Inactive Addresses Removed</b> 📢

The following addresses have been removed from the database due to inactivity:\n
${addresses.map((address) => `<b>${address}</b>`).join('\n')}

Total Address Count is
${addresses.length}
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
    cutoff.setHours(cutoff.getHours() - 12); // Remove addresses older than 12 hours in UTC

    // Log the count of addresses before attempting deletion
    const countBefore = await collection.countDocuments({});
    console.log("All addresses count before deletion:", countBefore);

    // Find inactive addresses before deleting and count them
    const inactiveAddresses = await collection.find({
      timestamp: { $lt: cutoff },
      isActive: false,
    }).toArray();

    const countInactive = inactiveAddresses.length; // Count of addresses to be removed

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
      await sendDeleteNotification(deleteNotificationChatId, inactiveAddresses.map(doc => doc.address));
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
  await sendTelegramNots(message); // Use the default chatId for notifications
}

// Function to get the token contract creation date
async function getTokenCreationDate(tokenAddress) {
  const tokenCode = await provider.getCode(tokenAddress);
  if (tokenCode === "0x") {
    throw new Error(`No contract found at address ${tokenAddress}`);
  }
  const currentBlock = await provider.getBlockNumber();
  let creationBlock = 0;
  let startBlock = 0;
  let endBlock = currentBlock;

  while (startBlock <= endBlock) {
    const middleBlock = Math.floor((startBlock + endBlock) / 2);
    const codeAtBlock = await provider.getCode(tokenAddress, middleBlock);
    if (codeAtBlock !== "0x") {
      creationBlock = middleBlock;
      endBlock = middleBlock - 1;
    } else {
      startBlock = middleBlock + 1;
    }
  }

  const creationBlockDetails = await provider.getBlock(creationBlock);
  return new Date(creationBlockDetails.timestamp * 1000);
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
    }, 60 * 60 * 1000); // Check every 1 hour

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

                    const tokenAge = formatTokenAge(tokenCreationDate);

                    // Send Telegram message with transaction and token details
                    await sendTelegramMessage(
                      tx,
                      tokenContractAddress,
                      tokenName,
                      tokenSymbol,
                      tokenDecimals,
                      platform,
                      tokenAge
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