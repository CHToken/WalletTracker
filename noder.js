const { ethers } = require("ethers");

async function getTransactionDetails(rpcUrl, txHash) {
  const provider = new ethers.getDefaultProvider(rpcUrl);

  try {
    // Get the transaction details using the transaction hash
    const tx = await provider.getTransaction(txHash);

    if (tx) {
      const fromAddress = tx.from;
      const toAddress = tx.to;
      const valueInWei = tx.value;
      const valueInEth = ethers.formatUnits(valueInWei, 18); // Convert wei to ether

      console.log("📋 Transaction Details 📋");
      console.log(`🔹 From: ${fromAddress}`);
      console.log(`🔹 To: ${toAddress}`);
      console.log(`🔹 Value: ${valueInEth} ETH`);
      console.log(`🔹 Transaction Hash: ${tx.hash}`);
      console.log("");

      // Determine if the transaction is a buy or sell
      if (valueInEth > 0) {
        console.log("💰 Transaction Type: Buy");
      } else {
        console.log("🔻 Transaction Type: Sell");
      }

      // Check if the transaction is a Uniswap V3 Universal Router transaction
      const uniswapRouterAddress = "0x1111111254EEB25477B68fb85Ed929f73A960582";
      if (toAddress.toLowerCase() === uniswapRouterAddress.toLowerCase()) {
        console.log("🚀 This is a Uniswap V3 Buy Universal Router transaction");
      }
    } else {
      console.log("⚠️ Transaction not found");
    }
  } catch (error) {
    console.error("❌ Error getting transaction details:", error);
  }
}

// Define the RPC URL and transaction hash
const rpcUrl = "https://api.noderpc.xyz/rpc-mainnet/_81D1cgmTj-fTXwt4Dp-kEo42GQE_sKPW9fyGlckviA";
const txHash = "0xe62175973430ccd51e0c47db819e33e906426458b3183cd197969d6a5a72e1b3";

// Get the transaction details
getTransactionDetails(rpcUrl, txHash);
