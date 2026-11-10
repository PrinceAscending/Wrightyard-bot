import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Collection, Filter, IndexDescriptionInfo } from "mongodb";
import type { BotDatabase } from "../db.js";
import { serializeError, type Logger } from "../logger.js";
import type { AuditEvent, AuditQuery } from "./types.js";

export interface AuditStoreOptions {
  readonly database: BotDatabase | null;
  readonly jsonPath: string;
  readonly logger: Logger;
  readonly retentionDays: number;
}

type AuditDocument = Record<string, unknown>;

const COLLECTION = "audit_events";
const TTL_INDEX = "audit_ttl";

function reviveEvent(document: AuditDocument): AuditEvent {
  const createdAt =
    document.createdAt instanceof Date
      ? document.createdAt
      : new Date(String(document.createdAt));
  return { ...(document as unknown as AuditEvent), createdAt };
}

/**
 * Durable audit archive. Mongo is preferred, but a bad connection must never
 * take the bot down; the store falls back to a local NDJSON file and keeps the
 * evidence flowing.
 */
export class AuditStore {
  private readonly database: BotDatabase | null;
  private readonly jsonPath: string;
  private readonly logger: Logger;
  private readonly retentionDays: number;
  private collection: Collection<AuditDocument> | null = null;
  private indexesReady = false;
  private jsonMode = false;
  private warnedMongo = false;
  private warnedJson = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: AuditStoreOptions) {
    this.database = options.database;
    this.jsonPath = options.jsonPath;
    this.logger = options.logger;
    this.retentionDays = options.retentionDays;
  }

  public get durable(): boolean {
    return Boolean(this.database) && !this.jsonMode;
  }

  public append(event: AuditEvent): Promise<void> {
    const run = this.queue.then(() => this.write(event));
    this.queue = run.catch(() => undefined);
    return run;
  }

  public async query(query: AuditQuery): Promise<AuditEvent[]> {
    await this.queue;
    if (!this.jsonMode && this.database) {
      try {
        return await this.queryMongo(query);
      } catch (error) {
        this.failMongo(error);
      }
    }
    return this.queryJson(query);
  }

  public async close(): Promise<void> {
    await this.queue;
  }

  private async write(event: AuditEvent): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        await collection.insertOne({ ...event });
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }
    await this.writeJson(event);
  }

  private async mongoCollection(): Promise<Collection<AuditDocument>> {
    if (this.collection && this.indexesReady) {
      return this.collection;
    }
    const collection = await this.database!.collection<AuditDocument>(COLLECTION);
    if (!this.indexesReady) {
      await this.ensureIndexes(collection);
      this.indexesReady = true;
    }
    this.collection = collection;
    return collection;
  }

  private async ensureIndexes(collection: Collection<AuditDocument>): Promise<void> {
    await collection.createIndex({ guildId: 1, createdAt: -1 });
    await collection.createIndex({ guildId: 1, category: 1, createdAt: -1 });

    let ttl: IndexDescriptionInfo | undefined;
    try {
      const indexes = await collection.indexes();
      ttl = indexes.find(
        (index) =>
          index.name === TTL_INDEX ||
          (index.key.createdAt === 1 && index.expireAfterSeconds !== undefined),
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 26) {
        throw error;
      }
    }

    if (this.retentionDays > 0) {
      const expireAfterSeconds = this.retentionDays * 86_400;
      if (ttl && ttl.expireAfterSeconds !== expireAfterSeconds) {
        await collection.dropIndex(ttl.name ?? TTL_INDEX);
        ttl = undefined;
      }
      if (!ttl) {
        await collection.createIndex(
          { createdAt: 1 },
          { name: TTL_INDEX, expireAfterSeconds },
        );
      }
    } else if (ttl) {
      await collection.dropIndex(ttl.name ?? TTL_INDEX);
    }
  }

  private async queryMongo(query: AuditQuery): Promise<AuditEvent[]> {
    const collection = await this.mongoCollection();
    const filter: Filter<AuditDocument> = { guildId: query.guildId };
    if (query.category) {
      filter.category = query.category;
    }
    if (query.since) {
      filter.createdAt = { $gte: query.since };
    }
    const documents = await collection
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(query.limit ?? 100)
      .toArray();
    return documents.map(reviveEvent);
  }

  private async writeJson(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.jsonPath), { recursive: true });
    await appendFile(this.jsonPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async queryJson(query: AuditQuery): Promise<AuditEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.jsonPath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const events: AuditEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as AuditEvent;
        events.push({
          ...parsed,
          createdAt: new Date(String(parsed.createdAt)),
        });
      } catch (error) {
        if (!this.warnedJson) {
          this.warnedJson = true;
          this.logger.warn("Skipping a malformed audit log line", serializeError(error));
        }
      }
    }

    return events
      .filter((event) => event.guildId === query.guildId)
      .filter((event) => !query.category || event.category === query.category)
      .filter((event) => !query.since || event.createdAt.getTime() >= query.since.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, query.limit ?? 100);
  }

  private failMongo(error: unknown): void {
    this.jsonMode = true;
    if (!this.warnedMongo) {
      this.warnedMongo = true;
      this.logger.warn(
        "Audit Mongo store unavailable; falling back to NDJSON",
        serializeError(error),
      );
    }
  }
}
