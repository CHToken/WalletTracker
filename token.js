const { ethers } = require("ethers");
require('dotenv').config();

async function getTokenInfo() {
    const infuraUrl = process.env.INFURA_URL;
    const tokenAddress = process.env.TOKEN_ADDRESS;

    // Create an Ethereum provider
    const provider = new ethers.getDefaultProvider(infuraUrl);

    try {
        // Get instance of the token contract
        const tokenContract = new ethers.Contract(tokenAddress, [
            "function name() view returns (string)",
            "function symbol() view returns (string)",
            "function decimals() view returns (uint8)",
        ], provider);

        // Fetch token details
        const name = await tokenContract.name();
        const symbol = await tokenContract.symbol();
        const decimals = await tokenContract.decimals();

        console.log("Token Name:", name);
        console.log("Token Symbol:", symbol);
        console.log("Decimals:", decimals);
    } catch (error) {
        console.error("Error retrieving token information:", error);
    }
}

// Call the function to retrieve token information
getTokenInfo();
