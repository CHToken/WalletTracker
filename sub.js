// findDuplicates.js
require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGODB_URL = process.env.MONGODB_URL;

async function findDuplicateDepositAddresses() {
  const client = new MongoClient(MONGODB_URL);
  try {
    await client.connect();
    const database = client.db("blockchain");
    const collection = database.collection("DepositAddresses");

    // Count total addresses
    const totalAddresses = await collection.countDocuments();
    console.log(`Total Deposit Addresses found: ${totalAddresses}`);

    // Aggregation pipeline to find duplicates
    const pipeline = [
      {
        $group: {
          _id: "$address",
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
    ];

    const duplicates = await collection.aggregate(pipeline).toArray();

    if (duplicates.length > 0) {
      console.log("Duplicate Deposit Addresses found:");
      duplicates.forEach((doc) => {
        console.log(`Address: ${doc._id}, Count: ${doc.count}`);
      });
    } else {
      console.log("No duplicate Deposit Addresses found.");
    }
  } catch (error) {
    console.error("Error finding duplicate Deposit Addresses:", error.message);
  } finally {
    await client.close();
  }
}

findDuplicateDepositAddresses();
