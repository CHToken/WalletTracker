const { ethers } = require("ethers");
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
const moment = require("moment");
dotenv.config();

// Set up Infura provider
const infuraUrl = process.env.MEV_INFURA_URL;
const provider = ethers.getDefaultProvider(infuraUrl);

// Telegram bot setup
const botToken = process.env.TELEGRAM_MEVBOT_TOKEN;
const chatId = process.env.TELEGRAM_MEVSWAP_CHANNEL_ID;
const bot = new (require("node-telegram-bot-api"))(botToken, { polling: true });

// MongoDB setup
const mongoUrl = process.env.MONGODB_URL;
const dbName = "blockchain";
const collectionName = "TokenList";
let db, collection;

(async function connectToMongoDB() {
  try {
    const client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db(dbName);
    collection = db.collection(collectionName);
    console.log("Connected to MongoDB ✅");

    await cleanUpOldTokens();
    setInterval(cleanUpOldTokens, 10 * 60 * 1000); // Schedule cleanup every 10 minutes
  } catch (error) {
    await handleError("Error connecting to MongoDB:", error);
  }
})();

// Clean up old tokens older than 10 minutes
async function cleanUpOldTokens() {
  const tenMinutesAgo = moment().subtract(10, 'minutes').toDate(); // 10 minutes ago
  try {
    const result = await collection.deleteMany({
      dateTime: { $lt: moment(tenMinutesAgo).format("M/D/YYYY h:mm:ss A") }
    });
    console.log(`Deleted ${result.deletedCount} tokens older than 10 minutes.`);
  } catch (error) {
    await handleError("Error cleaning up old tokens:", error);
  }
}

// Define event signatures
const uniswapV2EventSignature = ethers.id(
  "Swap(address,uint256,uint256,uint256,uint256,address)"
);

// Uniswap V2 Pair ABI
const uniswapV2PairABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

// ERC-20 Token ABI
const erc20ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

// Helper function to format large numbers
function formatNumber(value) {
  if (value >= 1e12) return (value / 1e12).toFixed(2) + "T";
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(2) + "K";
  return value.toString();
}

// Function to convert wei to ETH manually (using 18 decimal places)
function weiToEth(weiAmount) {
  try {
    const ethAmount = Number(weiAmount.toString()) / Math.pow(10, 18);
    return formatNumber(parseFloat(ethAmount.toFixed(2)));
  } catch (error) {
   handleError("Error converting wei to ETH:", error);
    return 0;
  }
}

// Function to convert amount using token decimals
function amountToDecimal(amount, decimals) {
  try {
    const decimalAmount = Number(ethers.formatUnits(amount, decimals));
    return formatNumber(decimalAmount);
  } catch (error) {
     handleError("Error converting amount using decimals:", error);
    return "0";
  }
}

// Function to get token details from token address
async function getTokenDetails(tokenAddress) {
  try {
    if (!tokenAddress)
      return { name: "Unknown", symbol: "Unknown", decimals: 0 };
    const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, provider);
    const [name, symbol, decimals] = await Promise.all([
      tokenContract.name(),
      tokenContract.symbol(),
      tokenContract.decimals(),
    ]);
    return { name, symbol, decimals };
  } catch (error) {
    await handleError(`Error fetching token details for address ${tokenAddress}:`, error);
    return { name: "Unknown", symbol: "Unknown", decimals: 0 };
  }
}

// Function to send a custom Telegram message for user transactions
async function sendUserTransactionTelegramMessage(
  tx,
  tokenDetails,
  amountIn,
  amountOut,
  transactionType
) {
  try {
    const etherscanLink = `https://etherscan.io/tx/${tx.hash}`;
    const fromLink = `https://etherscan.io/address/${tx.from}`;
    const toLink = `https://etherscan.io/address/${tx.to}`;
    const fromAddress = `<a href="${fromLink}">${tx.from}</a>`;
    const toAddress = `<a href="${toLink}">${tx.to}</a>`;

    const message = `
<b>User Transaction Detected ✅</b>

<b>Transaction Hash:</b> <a href="${etherscanLink}">${tx.hash}</a>\n
<b>Block Number:</b> ${tx.blockNumber}
<b>From:</b> ${fromAddress}
<b>To:</b> ${toAddress}\n
<b>Token:</b> ${tokenDetails.name} (${tokenDetails.symbol})
<b>Amount In:</b> ${amountIn} ${
      transactionType === "Buy" ? "ETH" : tokenDetails.symbol
    }
<b>Amount Out:</b> ${amountOut} ${
      transactionType === "Sell" ? "ETH" : tokenDetails.symbol
    }
<b>Transaction Type:</b> ${transactionType}
`;

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    console.log(
      `User transaction notification sent for token: ${tokenDetails.symbol}`
    );
  } catch (error) {
    await handleError("Error sending Telegram message for user transaction:", error);
  }
}

// Function to track user transactions for a specific token
async function trackUserTokenTransactions(tx) {
  try {
    const tokenList = await collection.find({}).toArray();
    for (const { token, user } of tokenList) {
      if (tx.to && tx.to.toLowerCase() === user.toLowerCase()) {
        const receipt = await provider.getTransactionReceipt(tx.hash);
        if (!receipt) {
          await handleError(`Transaction receipt not found for hash in usage: ${tx.hash}`);
          return;
        }

        for (const log of receipt.logs) {
          if (log.topics[0] === uniswapV2EventSignature) {
            const pairContract = new ethers.Contract(
              log.address,
              uniswapV2PairABI,
              provider
            );
            const token0 = await pairContract.token0();
            const token1 = await pairContract.token1();

            if (
              token0.toLowerCase() === token.toLowerCase() ||
              token1.toLowerCase() === token.toLowerCase()
            ) {
              const tokenDetails = await getTokenDetails(token);
              const decodedLog = new ethers.Interface(
                uniswapV2PairABI
              ).parseLog(log);
              const { amount0In, amount1In, amount0Out, amount1Out } =
                decodedLog.args;

              let transactionType = "Unknown";
              let amountIn, amountOut;

              if (amount1In > 0 && amount0Out > 0) {
                transactionType = "Buy";
                amountIn = weiToEth(amount1In);
                amountOut = amountToDecimal(amount0Out, tokenDetails.decimals);
              } else if (amount0In > 0 && amount1Out > 0) {
                transactionType = "Sell";
                amountIn = amountToDecimal(amount0In, tokenDetails.decimals);
                amountOut = weiToEth(amount1Out);
              }

              await sendUserTransactionTelegramMessage(
                tx,
                tokenDetails,
                amountIn,
                amountOut,
                transactionType
              );
            }
          }
        }
      }
    }
  } catch (error) {
    await handleError("Error tracking user token transactions:", error);
  }
}

// Function to start tracking user token transactions
async function startUserTokenTracking() {
  provider.on("block", async (blockNumber) => {
    console.log(`New block detected: ${blockNumber}`);
    try {
      const block = await provider.getBlock(blockNumber);
      const transactions = await Promise.all(
        block.transactions.map((txHash) => provider.getTransaction(txHash))
      );
      for (const tx of transactions) {
        if (tx) {
          await trackUserTokenTransactions(tx);
        }
      }
    } catch (error) {
      await handleError(`Error processing block ${blockNumber}:`, error);
    }
  });
}

// Function to handle errors and send Telegram message
async function handleError(context, error) {
  const message = `
<b>Error Occurred ❌</b>
<b>Context:</b> ${context}
<b>Error Message:</b> ${error.message}
`;

  await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
  console.error(context, error.message);
}

module.exports = {
  startUserTokenTracking,
};
