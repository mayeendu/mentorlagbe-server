import { MongoClient } from "mongodb";
import { paymentDatabase } from "./payment-mode.js";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing");
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });

export async function connectDB() {
  const database = paymentDatabase();
  await client.connect();

  // Verify the database is reachable
  await client.db("admin").command({ ping: 1 });

  console.log("MongoDB connected successfully");
  return client.db(database);
}
