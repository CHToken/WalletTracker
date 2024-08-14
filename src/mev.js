const { ethers } = require("ethers");
const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");
const { MongoClient } = require("mongodb");
dotenv.config();

const processedBlocks = new Set();
const firstTransactionCache = new Set(); // Cache to track first transactions

// Set up Infura provider
const infuraUrl = process.env.MEV_INFURA_URL;
const provider = new ethers.getDefaultProvider(infuraUrl);

// Telegram bot setup
const botToken = process.env.TELEGRAM_MEVBOT_TOKEN;
const chatId = process.env.TELEGRAM_MEVSWAP_CHANNEL_ID;
const bot = new TelegramBot(botToken, { polling: false });

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
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length === 0) {
      await db.createCollection(collectionName);
      console.log(`Collection ${collectionName} created`);
    }
    collection = db.collection(collectionName);
    console.log("Connected to MongoDB ✅");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error.message);
  }
})();

// Define event signatures
const uniswapV2EventSignature = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const uniswapV3EventSignature = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");

// Uniswap V2 Pair ABI
const uniswapV2PairABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

// ERC-20 Token ABI
const erc20ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function balanceOf(address owner) external view returns (uint256)"
];

// Function to convert wei to ETH manually (using 18 decimal places)
function weiToEth(weiAmount) {
  try {
    const ethAmount = Number(weiAmount.toString()) / Math.pow(10, 18);
    return parseFloat(ethAmount.toFixed(2));
  } catch (error) {
    console.error("Error converting wei to ETH:", error.message);
    return 0;
  }
}

// Helper function to format large numbers
function formatNumber(value) {
  if (value >= 1e12) return (value / 1e12).toFixed(2) + 'T';
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(2) + 'K';
  return value.toString();
}

// Function to convert amount using token decimals
function amountToDecimal(amount, decimals, isUniswapV3 = false) {
  try {
    console.log(`Converting amount: ${amount.toString()} using decimals: ${decimals}`);

    // Do not convert if decimals is zero
    if (decimals === 0) {
      console.log("Decimals is 0, skipping conversion.");
      return amount.toString();
    }

    // Handle Uniswap V3 negative amounts by removing the negative sign
    if (isUniswapV3 && amount < 0) {
      console.log("Uniswap V3 transaction detected with negative amount");
      amount = -amount;
    }

    const decimalAmount = BigInt(amount.toString()) / BigInt(10n ** BigInt(decimals));
    const formattedAmount = formatNumber(Number(decimalAmount));

    // Only log the converted amount if it's not zero
    if (formattedAmount !== "0") {
      console.log(`Converted amount: ${formattedAmount}`);
    }

    return formattedAmount;
  } catch (error) {
    console.error("Error converting amount using decimals:", error.message);
    return "0";
  }
}

console.log("Starting MEV Bot...");

// Custom JSON stringify replacer to handle BigInt
function replacer(key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

// Function to get token addresses from pair address
async function getTokenAddresses(pairAddress) {
  try {
    const pairContract = new ethers.Contract(pairAddress, uniswapV2PairABI, provider);
    const token0 = await pairContract.token0();
    const token1 = await pairContract.token1();
    console.log(`Fetched token addresses for pair ${pairAddress}`);
    return { token0, token1 };
  } catch (error) {
    console.error(`Error fetching token addresses for pair ${pairAddress}:`, error.message);
    return { token0: null, token1: null };
  }
}

// Function to get token details from token address
async function getTokenDetails(tokenAddress) {
  try {
    if (!tokenAddress) return { name: "Unknown", symbol: "Unknown", decimals: 0 };
    const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, provider);
    const [name, symbol, decimals] = await Promise.all([
      tokenContract.name(),
      tokenContract.symbol(),
      tokenContract.decimals()
    ]);
    console.log(`Fetched token details for address ${tokenAddress}`);
    return { name, symbol, decimals };
  } catch (error) {
    console.error(`Error fetching token details for address ${tokenAddress}:`, error.message);
    return { name: "Unknown", symbol: "Unknown", decimals: 0 };
  }
}

// Function to check if a transaction is the first for a given token by a specific user
async function isFirstTransactionForToken(tokenAddress, userAddress, blockNumber) {
  try {
    const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, provider);
    const balance = await tokenContract.balanceOf(userAddress, { blockTag: blockNumber - 1 });
    return balance.toString() === "0";
  } catch (error) {
    console.error(`Error checking token balance for ${tokenAddress} and user ${userAddress}:`, error.message);
    return false;
  }
}

// Function to get the formatted date and time of a block
async function getFormattedBlockDateTime(blockNumber) {
  try {
    const block = await provider.getBlock(blockNumber);
    const timestamp = new Date(block.timestamp * 1000); // Convert to milliseconds
    const formattedDate = timestamp.toLocaleDateString();
    const formattedTime = timestamp.toLocaleTimeString();
    return `${formattedDate} ${formattedTime}`;
  } catch (error) {
    console.error(`Error fetching block timestamp for block ${blockNumber}:`, error.message);
    return "Unknown Date and Time";
  }
}

async function sendTelegramMessage(tx, decodedLogs) {
  try {
    const etherscanLink = `https://etherscan.io/tx/${tx.hash}`;
    const fromLink = `https://etherscan.io/address/${tx.from}`;
    const toLink = `https://etherscan.io/address/${tx.to}`;

    // Get ENS name of tx.from address
    const ensName = await provider.lookupAddress(tx.from);
    const fromAddress = ensName ? `<a href="${fromLink}">${ensName}</a>` : `<a href="${fromLink}">${tx.from}</a>`;
    const toAddress = `<a href="${toLink}">MEV BOT (${tx.to})</a>`;

    const logDetails = await Promise.all(decodedLogs.map(async log => {
      let amountIn, amountOut, tokenIn, tokenOut, tokenInDetails, tokenOutDetails;
      if (log.platform === "Uniswap V2") {
        amountIn = log.log.args.amount1In;
        amountOut = log.log.args.amount0Out;
        const tokenAddresses = await getTokenAddresses(log.address);
        tokenIn = tokenAddresses.token0;
        tokenOut = tokenAddresses.token1;
      } else if (log.platform === "Uniswap V3") {
        amountIn = log.log.args.amount0;
        amountOut = log.log.args.amount1;
        const tokenAddresses = await getTokenAddresses(log.address);
        tokenIn = tokenAddresses.token0;
        tokenOut = tokenAddresses.token1;
      }
      tokenInDetails = await getTokenDetails(tokenIn);
      tokenOutDetails = await getTokenDetails(tokenOut);
      const amountInEth = weiToEth(amountIn);
      const amountOutDecimal = amountToDecimal(amountOut, tokenInDetails.decimals, log.platform === "Uniswap V3");

      // Skip if Amount In is 0 ETH or decimals is 0 or Amount Out is 0
      if (amountInEth === 0 || tokenInDetails.decimals === 0 || amountOutDecimal === "0") {
        return null;
      }

      // Check if it's the first transaction for the token by the tx.to address
      const isFirstTransaction = await isFirstTransactionForToken(tokenIn, tx.to, tx.blockNumber);

      // Skip if it's not the first transaction for the token by the tx.to address
      if (!isFirstTransaction || firstTransactionCache.has(tokenIn)) {
        return null;
      }

      // Add to the cache to avoid duplicate notifications
      firstTransactionCache.add(tokenIn);

      console.log(`First transaction detected for token: ${tokenIn}`);

      let firstTransactionDateTime = "";
      if (isFirstTransaction) {
        firstTransactionDateTime = await getFormattedBlockDateTime(tx.blockNumber);
      }

      // Store token details in MongoDB if it's the first transaction
      if (isFirstTransaction) {
        await collection.insertOne({
          token: tokenIn,
          user: tx.to,
          blockNumber: tx.blockNumber,
          dateTime: firstTransactionDateTime,
          details: {
            name: tokenInDetails.name,
            symbol: tokenInDetails.symbol,
            decimals: tokenInDetails.decimals,
            amountInEth: amountInEth,
            amountOut: amountOutDecimal
          }
        });
        console.log(`Stored first transaction details for token: ${tokenIn} in MongoDB`);
      }

      // Choose the appropriate symbol based on the platform
      const name = log.platform === "Uniswap V2" ? tokenInDetails.name : tokenOutDetails.name;
      const symbol = log.platform === "Uniswap V2" ? tokenInDetails.symbol : tokenOutDetails.symbol;
      const decimals = log.platform === "Uniswap V2" ? tokenInDetails.decimals : tokenOutDetails.decimals;

      return `<b>Platform:</b> ${log.platform}\n<b>Token Bought ✅:</b> ${name} (${symbol}, ${decimals} decimals) (${tokenIn})\n<b>Amount In:</b> ${amountInEth} ETH\n<b>Amount Out:</b> ${amountOutDecimal} ${symbol}\n<b>First Transaction:</b> ${isFirstTransaction ? 'Yes' : 'No'}\n${isFirstTransaction ? `<b>Time:</b> ${firstTransactionDateTime}` : ''}\n`;
    }));

    const filteredLogDetails = logDetails.filter(detail => detail !== null);

    if (filteredLogDetails.length === 0) {
      console.log("No valid swap logs found with non-zero Amount In or valid decimals or no first transaction.");
      return;
    }

    console.log("Sending Telegram message...");

    const message = `
<b>Transaction Detected ✅</b>

<b>Transaction Hash:</b> <a href="${etherscanLink}">${tx.hash}</a>\n
<b>Block Number:</b> ${tx.blockNumber}
<b>From:</b> ${fromAddress}
<b>To:</b> ${toAddress}\n
<b>Logs:</b>\n${filteredLogDetails.join("\n\n")}
`;
    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    console.log("First transaction notification sent.");
  } catch (error) {
    console.error("Error sending Telegram message in mevbot:", error.message);
  }
}

function decodeLogs(logs) {
  try {
    const ifaceV2 = new ethers.Interface([
      "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
    ]);

    const ifaceV3 = new ethers.Interface([
      "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
    ]);

    const decodedLogs = [];

    for (const log of logs) {
      if (log.topics[0] === uniswapV2EventSignature) {
        const decodedLog = ifaceV2.parseLog(log);
        decodedLogs.push({
          platform: "Uniswap V2",
          log: decodedLog,
          address: log.address // pair address
        });
      } else if (log.topics[0] === uniswapV3EventSignature) {
        const decodedLog = ifaceV3.parseLog(log);
        decodedLogs.push({
          platform: "Uniswap V3",
          log: decodedLog,
          address: log.address // pair address
        });
      }
    }
    console.log("Logs decoded successfully.");
    return decodedLogs;
  } catch (error) {
    console.error("Error decoding logs:", error.message);
    return [];
  }
}

async function getTransactionData(txHash) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      console.log("Transaction receipt not found.");
      return;
    }

    // Decode logs
    const decodedLogs = decodeLogs(receipt.logs);

    if (decodedLogs.length > 0) {
      // Fetch the transaction details to include in the Telegram message
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        console.log("Transaction not found.");
        return;
      }

      // Send Telegram message with transaction details and logs
      await sendTelegramMessage(tx, decodedLogs);
    } else {
      console.log("No Uniswap V2 or V3 swap logs found in this transaction.");
    }
  } catch (error) {
    console.error("Error getting transaction data:", error.message);
  }
}

// Function to start tracking MEV transactions
async function startMEVTracking() {
  const fromAddress = process.env.MEV_TX_FROM;
  const toAddress = process.env.MEV_BOT_ADDRESS;

  provider.on("block", async (blockNumber) => {
    if (processedBlocks.has(blockNumber)) {
      console.log(`Block ${blockNumber} has already been processed.`);
      return;
    }
    processedBlocks.add(blockNumber);

    console.log(`New block detected: ${blockNumber}`);
    try {
      const block = await provider.getBlock(blockNumber);
      const transactions = await Promise.all(
        block.transactions.map(txHash => provider.getTransaction(txHash))
      );
      console.log(`Processing block: ${blockNumber}, Transactions: ${block.transactions.length}`);
      for (const tx of transactions) {
        if (tx && tx.from.toLowerCase() === fromAddress.toLowerCase() && tx.to && tx.to.toLowerCase() === toAddress.toLowerCase()) {
          console.log(`MEV BOT transaction detected: ${tx.hash}`);
          await getTransactionData(tx.hash);
        }
      }
    } catch (error) {
      console.error(`Error processing block ${blockNumber}:`, error.message);
    }
  });
}

module.exports = {
  startMEVTracking
};

// startMEVTracking();