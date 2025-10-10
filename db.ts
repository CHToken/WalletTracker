// // src/db.ts
// import { MongoClient, Db, Collection } from "mongodb";
// import dotenv from "dotenv";
// dotenv.config();

// const MONGO_URL = process.env.MONGODB_URL ?? "";
// const DB_NAME = "blockchain";
// const COLLECTION_NAME = "TokenList";

// let client: MongoClient | null = null;
// let db: Db | null = null;
// let collection: Collection | null = null;

// export async function connectMongo(): Promise<{ db: Db; collection: Collection }> {
//   if (!MONGO_URL) throw new Error("MONGODB_URL not set");

//   if (!client) {
//     client = new MongoClient(MONGO_URL);
//     await client.connect();
//     db = client.db(DB_NAME);
//     const exists = await db.listCollections({ name: COLLECTION_NAME }).toArray();
//     if (exists.length === 0) {
//       await db.createCollection(COLLECTION_NAME);
//     }
//     collection = db.collection(COLLECTION_NAME);
//     console.log("✅ Connected to MongoDB");
//   }

//   return { db: db!, collection: collection! };
// }

// export async function getDb(): Promise<Db> {
//   if (!db) {
//     const { db: newDb } = await connectMongo();
//     return newDb;
//   }
//   return db;
// }

// export async function closeMongo(): Promise<void> {
//   await client?.close();
//   console.log("🛑 MongoDB connection closed");
// }
