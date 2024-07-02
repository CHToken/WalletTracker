const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
const moment = require("moment");

dotenv.config();

const mongoUri = process.env.MONGODB_URL;
const client = new MongoClient(mongoUri);

async function removeOldAddresses() {
  try {
    await client.connect();
    const database = client.db("blockchain");
    const collection = database.collection("DepositAddresses");

    const cutoffTime = moment().subtract(12, 'hours').toDate();

    const query = { timestamp: { $lt: cutoffTime } };
    
    const result = await collection.deleteMany(query);

    console.log(`Deleted ${result.deletedCount} addresses older than 12 hours.`);
  } catch (error) {
    console.error("Error removing old addresses:", error);
  } finally {
    await client.close();
  }
}

removeOldAddresses();
