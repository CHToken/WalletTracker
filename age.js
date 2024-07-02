const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const contractAddress = "0x4e0a23e7230529f8ed372168d17409cb9af8ea70";
const etherscanApiKey = process.env.ETHERSCAN_API_KEY;

async function getContractCreationDate() {
    try {
        console.log("Starting the process to get contract creation date...");

        // Fetch transaction list for the contract address
        const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${contractAddress}&startblock=0&endblock=99999999&sort=asc&apikey=${etherscanApiKey}`;
        console.log(`Fetching transactions for contract address: ${contractAddress}`);
        const response = await axios.get(url);

        if (response.data.status === "1") {
            console.log("Transaction list fetched successfully.");
            const transactions = response.data.result;
            const creationTx = transactions[0]; // The first transaction is the contract creation

            const creationBlock = creationTx.blockNumber;
            console.log(`The contract was created in block number: ${creationBlock}`);

            // Fetch block details to get the timestamp
            const blockUrl = `https://api.etherscan.io/api?module=block&action=getblockreward&blockno=${creationBlock}&apikey=${etherscanApiKey}`;
            console.log(`Fetching details for block number: ${creationBlock}`);
            const blockResponse = await axios.get(blockUrl);

            if (blockResponse.data.status === "1") {
                console.log("Block details fetched successfully.");
                const blockTimestamp = blockResponse.data.result.timeStamp;
                const creationDate = new Date(blockTimestamp * 1000);
                const options = {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: 'numeric',
                    second: 'numeric',
                    hour12: true,
                    timeZone: 'UTC',
                    timeZoneName: 'short'
                };
                console.log(`The contract was created on: ${creationDate.toLocaleString('en-US', options)}`);
            } else {
                console.error("Failed to fetch block details.");
                console.error(blockResponse.data);
            }
        } else {
            console.error("Failed to fetch transaction details.");
            console.error(response.data);
        }
    } catch (error) {
        console.error("An error occurred while fetching the contract creation date:");
        console.error(error.message);
    }
}

getContractCreationDate();
