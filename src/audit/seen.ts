import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Collection } from "mongodb";
import type { BotDatabase } from "../db.js";
import { serializeError, type Logger } from "../logger.js";

export interface AuditSeenStoreOptions {
  readonly database: BotDatabase | null;
  readonly jsonPath: string;
  readonly logger: Logger;
  readonly maxEntries?: number;
}

interface SeenDocument extends Record<string, unknown> {
  _id: string;
  seenAt: Date;
}

interface JsonSeenEntry {
  readonly id: string;
  readonly seenAt: string;
}

interface JsonSeenDocument {
  readonly entries: readonly JsonSeenEntry[];
}

const COLLECTION = "audit_seen";
const DEFAULT_MAX_ENTRIES = 5_000;
const TTL_SECONDS = 3_600;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number }).code === 11_000;
}

/**
 * Dedupe ledger for native audit-log entries. Mongo uses a TTL index and a
 * hard count cap; JSON keeps the same insertion order in one file.
 */
export class AuditSeenStore {
  private readonly database: BotDatabase | null;
  private readonly jsonPath: string;
  private readonly logger: Logger;
  private readonly maxEntries: number;
  private readonly cache = new Set<string>();
  private collection: Collection<SeenDocument> | null = null;
  private jsonMode = false;
  private indexed = false;
  private warnedMongo = false;
  private warnedJson = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: AuditSeenStoreOptions) {
    this.database = options.database;
    this.jsonPath = options.jsonPath;
    this.logger = options.logger;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  public async has(entryId: string): Promise<boolean> {
    if (this.cache.has(entryId)) {
      return true;
    }
    await this.queue;

    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        const document = await collection.findOne({ _id: entryId });
        if (document) {
          this.remember(entryId);
          return true;
        }
        return false;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const found = all.entries.some((entry) => entry.id === entryId);
    if (found) {
      this.remember(entryId);
    }
    return found;
  }

  public add(entryId: string): Promise<void> {
    if (this.cache.has(entryId)) {
      return Promise.resolve();
    }
    this.remember(entryId);
    this.trimCache();
    return this.enqueue(() => this.addNow(entryId));
  }

  public prune(): Promise<void> {
    return this.enqueue(async () => {
      await this.pruneNow();
      this.trimCache();
    });
  }

  public async close(): Promise<void> {
    await this.queue;
  }

  private async addNow(entryId: string): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        try {
          await collection.insertOne({ _id: entryId, seenAt: new Date() });
        } catch (error) {
          if (!isDuplicateKey(error)) {
            throw error;
          }
        }
        await this.pruneMongo(collection);
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    if (all.entries.some((entry) => entry.id === entryId)) {
      return;
    }
    const entries = [
      ...all.entries,
      { id: entryId, seenAt: new Date().toISOString() },
    ].slice(-this.maxEntries);
    await this.writeJson({ entries });
  }

  private async pruneNow(): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        await this.pruneMongo(collection);
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    if (all.entries.length > this.maxEntries) {
      await this.writeJson({ entries: all.entries.slice(-this.maxEntries) });
    }
  }

  private async pruneMongo(collection: Collection<SeenDocument>): Promise<void> {
    const count = await collection.countDocuments();
    if (count <= this.maxEntries) {
      return;
    }
    const oldest = await collection
      .find({}, { projection: { _id: 1 } })
      .sort({ seenAt: 1 })
      .limit(count - this.maxEntries)
      .toArray();
    if (oldest.length === 0) {
      return;
    }
    await collection.deleteMany({ _id: { $in: oldest.map((entry) => entry._id) } });
  }

  private async mongoCollection(): Promise<Collection<SeenDocument>> {
    if (this.collection) {
      await this.ensureIndex(this.collection);
      return this.collection;
    }
    const collection = await this.database!.collection<SeenDocument>(COLLECTION);
    this.collection = collection;
    await this.ensureIndex(collection);
    return collection;
  }

  private async ensureIndex(collection: Collection<SeenDocument>): Promise<void> {
    if (this.indexed) {
      return;
    }
    this.indexed = true;
    try {
      await collection.createIndex({ seenAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    } catch (error) {
      this.logger.warn("Could not create the audit seen TTL index", serializeError(error));
    }
  }

  private async readJson(): Promise<JsonSeenDocument> {
    try {
      const raw = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<JsonSeenDocument>;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(
            (entry): entry is JsonSeenEntry =>
              typeof entry === "object" &&
              entry !== null &&
              typeof entry.id === "string" &&
              typeof entry.seenAt === "string",
          )
        : [];
      return { entries };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { entries: [] };
      }
      this.warnJson("Could not read the audit seen file; starting a new one", error);
      return { entries: [] };
    }
  }

  private async writeJson(all: JsonSeenDocument): Promise<void> {
    await mkdir(dirname(this.jsonPath), { recursive: true });
    const temp = `${this.jsonPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(temp, this.jsonPath);
  }

  private remember(entryId: string): void {
    this.cache.add(entryId);
  }

  private trimCache(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.values().next().value;
      if (typeof oldest !== "string") {
        return;
      }
      this.cache.delete(oldest);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private failMongo(error: unknown): void {
    this.jsonMode = true;
    if (!this.warnedMongo) {
      this.warnedMongo = true;
      this.logger.warn(
        "Audit seen Mongo store unavailable; falling back to JSON",
        serializeError(error),
      );
    }
  }

  private warnJson(message: string, error: unknown): void {
    if (this.warnedJson) {
      return;
    }
    this.warnedJson = true;
    this.logger.warn(message, serializeError(error));
  }
}
