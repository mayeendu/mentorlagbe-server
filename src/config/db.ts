import { MongoClient } from "mongodb";
import type { readEnvironment } from "./environment.js";
import { paymentDatabase } from "./payment-mode.js";

type DatabaseConfig = Pick<ReturnType<typeof readEnvironment>, "mongoUri" | "production">;

export function createMongoClient(config: DatabaseConfig) {
  return new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    maxPoolSize: 25,
    ...(config.production ? { tls: true } : {}),
  });
}

export async function connectDB(config: DatabaseConfig) {
  const client = createMongoClient(config);
  try {
    await client.connect();
    const db = client.db(paymentDatabase());
    await db.command({ ping: 1 }, { timeoutMS: 2_000 });
    if (config.production) {
      const topology = await db.command({ hello: 1 }, { timeoutMS: 2_000 });
      if (!topology.setName && topology.msg !== "isdbgrid") {
        throw new Error("Production MongoDB must support transactions.");
      }
    }
    return db;
  } catch (error) {
    await client.close();
    throw error;
  }
}
