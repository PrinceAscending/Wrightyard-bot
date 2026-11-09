import { MongoClient, type Collection, type Document } from "mongodb";
import type { Logger } from "./logger.js";

const CONNECT_TIMEOUT_MS = 5_000;

export interface BotDatabaseOptions {
  readonly uri: string | null;
  readonly dbName: string;
  readonly logger: Logger;
}

/**
 * Shared lazy MongoDB connection for every durable store. Stores built on it
 * own their collections and fall back to JSON when Mongo is unconfigured or
 * unreachable; this wrapper only owns the client lifecycle.
 */
export class BotDatabase {
  private readonly uri: string | null;
  private readonly dbName: string;
  private readonly logger: Logger;
  private client: MongoClient | null = null;
  private clientPromise: Promise<MongoClient> | null = null;

  public constructor(options: BotDatabaseOptions) {
    this.uri = options.uri;
    this.dbName = options.dbName;
    this.logger = options.logger;
  }

  public get configured(): boolean {
    return Boolean(this.uri);
  }

  public async collection<T extends Document>(name: string): Promise<Collection<T>> {
    if (!this.uri) {
      throw new Error("MongoDB is not configured");
    }

    const client = await this.connect();
    return client.db(this.dbName).collection<T>(name);
  }

  public async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientPromise = null;
    if (client) {
      await client.close().catch((error: unknown) => {
        this.logger.warn("MongoDB client close failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private connect(): Promise<MongoClient> {
    this.clientPromise ??= this.open();
    return this.clientPromise;
  }

  private async open(): Promise<MongoClient> {
    const client = new MongoClient(this.uri!, {
      appName: "WrightyardBot",
      maxPoolSize: 10,
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    this.client = client;

    try {
      await client.connect();
      return client;
    } catch (error) {
      this.client = null;
      this.clientPromise = null;
      throw error;
    }
  }
}
