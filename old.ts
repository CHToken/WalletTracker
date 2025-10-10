// src/old.ts
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import moment from "moment";

dotenv.config();

const mongoUri = process.env.MONGODB_URL as string;
const client = new MongoClient(mongoUri);

interface DepositAddress {
  timestamp: Date;
  [key: string]: any;
}

export async function removeOldAddresses(): Promise<DepositAddress[] | void> {
  try {
    await client.connect();
    const database = client.db("blockchain");
    const collection = database.collection<DepositAddress>("DepositAddresses");

    const cutoffTime = moment().subtract(12, "hours").toDate();
    const query = { timestamp: { $lt: cutoffTime } };

    const oldAddresses = await collection.find(query).toArray();

    console.log("Number of addresses older than 12 hours:", oldAddresses.length);

    if (oldAddresses.length > 0) {
      const result = await collection.deleteMany(query);
      console.log(`Deleted ${result.deletedCount} addresses older than 12 hours.`);
    }

    return oldAddresses;
  } catch (error) {
    console.error("Error retrieving and deleting old addresses:", error);
  } finally {
    await client.close();
  }
}

removeOldAddresses();
