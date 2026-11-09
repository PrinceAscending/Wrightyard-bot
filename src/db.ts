import { MongoClient, type Collection, type Document } from "mongodb";
import type { Logger } from "./logger.js";

const CONNECT_TIMEOUT_MS = 5_000;

function createClient(uri: string): MongoClient {
  return new MongoClient(uri, {
    appName: "WrightyardBot",
    maxPoolSize: 10,
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
}

export interface BotDatabaseOptions {
  readonly uri: string | null;
  readonly dbName: string;
  readonly logger: Logger;
  /** Internal test seam for substituting a fake client; not for production use. */
  readonly clientFactory?: (uri: string) => MongoClient;
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
  private readonly clientFactory: (uri: string) => MongoClient;
  private client: MongoClient | null = null;
  private clientPromise: Promise<MongoClient> | null = null;
  private generation = 0;

  public constructor(options: BotDatabaseOptions) {
    this.uri = options.uri;
    this.dbName = options.dbName;
    this.logger = options.logger;
    this.clientFactory = options.clientFactory ?? createClient;
  }

  public get configured(): boolean {
    return Boolean(this.uri);
  }

  public async collection<T extends Document>(name: string): Promise<Collection<T>> {
    if (!this.uri) {
      throw new Error("MongoDB is not configured");
    }

    const client = await this.connect();
    if (this.client !== client) {
      throw new Error("MongoDB connection closed before use");
    }
    return client.db(this.dbName).collection<T>(name);
  }

  public async close(): Promise<void> {
    this.generation += 1;
    const client = this.client;
    this.client = null;
    this.clientPromise = null;
    if (client) {
      await this.closeClient(client);
    }
  }

  private connect(): Promise<MongoClient> {
    this.clientPromise ??= this.open();
    return this.clientPromise;
  }

  /**
   * Opens a client tagged with the current generation. `close()` bumps the
   * generation, so a connect that settles after a close can neither hand back
   * a torn-down client nor clear state belonging to a newer connection.
   */
  private open(): Promise<MongoClient> {
    const generation = ++this.generation;
    const client = this.clientFactory(this.uri!);
    this.client = client;

    const promise = client.connect().then(
      async () => {
        if (this.generation !== generation) {
          await this.closeClient(client);
          throw new Error("MongoDB connection closed during connect");
        }
        return client;
      },
      (error: unknown) => {
        if (this.generation === generation) {
          this.client = null;
          this.clientPromise = null;
        }
        throw error;
      },
    );

    this.clientPromise = promise;
    return promise;
  }

  private async closeClient(client: MongoClient): Promise<void> {
    await client.close().catch((error: unknown) => {
      this.logger.warn("MongoDB client close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
