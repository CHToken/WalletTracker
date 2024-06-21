require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Construct the absolute path to config.json
const configPath = path.join(__dirname, "config.json");

// Load configuration from config.json
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

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

// Function to start tracking deposits
async function startTracking() {
  const provider = ethers.getDefaultProvider(process.env.INFURA_URL);
 // Convert all exchangeWallets to lowercase
  const exchangeWallets = config.exchangeWallets.map((wallet) =>
    wallet.address.toLowerCase()
  );

  // Dynamic import for chalk
  let chalk;
  try {
    chalk = (await import("chalk")).default;
    console.log(chalk.yellow("Starting deposit tracking..."));
  } catch (error) {
    console.error("Failed to load chalk:", error);
    return;
  }

  // Use once method instead of on to handle events
  provider.once("block", async (blockNumber) => {
    console.log(chalk.cyan(`New block received: ${blockNumber}`));

    try {
      const block = await provider.getBlock(blockNumber);
      if (block && block.transactions.length > 0) {
        console.log(
          chalk.green(
            `Block ${blockNumber} has ${block.transactions.length} transactions.`
          )
        );
        // Flag to track if any outgoing transactions from exchange wallets are found
        let foundTransactions = false;
        for (const txHash of block.transactions) {
          try {
            const tx = await provider.getTransaction(txHash);
            // Ensure tx and tx.from exist and tx.from is not null before processing
            if (
              tx &&
              tx.from &&
              exchangeWallets.includes(tx.from.toLowerCase())
            ) {
              const shortFrom = shortenAddress(tx.from);
              const shortTo = shortenAddress(tx.to);
              console.log(
                chalk.blue(
                  `Outgoing transaction from exchange wallet ${shortFrom} (${getTagForAddress(
                    tx.from
                  )}) to ${shortTo}:`
                )
              );

              if (tx.value !== undefined) {
                const amountInWei = parseInt(tx.value);
                if (amountInWei > 0) {
                  const amountInEth = weiToEth(amountInWei);
                  console.log(chalk.white(`Amount: ${amountInEth} ETH`));
                  console.log(chalk.gray(`Transaction Hash: ${tx.hash}`));
                  console.log(chalk.yellow("---"));
                  foundTransactions = true;
                }
              } else {
                console.log(chalk.white(`Amount: 0 wei`));
                console.log(chalk.gray(`Transaction Hash: ${tx.hash}`));
                console.log(chalk.yellow("---"));
                foundTransactions = true;
              }
            }
          } catch (error) {
            console.error(
              chalk.red(`Error processing transaction ${txHash}:`),
              error.message
            );
          }
        }

        if (!foundTransactions) {
          console.log(
            chalk.yellow(
              "No outgoing transactions found from exchange wallets in this block."
            )
          );
        }
      } else {
        console.log(chalk.green(`Block ${blockNumber} has no transactions.`));
      }
    } catch (error) {
      console.error(
        chalk.red(`Error processing block ${blockNumber}:`),
        error.message
      );
    }

    // Restart tracking by calling startTracking recursively with proper error handling
    startTracking().catch((error) => {
      console.error(chalk.red("Error in deposit tracking:"), error);
    });
  });

  // Handle provider errors
  provider.on("error", (error) => {
    console.error(chalk.red("Provider error:"), error);
  });

  // Handle script termination
  process.on("SIGINT", () => {
    console.log(chalk.yellow("SIGINT received. Stopping deposit tracking."));
    process.exit(0);
  });
}

// Call startTracking function after chalk is loaded
startTracking().catch((error) => {
  console.error("Failed to start tracking:", error);
});
